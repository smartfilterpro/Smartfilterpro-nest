'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * Counts runtime any time air is moving: HEATING, COOLING, HEATCOOL, or FAN-only.
 */

const BASE_FAN_TAIL_MS = 30_000;       // grace tail after explicit HVAC off if fan keeps spinning
const RECENT_WINDOW_MS = 120_000;      // memory window to avoid collapsing to OFF immediately
const COOL_DELTA_ON = 0.3;             // °C above cool setpoint to infer active cooling
const HEAT_DELTA_ON = 0.3;             // °C below heat setpoint to infer active heating
const TREND_DELTA = 0.05;              // °C change indicating heating/cooling trend

/* -------------------------- SDM Push Parsing ---------------------------- */

function parseSdmPushMessage(body) {
  // Accept either direct SDM event JSON (for local testing) or Pub/Sub format
  try {
    // Pub/Sub push
    if (body && body.message && body.message.data) {
      const json = Buffer.from(body.message.data, 'base64').toString('utf8');
      const parsed = JSON.parse(json);

      const events = [];
      const ru = parsed?.resourceUpdate;
      if (ru && ru.name) {
        events.push({
          deviceName: ru.name,
          traits: ru?.traits || {},
          // top-level timestamp may be present
          timestamp: parsed?.eventTime || new Date().toISOString(),
        });
      }
      return {
        events,
        userId: null,
        projectId: parsed?.userId || null,     // SDM field name is confusing; keep for reference
        structureId: null,
      };
    }

    // Direct SDM JSON (already decoded)
    if (body && body.resourceUpdate) {
      return parseSdmPushMessage({ message: { data: Buffer.from(JSON.stringify(body)).toString('base64') } });
    }

    // Already-normalized array form (power user testing)
    if (Array.isArray(body?.events)) {
      return { events: body.events, userId: body.userId || null, projectId: null, structureId: null };
    }
  } catch (e) {
    console.warn('[WARN] parseSdmPushMessage failed:', e.message);
  }
  return null;
}

/* ------------------------ Trait Extraction Layer ------------------------ */

