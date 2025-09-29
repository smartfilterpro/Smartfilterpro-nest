'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * Counts runtime any time air is moving: HEATING, COOLING, HEATCOOL (auto), or FAN-only.
 */

const RECENT_WINDOW_MS = 120_000;  // memory window to avoid collapsing to OFF immediately
const COOL_DELTA_ON = 0.3;         // °C above cool setpoint to infer active cooling
const HEAT_DELTA_ON = 0.3;         // °C below heat setpoint to infer active heating
const TREND_DELTA = 0.05;          // °C change indicating the temperature trend

/* ============================= EXPORTS ================================ */

module.exports = {
  SessionManager,
  parseSdmPushMessage,
  extractEffectiveTraits,
};

/* ============================== PARSING ================================ */

function parseSdmPushMessage(body) {
  // Accept either Pub/Sub push (base64) or direct SDM JSON (hand test)
  try {
    // Pub/Sub
    if (body && body.message && body.message.data) {
      const json = Buffer.from(body.message.data, 'base64').toString('utf8');
      const parsed = JSON.parse(json);

      const events = [];
      const ru = parsed?.resourceUpdate;
      if (ru && ru.name) {
        events.push({
          deviceName: ru.name,
          traits: ru?.traits || {},
          timestamp: parsed?.eventTime || new Date().toISOString(),
        });
      }
      return {
        events,
        userId: null,
        projectId: parsed?.userId || null, // SDM confusingly names this sometimes
        structureId: null,
      };
    }

    // Direct JSON (test posts)
    if (body && body.resourceUpdate) {
      return parseSdmPushMessage({
        message: { data: Buffer.from(JSON.stringify(body)).toString('base64') },
      });
    }

    // Already-normalized
    if (Array.isArray(body?.events)) {
      return { events: body.events, userId: body.userId || null, projectId: null, structureId: null };
    }
  } catch (e) {
    console.warn('[WARN] parseSdmPushMessage failed:', e.message);
  }
  return null;
}

