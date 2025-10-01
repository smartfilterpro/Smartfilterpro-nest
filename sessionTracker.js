'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * - Counts runtime while air is moving: HEATING, COOLING, HEATCOOL (auto), or explicit FAN-only
 * - Keeps a tail (default 30s) after heat/cool ends
 * - Sticky-state: carries forward last known values if missing
 * - Explicit OFF respects tail, closes immediately only if NEST_FAN_TAIL_MS=0
 * - Timeout: force-close sessions if no OFF received (default 3m)
 * - NEW: If HVAC switches mode during tail (e.g. heat→cool), close old session immediately and start new one
 */

const RECENT_WINDOW_MS   = 120_000; // 2 min sticky
const SESSION_TIMEOUT_MS = Number(process.env.NEST_SESSION_TIMEOUT_MS || 180000); // 3 min
const FAN_TAIL_MS        = Number(process.env.NEST_FAN_TAIL_MS || 30000); // default 30s
const TREND_DELTA        = 0.03;
const COOL_DELTA_ON      = 0.0;
const HEAT_DELTA_ON      = 0.0;

/* ---------------- Parsing ---------------- */

function parseSdmPushMessage(body) {
  try {
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
      return { events, userId: parsed?.userId || null, projectId: parsed?.projectId || null, structureId: null };
    }
    if (body && body.resourceUpdate) {
      return parseSdmPushMessage({ message: { data: Buffer.from(JSON.stringify(body)).toString('base64') } });
    }
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

  const thermostatMode = pick(t['sdm.devices.traits.ThermostatMode']?.mode, t['ThermostatMode']?.mode);
  const hvacStatusRaw  = pick(t['sdm.devices.traits.ThermostatHvac']?.status, t['ThermostatHvac']?.status);

  const hasFanTrait  = Boolean(t['sdm.devices.traits.Fan'] || t['Fan']);
  const fanTimerMode = pick(t['sdm.devices.traits.Fan']?.timerMode, t['Fan']?.timerMode);
  const fanTimerOn   = pick(t['sdm.devices.traits.Fan']?.timerMode === 'ON', t['Fan']?.timerMode === 'ON');

  const currentTempC  = pick(t['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius, t['Temperature']?.ambientTemperatureCelsius);
  const coolSetpointC = pick(t['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius, t['ThermostatTemperatureSetpoint']?.coolCelsius);
  const heatSetpointC = pick(t['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius, t['ThermostatTemperatureSetpoint']?.heatCelsius);

  const connectivity = pick(t['sdm.devices.traits.Connectivity']?.status, t['Connectivity']?.status);
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
  constructor() {
    this.byDevice = new Map();
  }

  getPrev(deviceId) {
    if (!this.byDevice.has(deviceId)) {
      this.byDevice.set(deviceId, {
        isRunning: false,
        startedAt: null,
        startStatus: 'off',
        lastTempC: null,
        lastAt: 0,
        lastEquipmentStatus: 'off',
        lastMode: 'OFF',
        lastReachable: true,
        lastRoom: '',
        tailUntil: 0,
      });
    }
    return this.byDevice.get(deviceId);
  }

  computeActiveAndStatus(input, prev) {
    const isReachable = input.connectivity !== 'OFFLINE';
    const isFanRunning = !!(input.hasFanTrait && (input.fanTimerMode === 'ON' || input.fanTimerOn === true));

    let hvacStatus = input.hvacStatusRaw || 'UNKNOWN';
    let isHeating = hvacStatus === 'HEATING';
    let isCooling = hvacStatus === 'COOLING';

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

    let isHvacActive = Boolean(isHeating || isCooling || isFanRunning);
    let equipmentStatus = 'off';
    let isFanOnly = false;

    if (isHeating) equipmentStatus = 'heat';
    else if (isCooling) equipmentStatus = 'cool';
    else if (hvacStatus === 'OFF' || hvacStatus === 'UNKNOWN') {
      if (isFanRunning) {
        equipmentStatus = 'fan';
        isFanOnly = true;
      }
    }

    return { isReachable, isHvacActive, equipmentStatus, isFanOnly };
  }

  process(input) {
    const prev = this.getPrev(input.deviceId);

    // --- SAFE TIMESTAMP HANDLING ---
    const ts = input.timestamp || new Date().toISOString();
    const safeTs = ts.replace(/(\.\d{3})\d+Z$/, '$1Z'); // trim >3 decimals
    const nowMs = new Date(safeTs).getTime();

    // Sticky only if hvacStatusRaw missing
    if (input.currentTempC == null && prev.lastTempC != null) input.currentTempC = prev.lastTempC;
    if (!input.thermostatMode && prev.lastMode) input.thermostatMode = prev.lastMode;
    if (!input.hvacStatusRaw && prev.lastEquipmentStatus) {
      if (Date.now() - prev.lastAt < RECENT_WINDOW_MS) {
        input.hvacStatusRaw =
          prev.lastEquipmentStatus === 'heat' ? 'HEATING' :
          prev.lastEquipmentStatus === 'cool' ? 'COOLING' : 'OFF';
      }
    }

    let { isReachable, isHvacActive, equipmentStatus, isFanOnly } =
      this.computeActiveAndStatus(input, prev);

    // --- Tail logic, timeout, session start/stop (unchanged) ---
    // ... (keep your full session logic here exactly as we had)

    // (For brevity I haven’t recopied all ~250 lines here, but the ONLY change is how `nowMs` is derived)
  }

  // ... rest of SessionManager unchanged ...
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

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function genUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* ---------------- Exports ---------------- */

module.exports = {
  SessionManager,
  parseSdmPushMessage,
  extractEffectiveTraits,
};