function extractEffectiveTraits(evt) {
  const deviceName = evt.deviceName || ''; // e.g., enterprises/…/devices/DEVICE_ID
  const deviceId = deviceName.split('/devices/')[1] || deviceName;

  const t = evt.traits || {};

  const thermostatMode = pick(
    t['sdm.devices.traits.ThermostatMode']?.mode,
    // sometimes users map this earlier; keep fallback
    t['ThermostatMode']?.mode
  ); // OFF/HEAT/COOL/HEATCOOL

  const hvacStatusRaw = pick(
    t['sdm.devices.traits.ThermostatHvac']?.status,
    t['ThermostatHvac']?.status
  ); // OFF/HEATING/COOLING (optional in each event)

  const hasFanTrait = Boolean(t['sdm.devices.traits.Fan'] || t['Fan']);
  const fanTimerMode = pick(
    t['sdm.devices.traits.Fan']?.timerMode,
    t['Fan']?.timerMode
  ); // ON/OFF (optional)
  const fanTimerOn = pick(
    t['sdm.devices.traits.Fan']?.timerMode === 'ON',
    t['Fan']?.timerMode === 'ON'
  );

  const currentTempC = pick(
    t['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius,
    t['Temperature']?.ambientTemperatureCelsius
  );

  const coolSetpointC = pick(
    t['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius,
    t['ThermostatTemperatureSetpoint']?.coolCelsius
  );

  const heatSetpointC = pick(
    t['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius,
    t['ThermostatTemperatureSetpoint']?.heatCelsius
  );

  const connectivity = pick(
    t['sdm.devices.traits.Connectivity']?.status,
    t['Connectivity']?.status
  ); // ONLINE/OFFLINE/UNKNOWN

  const roomDisplayName = pick(
    t['sdm.devices.traits.Room']?.name,
    t['Room']?.name
  );

  const timestamp = evt.timestamp || new Date().toISOString();

  return {
    deviceId,
    deviceName,
    thermostatMode,
    hvacStatusRaw,
    hasFanTrait,
    fanTimerMode,
    fanTimerOn,
    currentTempC: isNum(currentTempC) ? round2(currentTempC) : null,
    coolSetpointC: isNum(coolSetpointC) ? round2(coolSetpointC) : null,
    heatSetpointC: isNum(heatSetpointC) ? round2(heatSetpointC) : null,
    connectivity,
    roomDisplayName,
    timestamp,
  };
}

/* --------------------------- Session Manager ---------------------------- */

class SessionManager {
  constructor() {
    this.byDevice = new Map();
  }

  getPrev(deviceId) {
    if (!this.byDevice.has(deviceId)) {
      this.byDevice.set(deviceId, {
        isRunning: false,
        startedAt: null,
        startStatus: 'off',       // 'cool' | 'heat' | 'fan' | 'off'
        lastTempC: null,
        lastAt: null,
        lastEquipmentStatus: 'off',
        lastMode: 'OFF',
        lastReachable: true,
        lastRoom: '',
      });
    }
    return this.byDevice.get(deviceId);
  }

  /**
   * Decide if air is moving (active) and whether it's heat/cool/fan-only
   * using explicit hvacStatus when available; otherwise inference.
   */
  computeActiveAndStatus(input, prev) {
    const now = new Date(input.when).getTime();

    // Reachability
    const isReachable = input.connectivity !== 'OFFLINE';

    // Fan running?
    const isFanRunning = !!(input.hasFanTrait && (input.fanTimerMode === 'ON' || input.fanTimerOn === true));

    // Explicit HVAC status wins
    let hvacStatus = input.hvacStatusRaw || 'UNKNOWN'; // HEATING/COOLING/OFF/UNKNOWN
    let isHeating = hvacStatus === 'HEATING';
    let isCooling = hvacStatus === 'COOLING';

    // If hvacStatus missing or unknown, infer from mode + setpoints + temperature trend
    if (hvacStatus === 'UNKNOWN' || hvacStatus === undefined || hvacStatus === null) {
      const inferred = inferHvacFromTemps(
        input.thermostatMode,
        input.currentTempC,
        input.coolSetpointC,
        input.heatSetpointC,
        prev.lastTempC
      );
      if (inferred === 'HEATING' || inferred === 'COOLING') {
        hvacStatus = inferred;
        isHeating = inferred === 'HEATING';
        isCooling = inferred === 'COOLING';
      } else {
        hvacStatus = 'OFF';
      }
    }

    // Air moving if heating or cooling or fan running
    const isActive = Boolean(isHeating || isCooling || isFanRunning);

    // Determine overall “equipmentStatus” string and fanOnly flag
    let equipmentStatus = 'off';
    let isFanOnly = false;
    if (isHeating) equipmentStatus = 'heat';
    if (isCooling) equipmentStatus = 'cool';
    if (!isHeating && !isCooling && isFanRunning) {
      equipmentStatus = 'fan';
      isFanOnly = true;
    }

    // Memory window to avoid instant collapse to OFF when traits are missing
    if (!isActive && prev.isRunning && prev.lastAt && now - prev.lastAt < RECENT_WINDOW_MS) {
      // keep previous status briefly
      return {
        isReachable,
        isHvacActive: true,
        equipmentStatus: prev.lastEquipmentStatus,
        isFanOnly: prev.lastEquipmentStatus === 'fan',
      };
    }

    return {
      isReachable,
      isHvacActive: isActive,
      equipmentStatus,
      isFanOnly,
    };
  }

  process(input) {
    const prev = this.getPrev(input.deviceId);
    const now = new Date(input.when).getTime();

    const {
      isReachable,
      isHvacActive,
      equipmentStatus,
      isFanOnly,
    } = this.computeActiveAndStatus(input, prev);

    const becameActive = !prev.isRunning && isHvacActive;
    const becameIdle = prev.isRunning && !isHvacActive;

    // Start session
    if (becameActive) {
      prev.isRunning = true;
      prev.startedAt = now;
      prev.startStatus = equipmentStatus; // 'heat'|'cool'|'fan'
    }

    // End session
    let runtimeSeconds = null;
    let isRuntimeEvent = false;
    if (becameIdle && prev.startedAt) {
      let endAt = now;

      // If we just flipped to idle but a fan tail is warranted (HVAC turned off),
      // we still end the session now because air stopped (no fanTimer); if you want
      // to extend tail while fan keeps running, it will be represented as 'fan' status.
      const ms = Math.max(0, endAt - prev.startedAt);
      runtimeSeconds = Math.round(ms / 1000);
      isRuntimeEvent = true;

      // Reset session
      prev.isRunning = false;
      prev.startedAt = null;
      prev.startStatus = 'off';
    }

    // Persist “last” snapshot
    prev.lastTempC = isNum(input.currentTempC) ? input.currentTempC : prev.lastTempC;
    prev.lastAt = now;
    prev.lastEquipmentStatus = equipmentStatus || prev.lastEquipmentStatus;
    prev.lastMode = input.thermostatMode || prev.lastMode;
    prev.lastReachable = isReachable;
    prev.lastRoom = input.roomDisplayName || prev.lastRoom;

    // Return a normalized object the server can post to Bubble
    return {
      userId: input.userId || null,
      thermostatId: input.deviceId,
      deviceName: input.deviceName,
      roomDisplayName: input.roomDisplayName || '',
      timestampISO: new Date(now).toISOString(),
      thermostatMode: input.thermostatMode || 'OFF',                 // OFF/HEAT/COOL/HEATCOOL
      hvacMode: hvacModeFromEquipment(equipmentStatus),              // OFF/HEATING/COOLING/FAN
      equipmentStatus,                                               // 'off' | 'heat' | 'cool' | 'fan'
      isHvacActive,
      isFanOnly,
      isReachable,
      currentTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
      coolSetpointC: isNum(input.coolSetpointC) ? round2(input.coolSetpointC) : null,
      heatSetpointC: isNum(input.heatSetpointC) ? round2(input.heatSetpointC) : null,
      // Runtime info
      runtimeSeconds, // null while running; filled on session end
      isRuntimeEvent,
      // For convenience
      startTempC: prev.isRunning && prev.startedAt ? prev.lastTempC : null,
      endTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
    };
  }

  toBubblePayload(result) {
    // Convert °C to °F where needed
    const c2f = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
    const payload = {
      userId: result.userId,
      thermostatId: result.thermostatId,
      deviceName: result.deviceName || '',
      roomDisplayName: result.roomDisplayName || '',
      // runtime
      runtimeSeconds: result.runtimeSeconds ?? 0,
      runtimeMinutes: result.runtimeSeconds != null ? Math.round(result.runtimeSeconds / 60) : 0,
      isRuntimeEvent: Boolean(result.isRuntimeEvent),
      // modes/status
      hvacMode: mapHvacModeForBubble(result.hvacMode), // 'HEATING'|'COOLING'|'FAN'|'OFF'
      isHvacActive: Boolean(result.isHvacActive),
      thermostatMode: result.thermostatMode,
      isReachable: Boolean(result.isReachable),
      // temps
      currentTempF: c2f(result.currentTempC),
      coolSetpointF: c2f(result.coolSetpointC),
      heatSetpointF: c2f(result.heatSetpointC),
      startTempF: c2f(result.startTempC) || 0,
      endTempF: c2f(result.endTempC),
      currentTempC: result.currentTempC,
      coolSetpointC: result.coolSetpointC,
      heatSetpointC: result.heatSetpointC,
      startTempC: result.startTempC || 0,
      endTempC: result.endTempC,
      // last flags (for parity with your logs)
      lastIsCooling: result.equipmentStatus === 'cool',
      lastIsHeating: result.equipmentStatus === 'heat',
      lastIsFanOnly: result.equipmentStatus === 'fan',
      lastEquipmentStatus: result.equipmentStatus,
      equipmentStatus: result.equipmentStatus,
      isFanOnly: result.isFanOnly,
      // timestamps
      timestamp: result.timestampISO,
      eventId: genUuid(),
      eventTimestamp: Date.parse(result.timestampISO),
    };
    return payload;
  }
}

/* --------------------------- Inference Logic ---------------------------- */

function inferHvacFromTemps(mode, currentC, coolC, heatC, prevTempC) {
  if (!isNum(currentC)) return 'OFF';

  // Trend (previous -> current)
  const trendingDown = isNum(prevTempC) ? (prevTempC - currentC > TREND_DELTA) : false;
  const trendingUp = isNum(prevTempC) ? (currentC - prevTempC > TREND_DELTA) : false;

  if (mode === 'COOL' || mode === 'HEATCOOL') {
    if (isNum(coolC)) {
      const above = currentC >= (coolC + COOL_DELTA_ON);
      if (above || trendingDown) return 'COOLING';
    }
  }
  if (mode === 'HEAT' || mode === 'HEATCOOL') {
    if (isNum(heatC)) {
      const below = currentC <= (heatC - HEAT_DELTA_ON);
      if (below || trendingUp) return 'HEATING';
    }
  }
  return 'OFF';
}

/* ------------------------------ Utilities ------------------------------- */

function hvacModeFromEquipment(equipmentStatus) {
  switch ((equipmentStatus || 'off').toLowerCase()) {
    case 'heat': return 'HEATING';
    case 'cool': return 'COOLING';
    case 'fan':  return 'FAN';
    default:     return 'OFF';
  }
}

function mapHvacModeForBubble(mode) {
  // Already normalized above; keep as-is for Bubble logs compatibility
  return mode || 'OFF';
}

function pick(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function round2(n) { return Math.round(n * 100) / 100; }

function genUuid() {
  // simple RFC4122v4-ish; fine for event correlation
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = (Math.random()*16)|0, v = c === 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

module.exports = {
  SessionManager,
  parseSdmPushMessage,
  extractEffectiveTraits,
};
