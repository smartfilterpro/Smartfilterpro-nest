'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * Counts runtime any time air is moving: HEATING, COOLING, HEATCOOL (auto), or FAN-only.
 */

const RECENT_WINDOW_MS = 120_000;
const COOL_DELTA_ON = 0.0;
const HEAT_DELTA_ON = 0.0;
const TREND_DELTA = 0.03;
const FAN_TAIL_MS = Number(process.env.NEST_FAN_TAIL_MS || 30000);

const DEBUG = process.env.DEBUG === 'true' || process.env.NODE_ENV !== 'production';
function log(...args) { if (DEBUG) console.log('[SessionTracker]', ...args); }
function logWarn(...args) { console.warn('[SessionTracker WARN]', ...args); }

/* ============================== PARSING ================================ */

function parseSdmPushMessage(body) {
  try {
    if (body && body.message && body.message.data) {
      const json = Buffer.from(body.message.data, 'base64').toString('utf8');
      log('Decoded Pub/Sub message:', json.substring(0, 200));
      const parsed = JSON.parse(json);

      const events = [];
      const ru = parsed?.resourceUpdate;
      if (ru && ru.name) {
        events.push({
          deviceName: ru.name,
          traits: ru?.traits || {},
          timestamp: parsed?.eventTime || new Date().toISOString(),
        });
        log(`Parsed event for device: ${ru.name}`);
      } else {
        logWarn('No resourceUpdate found in message');
      }
      return { events, userId: null, projectId: parsed?.userId || null, structureId: null };
    }

    if (body && body.resourceUpdate) {
      log('Direct JSON format detected');
      return parseSdmPushMessage({ message: { data: Buffer.from(JSON.stringify(body)).toString('base64') } });
    }

    if (Array.isArray(body?.events)) {
      log(`Already-normalized format with ${body.events.length} events`);
      return { events: body.events, userId: body.userId || null, projectId: null, structureId: null };
    }

    logWarn('Unrecognized message format');
  } catch (e) {
    logWarn('parseSdmPushMessage failed:', e.message);
  }
  return null;
}

