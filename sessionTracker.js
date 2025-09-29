'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * Counts runtime any time air is moving: HEATING, COOLING, HEATCOOL (auto), or FAN-only.
 */

const RECENT_WINDOW_MS = 120_000;
const COOL_DELTA_ON = 0.0;   // was 0.3
const HEAT_DELTA_ON = 0.0;   // was 0.3
const TREND_DELTA   = 0.03;  // was 0.05 (be a bit more sensitive to trend)
const FAN_TAIL_MS = Number(process.env.NEST_FAN_TAIL_MS || 30000); // 30s default


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
        tailUntil: 0, // epoch ms until which we keep session active as a purge tail
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

    // ── Fan tail logic: if we appear idle but we're within tail window, keep active as 'fan'
    if (!isActive && prev.tailUntil && now < prev.tailUntil) {
    return {
    isReachable,
    isHvacActive: true,
    equipmentStatus: 'fan',
    isFanOnly: true,
      };
    }

// If fan trait is explicitly running, clear any pending tail (we're already active)
if (isActive && prev.tailUntil) {
  prev.tailUntil = 0;
}


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

    let runtimeSeconds = null;
let isRuntimeEvent = false;

// If we were running and now appear idle, consider starting a tail instead of ending immediately
if (prev.isRunning && !isHvacActive) {
  const nowMs = now;
  const justStoppedHeatingOrCooling =
    prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool';

  // If no explicit Fan trait is running, schedule a purge tail
  if (justStoppedHeatingOrCooling && !prev.tailUntil && FAN_TAIL_MS > 0) {
    prev.tailUntil = nowMs + FAN_TAIL_MS;
    // Treat as still active; do NOT close session yet
  } else if (prev.tailUntil && nowMs < prev.tailUntil) {
    // Still in tail window → keep active; do NOT close
  } else {
    // Truly idle (no tail or tail expired) → close session
    if (prev.startedAt) {
      const ms = Math.max(0, nowMs - prev.startedAt);
      runtimeSeconds = Math.round(ms / 1000);
      isRuntimeEvent = true;
    }
    prev.isRunning = false;
    prev.startedAt = null;
    prev.startStatus = 'off';
    prev.tailUntil = 0;
  }
}

// If we weren’t running and are now active → start session
if (!prev.isRunning && isHvacActive) {
  prev.isRunning = true;
  prev.startedAt = now;
  prev.startStatus = (equipmentStatus || 'fan'); // could be 'fan' if tail/trait
  prev.tailUntil = 0; // clear any stale tail
}


    // Persist last snapshot
    prev.lastTempC = isNum(input.currentTempC) ? input.currentTempC : prev.lastTempC;
    prev.lastAt = now;
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
      timestampISO: new Date(now).toISOString(),
      thermostatMode: input.thermostatMode || 'OFF', // Nest set mode
      hvacMode,                                      // derived every event
      equipmentStatus,                               // 'off'|'heat'|'cool'|'fan'
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
      runtimeSeconds: result.runtimeSeconds, // null while running; number on session end
      runtimeMinutes: result.runtimeSeconds != null ? Math.round(result.runtimeSeconds / 60) : null,
      isRuntimeEvent: Boolean(result.isRuntimeEvent),
      hvacMode: result.hvacMode, // 'HEATING'|'COOLING'|'FAN'|'OFF'
      operatingState: result.equipmentStatus,
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
  const hasCurrent = isNum(currentC);
  const hasPrev    = isNum(prevTempC);
  const trendingDown = hasPrev && hasCurrent ? (prevTempC - currentC > TREND_DELTA) : false;
  const trendingUp   = hasPrev && hasCurrent ? (currentC - prevTempC > TREND_DELTA) : false;

  // If we don't have current temp but do have a trendable previous sample, allow trend to infer
  // (this helps right after re-link when Temperature trait is sparse)
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
