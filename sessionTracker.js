'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * - Counts runtime while air is moving: HEATING, COOLING, HEATCOOL (auto), or explicit FAN-only
 * - Keeps a 30s tail after heat/cool ends (reports same heat/cool during tail)
 * - Never downgrades active heat/cool to fan just because Fan trait is weird
 */

const RECENT_WINDOW_MS = 120_000;
const COOL_DELTA_ON   = 0.0;   // permissive: at/above cool SP can infer cooling
const HEAT_DELTA_ON   = 0.0;   // permissive: at/below heat SP can infer heating
const TREND_DELTA     = 0.03;  // °C trend sensitivity
const FAN_TAIL_MS     = Number(process.env.NEST_FAN_TAIL_MS || 30000); // default 30s

/* ---------------- Parsing ---------------- */

function parseSdmPushMessage(body) {
  try {
    // Pub/Sub form: { message: { data: base64 }, subscription: "..." }
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
      return { events, userId: null, projectId: parsed?.userId || null, structureId: null };
    }
    // Direct SDM JSON (for manual tests)
    if (body && body.resourceUpdate) {
      return parseSdmPushMessage({ message: { data: Buffer.from(JSON.stringify(body)).toString('base64') } });
    }
    // Already normalized
    if (Array.isArray(body?.events)) {
      return { events: body.events, userId: body.userId || null, projectId: null, structureId: null };
    }
  } catch (e) {
    console.warn('[WARN] parseSdmPushMessage failed:', e.message);
  }
  return null;
}