function extractEffectiveTraits(evt) {
  const deviceName = evt.deviceName || '';               // enterprises/.../devices/DEVICE_ID
  const deviceId = deviceName.split('/devices/')[1] || deviceName;
  const t = evt.traits || {};

  const thermostatMode = pick(
    t['sdm.devices.traits.ThermostatMode']?.mode,
    t['ThermostatMode']?.mode
  ); // OFF/HEAT/COOL/HEATCOOL

  const hvacStatusRaw = pick(
    t['sdm.devices.traits.ThermostatHvac']?.status,
    t['ThermostatHvac']?.status
  ); // OFF/HEATING/COOLING (optional, not in every event)

  const hasFanTrait = Boolean(t['sdm.devices.traits.Fan'] || t['Fan']);
  const fanTimerMode = pick(
    t['sdm.devices.traits.Fan']?.timerMode,
    t['Fan']?.timerMode
  ); // ON/OFF
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

/* ============================== SESSIONS =============================== */

class SessionManager {
  constructor() {
    this.byDevice = new Map();
  }

  getPrev(deviceId) {
    if (!this.byDevice.has(deviceId)) {
      this.byDevice.set(deviceId, {
        isRunning: false,
        startedAt: null,
        startStatus: 'off', // 'cool' | 'heat' | 'fan' | 'off'
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

  computeActiveAndStatus(input, prev) {
    const now = new Date(input.when).getTime();

    // Reachability
    const isReachable = input.connectivity !== 'OFFLINE';

    // Fan explicitly running?
    const isFanRunning = !!(input.hasFanTrait && (input.fanTimerMode === 'ON' || input.fanTimerOn === true));

    // Explicit HVAC status wins when present
    let hvacStatus = input.hvacStatusRaw || 'UNKNOWN'; // HEATING/COOLING/OFF/UNKNOWN
    let isHeating = hvacStatus === 'HEATING';
    let isCooling = hvacStatus === 'COOLING';

    // Otherwise infer from mode + setpoints + temp trend
    if (hvacStatus === 'UNKNOWN' || hvacStatus == null) {
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

    // Status string + fanOnly
    let equipmentStatus = 'off';
    let isFanOnly = false;
    if (isHeating) equipmentStatus = 'heat';
    if (isCooling) equipmentStatus = 'cool';
    if (!isHeating && !isCooling && isFanRunning) {
      equipmentStatus = 'fan';
      isFanOnly = true;
    }

    // Short memory to avoid flapping to OFF when traits are sparse
    if (!isActive && prev.isRunning && prev.lastAt && now - prev.lastAt < RECENT_WINDOW_MS) {
      return {
        isReachable,
        isHvacActive: true,
        equipmentStatus: prev.lastEquipmentStatus,
        isFanOnly: prev.lastEquipmentStatus === 'fan',
      };
    }

    return { isReachable, isHvacActive: isActive, equipmentStatus, isFanOnly };
  }

  process(input) {
    const prev = this.getPrev(input.deviceId);
    const now = new Date(input.when).getTime();

    const { isReachable, isHvacActive, equipmentStatus, isFanOnly } =
      this.computeActiveAndStatus(input, prev);

    const becameActive = !prev.isRunning && isHvacActive;
    const becameIdle   =  prev.isRunning && !isHvacActive;

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
      const ms = Math.max(0, now - prev.startedAt);
      runtimeSeconds = Math.round(ms / 1000);
      isRuntimeEvent = true;

      prev.isRunning = false;
      prev.startedAt = null;
      prev.startStatus = 'off';
    }

    // Persist last snapshot
    prev.lastTempC = isNum(input.currentTempC) ? input.currentTempC : prev.lastTempC;
    prev.lastAt = now;
    prev.lastEquipmentStatus = equipmentStatus || prev.lastEquipmentStatus;
    prev.lastMode = input.thermostatMode || prev.lastMode;
    prev.lastReachable = isReachable;
    prev.lastRoom = input.roomDisplayName || prev.lastRoom;

    return {
      userId: input.userId || null,
      thermostatId: input.deviceId,
      deviceName: input.deviceName,
      roomDisplayName: input.roomDisplayName || '',
      timestampISO: new Date(now).toISOString(),
      thermostatMode: input.thermostatMode || 'OFF',      // OFF/HEAT/COOL/HEATCOOL
      hvacMode: hvacModeFromEquipment(equipmentStatus),   // OFF/HEATING/COOLING/FAN
      equipmentStatus,                                     // 'off'|'heat'|'cool'|'fan'
      isHvacActive,
      isFanOnly,
      isReachable,
      currentTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
      coolSetpointC: isNum(input.coolSetpointC) ? round2(input.coolSetpointC) : null,
      heatSetpointC: isNum(input.heatSetpointC) ? round2(input.heatSetpointC) : null,
      runtimeSeconds, // null while running; set on session end
      isRuntimeEvent,
      startTempC: prev.isRunning && prev.startedAt ? prev.lastTempC : null,
      endTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
    };
  }

  toBubblePayload(result) {
    const c2f = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
    return {
      userId: result.userId,
      thermostatId: result.thermostatId,
      deviceName: result.deviceName || '',
      roomDisplayName: result.roomDisplayName || '',
      runtimeSeconds: result.runtimeSeconds ?? 0,
      runtimeMinutes: result.runtimeSeconds != null ? Math.round(result.runtimeSeconds / 60) : 0,
      isRuntimeEvent: Boolean(result.isRuntimeEvent),
      hvacMode: result.hvacMode || 'OFF', // 'HEATING'|'COOLING'|'FAN'|'OFF'
      isHvacActive: Boolean(result.isHvacActive),
      thermostatMode: result.thermostatMode,
      isReachable: Boolean(result.isReachable),
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
      lastIsCooling: result.equipmentStatus === 'cool',
      lastIsHeating: result.equipmentStatus === 'heat',
      lastIsFanOnly: result.equipmentStatus === 'fan',
      lastEquipmentStatus: result.equipmentStatus,
      equipmentStatus: result.equipmentStatus,
      isFanOnly: result.isFanOnly,
      timestamp: result.timestampISO,
      eventId: genUuid(),
      eventTimestamp: Date.parse(result.timestampISO),
    };
  }
}

/* ============================== INFERENCE ============================== */

function inferHvacFromTemps(mode, currentC, coolC, heatC, prevTempC) {
  if (!isNum(currentC)) return 'OFF';

  const trendingDown = isNum(prevTempC) ? (prevTempC - currentC > TREND_DELTA) : false;
  const trendingUp   = isNum(prevTempC) ? (currentC - prevTempC > TREND_DELTA) : false;

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

/* ============================== UTILITIES ============================== */

function hvacModeFromEquipment(equipmentStatus) {
  switch ((equipmentStatus || 'off').toLowerCase()) {
    case 'heat': return 'HEATING';
    case 'cool': return 'COOLING';
    case 'fan':  return 'FAN';
    default:     return 'OFF';
  }
}

function pick(...vals) { for (const v of vals) if (v !== undefined && v !== null) return v; return undefined; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function round2(n) { return Math.round(n * 100) / 100; }

function genUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = (Math.random()*16)|0, v = c === 'x' ? r : (r&0x3|0x8);
    return v.toString(16);
  });
}