function extractEffectiveTraits(evt) {
  const deviceName = evt.deviceName || '';
  const deviceId = deviceName.split('/devices/')[1] || deviceName;
  const t = evt.traits || {};

  const thermostatMode = pick(t['sdm.devices.traits.ThermostatMode']?.mode, t['ThermostatMode']?.mode);
  const hvacStatusRaw = pick(t['sdm.devices.traits.ThermostatHvac']?.status, t['ThermostatHvac']?.status);

  const hasFanTrait = Boolean(t['sdm.devices.traits.Fan'] || t['Fan']);
  const fanTimerMode = pick(t['sdm.devices.traits.Fan']?.timerMode, t['Fan']?.timerMode);
  const fanTimerOn = pick(t['sdm.devices.traits.Fan']?.timerMode === 'ON', t['Fan']?.timerMode === 'ON');

  const currentTempC = pick(t['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius, t['Temperature']?.ambientTemperatureCelsius);
  const coolSetpointC = pick(t['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius, t['ThermostatTemperatureSetpoint']?.coolCelsius);
  const heatSetpointC = pick(t['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius, t['ThermostatTemperatureSetpoint']?.heatCelsius);

  const connectivity = pick(t['sdm.devices.traits.Connectivity']?.status, t['Connectivity']?.status);
  const roomDisplayName = pick(t['sdm.devices.traits.Room']?.name, t['Room']?.name);
  const timestamp = evt.timestamp || new Date().toISOString();

  const extracted = {
    deviceId, deviceName, thermostatMode, hvacStatusRaw,
    hasFanTrait, fanTimerMode, fanTimerOn,
    currentTempC: isNum(currentTempC) ? round2(currentTempC) : null,
    coolSetpointC: isNum(coolSetpointC) ? round2(coolSetpointC) : null,
    heatSetpointC: isNum(heatSetpointC) ? round2(heatSetpointC) : null,
    connectivity, roomDisplayName, timestamp,
  };

  log(`Traits for ${deviceId}: mode=${thermostatMode} hvac=${hvacStatusRaw} temp=${extracted.currentTempC}°C fan=${fanTimerMode}`);
  return extracted;
}

/* ============================== SESSIONS =============================== */

class SessionManager {
  constructor() { this.byDevice = new Map(); }

  getPrev(deviceId) {
    if (!this.byDevice.has(deviceId)) {
      log(`Initializing state for device: ${deviceId}`);
      this.byDevice.set(deviceId, {
        isRunning: false, startedAt: null, startStatus: 'off',
        lastTempC: null, lastAt: null, lastEquipmentStatus: 'off',
        lastMode: 'OFF', lastReachable: true, lastRoom: '', tailUntil: 0,
      });
    }
    return this.byDevice.get(deviceId);
  }

  getDebugState(deviceId) {
    if (deviceId) return this.byDevice.get(deviceId) || null;
    const out = {}; for (const [k,v] of this.byDevice.entries()) out[k]=v; return out;
  }

  computeActiveAndStatus(input, prev, now) {
    log('RAW INPUT', JSON.stringify({
      deviceId: input.deviceId, when: input.when, thermostatMode: input.thermostatMode,
      hvacStatusRaw: input.hvacStatusRaw, hasFanTrait: input.hasFanTrait,
      fanTimerMode: input.fanTimerMode, fanTimerOn: input.fanTimerOn,
      currentTempC: input.currentTempC, coolSetpointC: input.coolSetpointC,
      heatSetpointC: input.heatSetpointC, connectivity: input.connectivity
    }, null, 2));

    const isReachable = input.connectivity !== 'OFFLINE';
    const isFanRunning = !!(input.hasFanTrait && (input.fanTimerMode === 'ON' || input.fanTimerOn === true));

    let hvacStatus = input.hvacStatusRaw || 'UNKNOWN';
    let isHeating = hvacStatus === 'HEATING';
    let isCooling = hvacStatus === 'COOLING';

    if (hvacStatus === 'UNKNOWN' || hvacStatus == null) {
      const inferred = inferHvacFromTemps(input.thermostatMode, input.currentTempC, input.coolSetpointC, input.heatSetpointC, prev.lastTempC);
      log(`INFER: mode=${input.thermostatMode} current=${input.currentTempC}C cool=${input.coolSetpointC}C heat=${input.heatSetpointC}C prev=${prev.lastTempC}C → ${inferred}`);
      if (inferred === 'HEATING' || inferred === 'COOLING') {
        hvacStatus = inferred; isHeating = inferred === 'HEATING'; isCooling = inferred === 'COOLING';
      } else { hvacStatus = 'OFF'; }
    }

    const isActive = Boolean(isHeating || isCooling || isFanRunning);

    let equipmentStatus = 'off', isFanOnly = false;
    if (isHeating) equipmentStatus = 'heat';
    if (isCooling) equipmentStatus = 'cool';
    if (!isHeating && !isCooling && isFanRunning) { equipmentStatus = 'fan'; isFanOnly = true; }

    const hasExplicitOff = input.hvacStatusRaw === 'OFF';
    const hasExplicitMode = input.thermostatMode != null && input.thermostatMode !== undefined;

    if (!isActive && !hasExplicitOff && prev.isRunning && prev.lastAt && now - prev.lastAt < RECENT_WINDOW_MS) {
      if (hasExplicitMode && input.thermostatMode === 'OFF') {
        log('SMOOTHING: explicit mode OFF → not maintaining');
      } else {
        log(`SMOOTHING: within ${RECENT_WINDOW_MS}ms window, maintain previous status=${prev.lastEquipmentStatus}`);
        return { isReachable, isHvacActive: true, equipmentStatus: prev.lastEquipmentStatus, isFanOnly: prev.lastEquipmentStatus === 'fan' };
      }
    }

    log(`DECISION: reachable=${isReachable} active=${isActive} hvac=${hvacStatus} equip=${equipmentStatus} fanOnly=${isFanOnly} fanTimer=${input.fanTimerMode}`);
    return { isReachable, isHvacActive: isActive, equipmentStatus, isFanOnly };
  }

  process(input) {
    const prev = this.getPrev(input.deviceId);
    const now = new Date(input.when).toISOString();
    const nowMs = Date.parse(now);

    log(`\n=== PROCESS ${input.deviceId} @ ${now} ===`);
    log(`PREV: running=${prev.isRunning} startedAt=${prev.startedAt ? new Date(prev.startedAt).toISOString() : '—'} last=${prev.lastEquipmentStatus} tailUntil=${prev.tailUntil > 0 ? new Date(prev.tailUntil).toISOString() : '—'}`);

    let { isReachable, isHvacActive, equipmentStatus, isFanOnly } = this.computeActiveAndStatus(input, prev, nowMs);

    const baseActive = isHvacActive;
    const becameIdle = prev.isRunning && !baseActive;

    let runtimeSeconds = null, isRuntimeEvent = false, endedStatus = null;

    if (becameIdle && prev.startedAt) {
      const ms = Math.max(0, nowMs - prev.startedAt);
      runtimeSeconds = Math.round(ms / 1000); isRuntimeEvent = true; endedStatus = prev.startStatus;
      log(`🔴 END: ${prev.startStatus} ran ${runtimeSeconds}s`);
      prev.isRunning = false; prev.startedAt = null; prev.startStatus = 'off';
    }

    let tailActive = false;
    if (!baseActive) {
      const justEndedHeatOrCool = isRuntimeEvent && (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool');
      const fanExplicit = (equipmentStatus === 'fan' || isFanOnly);

      if (justEndedHeatOrCool && !fanExplicit && FAN_TAIL_MS > 0 && prev.tailUntil === 0) {
        prev.tailUntil = nowMs + FAN_TAIL_MS; log(`⏱️ TAIL scheduled → ${new Date(prev.tailUntil).toISOString()} (+${FAN_TAIL_MS}ms)`);
      }

      if (prev.tailUntil > 0 && nowMs < prev.tailUntil) {
        log(`🌀 TAIL active: remain 'fan' (${prev.tailUntil - nowMs}ms left)`);
        isHvacActive = true; equipmentStatus = 'fan'; isFanOnly = true; tailActive = true;
      } else if (prev.tailUntil > 0 && nowMs >= prev.tailUntil) {
        log('✓ TAIL expired'); prev.tailUntil = 0;
      }
    } else if (prev.tailUntil > 0) {
      log('✓ Cancel TAIL (equipment became active)'); prev.tailUntil = 0;
    }

    const fanExplicit = (equipmentStatus === 'fan' || isFanOnly) && input.hasFanTrait && (input.fanTimerMode === 'ON' || input.fanTimerOn === true);
    const becameActive = !prev.isRunning && isHvacActive && !(tailActive && !fanExplicit);

    if (becameActive) {
      log(`🟢 START: ${equipmentStatus}`);
      prev.isRunning = true; prev.startedAt = nowMs; prev.startStatus = equipmentStatus;
    }

    prev.lastTempC = isNum(input.currentTempC) ? input.currentTempC : prev.lastTempC;
    prev.lastAt = nowMs;
    prev.lastEquipmentStatus = equipmentStatus || prev.lastEquipmentStatus;
    prev.lastMode = input.thermostatMode || prev.lastMode;
    prev.lastReachable = isReachable;
    prev.lastRoom = input.roomDisplayName || prev.lastRoom;

    const hvacMode = hvacModeFromEquipment(equipmentStatus);
    const exportedActive = isHvacActive && !(tailActive && !fanExplicit);

    return {
      userId: input.userId || null,
      thermostatId: input.deviceId,
      deviceName: input.deviceName,
      roomDisplayName: input.roomDisplayName || '',
      timestampISO: now,
      thermostatMode: input.thermostatMode || 'OFF',
      hvacMode, equipmentStatus,
      isHvacActive: exportedActive,
      isFanOnly, isReachable,
      currentTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
      coolSetpointC: isNum(input.coolSetpointC) ? round2(input.coolSetpointC) : null,
      heatSetpointC: isNum(input.heatSetpointC) ? round2(input.heatSetpointC) : null,
      runtimeSeconds, isRuntimeEvent, endedStatus,
      startTempC: prev.isRunning && prev.startedAt ? prev.lastTempC : null,
      endTempC: isNum(input.currentTempC) ? round2(input.currentTempC) : null,
    };
  }

  toBubblePayload(result) {
    const c2f = (c) => (c == null ? null : Math.round((c * 9) / 5 + 32));
    const reportEquip = result.isRuntimeEvent && result.endedStatus ? result.endedStatus : result.equipmentStatus;
    const reportMode = hvacModeFromEquipment(reportEquip);

    return {
      userId: result.userId,
      thermostatId: result.thermostatId,
      deviceName: result.deviceName || '',
      roomDisplayName: result.roomDisplayName || '',
      runtimeSeconds: result.runtimeSeconds,
      runtimeMinutes: result.runtimeSeconds != null ? Math.round(result.runtimeSeconds / 60) : null,
      isRuntimeEvent: Boolean(result.isRuntimeEvent),
      hvacMode: reportMode,
      operatingState: reportEquip,
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
      lastIsCooling: reportEquip === 'cool',
      lastIsHeating: reportEquip === 'heat',
      lastIsFanOnly: reportEquip === 'fan',
      lastEquipmentStatus: reportEquip,
      equipmentStatus: reportEquip,
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
  const hasPrev = isNum(prevTempC);
  const trendingDown = hasPrev && hasCurrent ? (prevTempC - currentC > TREND_DELTA) : false;
  const trendingUp = hasPrev && hasCurrent ? (currentC - prevTempC > TREND_DELTA) : false;

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
    case 'fan': return 'FAN';
    default: return 'OFF';
  }
}
function pick(...vals) { for (const v of vals) if (v !== undefined && v !== null) return v; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function round2(n) { return Math.round(n * 100) / 100; }
function genUuid() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => ((c==='x')? (Math.random()*16|0) : ((Math.random()*16|0)&0x3|0x8)).toString(16)); }

/* ============================== EXPORTS ================================ */
module.exports = { SessionManager, parseSdmPushMessage, extractEffectiveTraits };
