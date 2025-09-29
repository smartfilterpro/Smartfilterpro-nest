'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * Counts runtime any time air is moving: HEATING, COOLING, HEATCOOL (auto), or FAN-only.
 */

const RECENT_WINDOW_MS = 120_000;                   // memory window to avoid collapsing to OFF immediately
const COOL_DELTA_ON   = 0.0;                        // permissive: on/at cool setpoint can infer cooling
const HEAT_DELTA_ON   = 0.0;                        // permissive: on/at heat setpoint can infer heating
const TREND_DELTA     = 0.03;                       // °C change indicating trend (slightly more sensitive)
const FAN_TAIL_MS     = Number(process.env.NEST_FAN_TAIL_MS || 30000); // post-run blower purge tail

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
        projectId: parsed?.userId || null, // SDM sometimes exposes this
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
        tailUntil: 0,       // epoch ms until which we keep session active as a purge tail
      });
    }
    return this.byDevice.get(deviceId);
  }

  /**
   * Compute active/state from current event and previous temperature (no tail here).
   */
  computeActiveAndStatus(input, prev) {
    const isReachable = input.connectivity !== 'OFFLINE';
    const isFanRunning = !!(input.hasFanTrait && (input.fanTimerMode === 'ON' || input.fanTimerOn === true));

    let hvacStatus = input.hvacStatusRaw || 'UNKNOWN'; // HEATING/COOLING/OFF/UNKNOWN
    let isHeating = hvacStatus === 'HEATING';
    let isCooling = hvacStatus === 'COOLING';

    // If missing, infer from mode + setpoints + temperature trend
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
    const isHvacActive = Boolean(isHeating || isCooling || isFanRunning);

    // Status string + fanOnly
    let equipmentStatus = 'off';
    let isFanOnly = false;
    if (isHeating) equipmentStatus = 'heat';
    if (isCooling) equipmentStatus = 'cool';
    if (!isHeating && !isCooling && isFanRunning) {
      equipmentStatus = 'fan';
      isFanOnly = true;
    }

    return { isReachable, isHvacActive, equipmentStatus, isFanOnly };
  }

  process(input) {
    const prev = this.getPrev(input.deviceId);
    const nowMs = new Date(input.when).getTime();

    // Base state from current traits (no tail yet)
    let { isReachable, isHvacActive, equipmentStatus, isFanOnly } =
      this.computeActiveAndStatus(input, prev);

    // ── Fan tail logic (post-run blower purge)
    if (!isHvacActive) {
      const justStoppedHeatOrCool = prev.isRunning && (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool');
      const fanExplicitlyRunning = (equipmentStatus === 'fan' || isFanOnly);

      // Schedule tail if we just ended heat/cool and fan trait isn't explicitly on
      if (justStoppedHeatOrCool && !fanExplicitlyRunning && FAN_TAIL_MS > 0 && prev.tailUntil === 0) {
        prev.tailUntil = nowMs + FAN_TAIL_MS;
      }

      // If within tail window, stay active as 'fan'
      if (prev.tailUntil && nowMs < prev.tailUntil) {
        isHvacActive = true;
        equipmentStatus = 'fan';
        isFanOnly = true;
      } else if (prev.tailUntil && nowMs >= prev.tailUntil) {
        // Tail expired
        prev.tailUntil = 0;
      }
    } else {
      // We are active; cancel any scheduled tail
      if (prev.tailUntil) prev.tailUntil = 0;
    }

    // Session transitions using effective active flag
    const becameActive = !prev.isRunning && isHvacActive;
    const becameIdle   =  prev.isRunning && !isHvacActive;

    if (becameActive) {
      prev.isRunning = true;
      prev.startedAt = nowMs;
      prev.startStatus = equipmentStatus || 'fan';
      prev.tailUntil = 0;
    }

    // Close session only when truly idle and no tail
    let runtimeSeconds = null;
    let isRuntimeEvent = false;
    if (becameIdle && prev.startedAt) {
      const ms = Math.max(0, nowMs - prev.startedAt);
      runtimeSeconds = Math.round(ms / 1000);
      isRuntimeEvent = true;

      prev.isRunning = false;
      prev.startedAt = null;
      prev.startStatus = 'off';
      prev.tailUntil = 0;
    }

    // Persist last snapshot (use effective equipmentStatus)
    prev.lastTempC = isNum(input.currentTempC) ? input.currentTempC : prev.lastTempC;
    prev.lastAt = nowMs;
    prev.lastEquipmentStatus = equipmentStatus || prev.lastEquipmentStatus;
    prev.lastMode = input.thermostatMode || prev.lastMode;
    prev.lastReachable = isReachable;
    prev.lastRoom = input.roomDisplayName || prev.lastRoom;

    const hvacMode = hvacModeFromEquipment(equipmentStatus); // 'HEATING'|'COOLING'|'FAN'|'OFF'

    return {
      userId: input.userId || null,
      thermostatId: input.deviceId,
      deviceName: input.deviceName,
      roomDisplayName: input.roomDisplayName || '',
      timestampISO: new Date(nowMs).toISOString(),

      // Modes / status
      thermostatMode: input.thermostatMode || 'OFF', // Nest set mode
      hvacMode,                                      // derived every event
      equipmentStatus,                               // 'off'|'heat'|'cool'|'fan'
      isHvacActive,
      isFanOnly,
      isReachable,

      // Temps
      currentTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
      coolSetpointC: isNum(input.coolSetpointC) ? round2(input.coolSetpointC) : null,
      heatSetpointC: isNum(input.heatSetpointC) ? round2(input.heatSetpointC) : null,

      // Runtime
      runtimeSeconds,                 // null while running; number on session end
      isRuntimeEvent,

      // Convenience temps (start only meaningful while running; we keep null here)
      startTempC: null,
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

      // runtime (keep null while running)
      runtimeSeconds: result.runtimeSeconds,
      runtimeMinutes: result.runtimeSeconds != null ? Math.round(result.runtimeSeconds / 60) : null,
      isRuntimeEvent: Boolean(result.isRuntimeEvent),

      // Modes / state
      hvacMode: result.hvacMode,                 // 'HEATING'|'COOLING'|'FAN'|'OFF'
      operatingState: result.equipmentStatus,    // compatibility alias
      isHvacActive: Boolean(result.isHvacActive),
      thermostatMode: result.thermostatMode,
      isReachable: Boolean(result.isReachable),

      // Temps
      currentTempF: c2f(result.currentTempC),
      coolSetpointF: c2f(result.coolSetpointC),
      heatSetpointF: c2f(result.heatSetpointC),
      startTempF: null,
      endTempF: c2f(result.endTempC),
      currentTempC: result.currentTempC,
      coolSetpointC: result.coolSetpointC,
      heatSetpointC: result.heatSetpointC,
      startTempC: null,
      endTempC: result.endTempC,

      // last flags / mirrors
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
  }
}

/* ============================== INFERENCE ============================== */

function inferHvacFromTemps(mode, currentC, coolC, heatC, prevTempC) {
  const hasCurrent = isNum(currentC);
  const hasPrev    = isNum(prevTempC);

  const trendingDown = hasPrev && hasCurrent ? (prevTempC - currentC > TREND_DELTA) : false;
  const trendingUp   = hasPrev && hasCurrent ? (currentC - prevTempC > TREND_DELTA) : false;

  // Allow trend-only inference immediately after re-link when Temperature is sparse
  const canUseTrendOnly = !hasCurrent && hasPrev;

  if (mode === 'COOL' || mode === 'HEATCOOL') {
    if (isNum(coolC) && hasCurrent) {
      const aboveOrAt = currentC >= (coolC + COOL_DELTA_ON);
      if (aboveOrAt || trendingDown) return 'COOLING';
    } else if (canUseTrendOnly && trendingDown) {
      return 'COOLING';
    }
  }

  if (mode === 'HEAT' || mode === 'HEATCOOL') {
    if (isNum(heatC) && hasCurrent) {
      const belowOrAt = currentC <= (heatC - HEAT_DELTA_ON);
      if (belowOrAt || trendingUp) return 'HEATING';
    } else if (canUseTrendOnly && trendingUp) {
      return 'HEATING';
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

/* ============================== EXPORTS ================================ */

module.exports = {
  SessionManager,
  parseSdmPushMessage,
  extractEffectiveTraits,
};
