'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * - Counts runtime while air is moving: HEATING, COOLING, HEATCOOL (auto), or explicit FAN-only
 * - Keeps a tail (default 30s) after heat/cool ends
 * - Sticky-state: carries forward last known values if missing
 * - Explicit OFF respects tail, closes immediately only if NEST_FAN_TAIL_MS=0
 * - Timeout: force-close sessions if no OFF received (default 3m)
 */

const RECENT_WINDOW_MS   = 120_000; // 2 min sticky
const SESSION_TIMEOUT_MS = Number(process.env.NEST_SESSION_TIMEOUT_MS || 180000); // 3 min
const COOL_DELTA_ON   = 0.0;
const HEAT_DELTA_ON   = 0.0;
const TREND_DELTA     = 0.03;
const FAN_TAIL_MS     = Number(process.env.NEST_FAN_TAIL_MS || 30000); // default 30s

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
    const nowMs = new Date(input.when).getTime();

    // Sticky values
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

    // Detect switch between active heating and cooling
    const switchedWhileActive =
      prev.isRunning &&
      (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool') &&
      (equipmentStatus === 'heat' || equipmentStatus === 'cool') &&
      prev.lastEquipmentStatus !== equipmentStatus;

    if (switchedWhileActive) {
      prev.tailUntil = 0;
      prev.isRunning = true;
      prev.startStatus = equipmentStatus;
    }

    // Fan tail logic (only if not switching)
    if (!isHvacActive && !switchedWhileActive) {
      const justStopped = prev.isRunning &&
        (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool');

      if (justStopped && FAN_TAIL_MS > 0 && prev.tailUntil === 0) {
        prev.tailUntil = nowMs + FAN_TAIL_MS;
        console.log('[TAIL-START]', input.deviceId, 'until', new Date(prev.tailUntil).toISOString());
      }

      if (prev.tailUntil > 0) {
        if (nowMs < prev.tailUntil) {
          // still in tail window → remain active
          isHvacActive = true;
          equipmentStatus = prev.lastEquipmentStatus;
        } else {
          // tail expired → close session
          const ms = Math.max(0, nowMs - prev.startedAt);
          const runtimeSeconds = Math.round(ms / 1000);
          console.log('[TAIL-END]', input.deviceId, 'runtime', runtimeSeconds);
          prev.isRunning = false;
          prev.startedAt = null;
          prev.startStatus = 'off';
          prev.tailUntil = 0;
          return this._buildResult(
            input, nowMs, 'OFF', 'off', false, false, isReachable, runtimeSeconds, true
          );
        }
      }
    } else if (isHvacActive) {
      if (prev.tailUntil) prev.tailUntil = 0;
    }

    // Timeout safeguard
    if (prev.isRunning && nowMs - prev.lastAt > SESSION_TIMEOUT_MS) {
      const ms = Math.max(0, nowMs - prev.startedAt);
      const runtimeSeconds = Math.round(ms / 1000);
      console.log('[TIMEOUT-CLOSE]', input.deviceId, 'runtime', runtimeSeconds);
      prev.isRunning = false;
      prev.startedAt = null;
      prev.startStatus = 'off';
      prev.tailUntil = 0;
      return this._buildResult(input, nowMs, 'OFF', 'off', false, false, isReachable, runtimeSeconds, true);
    }

    const becameActive = !prev.isRunning && isHvacActive;
    const becameIdle = prev.isRunning && !isHvacActive;

    if (becameActive) {
      prev.isRunning = true;
      prev.startedAt = nowMs;
      prev.startStatus = equipmentStatus;
      prev.tailUntil = 0;
    }

    let runtimeSeconds = null;
    let isRuntimeEvent = false;

    // Explicit OFF handling
    if (input.hvacStatusRaw === 'OFF' && prev.isRunning && prev.startedAt && !switchedWhileActive) {
      if (FAN_TAIL_MS === 0) {
        const ms = Math.max(0, nowMs - prev.startedAt);
        runtimeSeconds = Math.round(ms / 1000);
        isRuntimeEvent = true;
        console.log('[SESSION END - EXPLICIT OFF]', input.deviceId, 'runtime', runtimeSeconds);
        prev.isRunning = false;
        prev.startedAt = null;
        prev.startStatus = 'off';
        prev.tailUntil = 0;
        isHvacActive = false;
        equipmentStatus = 'off';
      }
    }
    // Normal idle transition (if not switching)
    else if (becameIdle && prev.startedAt && !switchedWhileActive) {
      const ms = Math.max(0, nowMs - prev.startedAt);
      runtimeSeconds = Math.round(ms / 1000);
      isRuntimeEvent = true;
      console.log('[SESSION END - BECAME IDLE]', input.deviceId, 'runtime', runtimeSeconds);
      prev.isRunning = false;
      prev.startedAt = null;
      prev.startStatus = 'off';
      prev.tailUntil = 0;
    }

    // Save state
    prev.lastTempC = isNum(input.currentTempC) ? input.currentTempC : prev.lastTempC;
    prev.lastAt = nowMs;
    prev.lastEquipmentStatus = equipmentStatus || prev.lastEquipmentStatus;
    prev.lastMode = input.thermostatMode || prev.lastMode;
    prev.lastReachable = isReachable;
    prev.lastRoom = input.roomDisplayName || prev.lastRoom;

    const hvacMode = hvacModeFromEquipment(equipmentStatus);

    const result = {
      userId: input.userId || null,
      thermostatId: input.deviceId,
      deviceName: input.deviceName,
      roomDisplayName: input.roomDisplayName || '',
      timestampISO: new Date(nowMs).toISOString(),
      thermostatMode: input.thermostatMode || 'OFF',
      hvacMode,
      equipmentStatus,
      isHvacActive,
      isFanOnly,
      isReachable,
      currentTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
      coolSetpointC: isNum(input.coolSetpointC) ? round2(input.coolSetpointC) : null,
      heatSetpointC: isNum(input.heatSetpointC) ? round2(input.heatSetpointC) : null,
      runtimeSeconds,
      isRuntimeEvent,
      startTempC: null,
      endTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
    };

    console.log('[STATE]', {
      thermo: input.deviceId,
      mode: input.thermostatMode,
      hvacStatusRaw: input.hvacStatusRaw,
      active: isHvacActive,
      equip: equipmentStatus,
      runtimeSeconds,
      eventTime: input.when,
    });

    return result;
  }

  _buildResult(input, nowMs, hvacMode, equipmentStatus, isHvacActive, isFanOnly, isReachable, runtimeSeconds, isRuntimeEvent) {
    return {
      userId: input.userId || null,
      thermostatId: input.deviceId,
      deviceName: input.deviceName,
      roomDisplayName: input.roomDisplayName || '',
      timestampISO: new Date(nowMs).toISOString(),
      thermostatMode: input.thermostatMode || 'OFF',
      hvacMode,
      equipmentStatus,
      isHvacActive,
      isFanOnly,
      isReachable,
      currentTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
      coolSetpointC: isNum(input.coolSetpointC) ? round2(input.coolSetpointC) : null,
      heatSetpointC: isNum(input.heatSetpointC) ? round2(input.heatSetpointC) : null,
      runtimeSeconds,
      isRuntimeEvent,
      startTempC: null,
      endTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
    };
  }

  toBubblePayload(result) {
    const c2f = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
    return {
      userId: result.userId || null,
      thermostatId: result.thermostatId || null,
      deviceName: result.deviceName || null,
      roomDisplayName: result.roomDisplayName || '',
      runtimeSeconds: result.runtimeSeconds,
      runtimeMinutes: result.runtimeSeconds != null ? Math.round(result.runtimeSeconds / 60) : null,
      isRuntimeEvent: Boolean(result.isRuntimeEvent),
      hvacMode: result.hvacMode,
      operatingState: result.equipmentStatus,
      isHvacActive: Boolean(result.isHvacActive),
      thermostatMode: result.thermostatMode,
      isReachable: Boolean(result.isReachable),
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