function extractEffectiveTraits(evt) {
  const deviceName = evt.deviceName || '';
  const deviceId = deviceName.split('/devices/')[1] || deviceName;
  const t = evt.traits || {};

  const thermostatMode = pick(t['sdm.devices.traits.ThermostatMode']?.mode, t['ThermostatMode']?.mode); // OFF/HEAT/COOL/HEATCOOL
  const hvacStatusRaw = pick(t['sdm.devices.traits.ThermostatHvac']?.status, t['ThermostatHvac']?.status); // HEATING/COOLING/OFF

  const hasFanTrait = Boolean(t['sdm.devices.traits.Fan'] || t['Fan']);
  const fanTimerMode = pick(t['sdm.devices.traits.Fan']?.timerMode, t['Fan']?.timerMode); // ON/OFF
  const fanTimerOn = pick(t['sdm.devices.traits.Fan']?.timerMode === 'ON', t['Fan']?.timerMode === 'ON');

  const currentTempC = pick(t['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius, t['Temperature']?.ambientTemperatureCelsius);
  const coolSetpointC = pick(t['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius, t['ThermostatTemperatureSetpoint']?.coolCelsius);
  const heatSetpointC = pick(t['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius, t['ThermostatTemperatureSetpoint']?.heatCelsius);

  const connectivity = pick(t['sdm.devices.traits.Connectivity']?.status, t['Connectivity']?.status); // ONLINE/OFFLINE/UNKNOWN
  const roomDisplayName = pick(t['sdm.devices.traits.Room']?.name, t['Room']?.name);

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

/* ---------------- Sessions ---------------- */

class SessionManager {
  constructor() { this.byDevice = new Map(); }

  getPrev(deviceId) {
    if (!this.byDevice.has(deviceId)) {
      this.byDevice.set(deviceId, {
        isRunning: false,
        startedAt: null,
        startStatus: 'off',
        lastTempC: null,
        lastAt: null,
        lastEquipmentStatus: 'off',
        lastMode: 'OFF',
        lastReachable: true,
        lastRoom: '',
        tailUntil: 0, // time until which we keep session active post-run
      });
    }
    return this.byDevice.get(deviceId);
  }

  computeActiveAndStatus(input, prev) {
    const isReachable = input.connectivity !== 'OFFLINE';
    const isFanRunning = !!(input.hasFanTrait && (input.fanTimerMode === 'ON' || input.fanTimerOn === true));

    // 1) Prefer explicit SDM HVAC status when present
    let hvacStatus = input.hvacStatusRaw || 'UNKNOWN'; // HEATING/COOLING/OFF/UNKNOWN
    let isHeating = hvacStatus === 'HEATING';
    let isCooling = hvacStatus === 'COOLING';

    // 2) If unknown/missing, infer from mode + setpoints + trend
    if (hvacStatus === 'UNKNOWN' || hvacStatus == null) {
      const inferred = inferHvacFromTemps(input.thermostatMode, input.currentTempC, input.coolSetpointC, input.heatSetpointC, prev.lastTempC);
      if (inferred === 'HEATING' || inferred === 'COOLING') {
        hvacStatus = inferred;
        isHeating = inferred === 'HEATING';
        isCooling = inferred === 'COOLING';
      } else {
        hvacStatus = 'OFF';
      }
    }

    // 3) Compute active and equipmentStatus (never downgrade active heat/cool to fan)
    let isHvacActive = Boolean(isHeating || isCooling || isFanRunning);
    let equipmentStatus = 'off';
    let isFanOnly = false;

    if (isHeating) {
      equipmentStatus = 'heat';
    } else if (isCooling) {
      equipmentStatus = 'cool';
    } else if (hvacStatus === 'OFF' || hvacStatus === 'UNKNOWN') {
      // Only report fan if HVAC is truly off AND fan is explicitly on
      if (isFanRunning) {
        equipmentStatus = 'fan';
        isFanOnly = true;
      }
    }

    return { isReachable, isHvacActive, equipmentStatus, isFanOnly };
  }

  process(input) {
    const prev = this.getPrev(input.deviceId);
    const nowMs = new Date(input.when).getTime();

    let { isReachable, isHvacActive, equipmentStatus, isFanOnly } = this.computeActiveAndStatus(input, prev);

    // ── Fan tail logic: after heat/cool ends, keep active for FAN_TAIL_MS and keep last mode
    if (!isHvacActive) {
      const justStoppedHeatOrCool = prev.isRunning && (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool');
      const fanExplicit = (equipmentStatus === 'fan' || isFanOnly);

      if (justStoppedHeatOrCool && !fanExplicit && FAN_TAIL_MS > 0 && prev.tailUntil === 0) {
        prev.tailUntil = nowMs + FAN_TAIL_MS;
      }

      if (prev.tailUntil && nowMs < prev.tailUntil) {
        isHvacActive = true;
        // keep reporting the last real state during tail (NOT fan)
        if (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool') {
          equipmentStatus = prev.lastEquipmentStatus;
        } else {
          equipmentStatus = 'fan';
          isFanOnly = true;
        }
      } else if (prev.tailUntil && nowMs >= prev.tailUntil) {
        prev.tailUntil = 0;
      }
    } else {
      if (prev.tailUntil) prev.tailUntil = 0;
    }

    const becameActive = !prev.isRunning && isHvacActive;
    const becameIdle   =  prev.isRunning && !isHvacActive;

    if (becameActive) {
      prev.isRunning = true;
      prev.startedAt = nowMs;
      prev.startStatus = equipmentStatus || 'fan';
      prev.tailUntil = 0;
    }

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

    // Persist last snapshot
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

      thermostatMode: input.thermostatMode || 'OFF', // Nest set mode
      hvacMode,
      equipmentStatus,                               // 'off'|'heat'|'cool'|'fan'
      isHvacActive,
      isFanOnly,
      isReachable,

      currentTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
      coolSetpointC: isNum(input.coolSetpointC) ? round2(input.coolSetpointC) : null,
      heatSetpointC: isNum(input.heatSetpointC) ? round2(input.heatSetpointC) : null,

      runtimeSeconds,                 // null while running; number on session end
      isRuntimeEvent,

      startTempC: null,
      endTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
    };
  }

  toBubblePayload(result) {
    const c2f = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
    return {
      // Always include identifiers
      userId: result.userId || null,
      thermostatId: result.thermostatId || null,
      deviceName: result.deviceName || null,

      roomDisplayName: result.roomDisplayName || '',

      // Runtime
      runtimeSeconds: result.runtimeSeconds,
      runtimeMinutes: result.runtimeSeconds != null ? Math.round(result.runtimeSeconds / 60) : null,
      isRuntimeEvent: Boolean(result.isRuntimeEvent),

      // State
      hvacMode: result.hvacMode,                   // 'HEATING'|'COOLING'|'FAN'|'OFF'
      operatingState: result.equipmentStatus,      // compatibility alias many workflows expect
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

      // Mirrors/flags
      lastIsCooling: result.equipmentStatus === 'cool',
      lastIsHeating: result.equipmentStatus === 'heat',
      lastIsFanOnly: result.equipmentStatus === 'fan',
      lastEquipmentStatus: result.equipmentStatus,
      equipmentStatus: result.equipmentStatus,
      isFanOnly: result.isFanOnly,

      // Timestamps
      timestamp: result.timestampISO,
      eventId: genUuid(),
      eventTimestamp: Date.parse(result.timestampISO),
    };
  }
}

/* ---------------- Inference ---------------- */

function inferHvacFromTemps(mode, currentC, coolC, heatC, prevTempC) {
  const hasCurrent = isNum(currentC);
  const hasPrev = isNum(prevTempC);

  const trendingDown = hasPrev && hasCurrent ? (prevTempC - currentC > TREND_DELTA) : false;
  const trendingUp   = hasPrev && hasCurrent ? (currentC - prevTempC > TREND_DELTA) : false;
  const canUseTrendOnly = !hasCurrent && hasPrev;

  if (mode === 'COOL' || mode === 'HEATCOOL') {
    if (isNum(coolC) && hasCurrent) {
      if (currentC >= (coolC + COOL_DELTA_ON) || trendingDown) return 'COOLING';
    } else if (canUseTrendOnly && trendingDown) return 'COOLING';
  }
  if (mode === 'HEAT' || mode === 'HEATCOOL') {
    if (isNum(heatC) && hasCurrent) {
      if (currentC <= (heatC - HEAT_DELTA_ON) || trendingUp) return 'HEATING';
    } else if (canUseTrendOnly && trendingUp) return 'HEATING';
  }
  return 'OFF';
}

/* ---------------- Utils ---------------- */

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

/* ---------------- Exports ---------------- */

module.exports = {
  SessionManager,
  parseSdmPushMessage,
  extractEffectiveTraits,
};