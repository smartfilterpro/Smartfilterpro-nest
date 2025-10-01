'use strict';

/**
 * Session & inference logic for Nest SDM runtime tracking.
 * - Counts runtime while air is moving: HEATING, COOLING, HEATCOOL (auto), or explicit FAN-only
 * - Keeps a tail (default 30s) after heat/cool ends
 * - Sticky-state: carries forward last known values if missing
 * - Explicit OFF closes sessions immediately
 * - Timeout: force-close sessions if no OFF received (default 3m)
 * - Event batching: collects events within 2s window before processing
 */

const RECENT_WINDOW_MS   = 120_000; // 2 min sticky
const SESSION_TIMEOUT_MS = Number(process.env.NEST_SESSION_TIMEOUT_MS || 180000); // 3 min
const COOL_DELTA_ON   = 0.0;
const HEAT_DELTA_ON   = 0.0;
const TREND_DELTA     = 0.03;
const FAN_TAIL_MS     = Number(process.env.NEST_FAN_TAIL_MS || 30000); // default 30s
const EVENT_BATCH_MS  = 2000; // 2 second batching window

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

/* ---------------- Event Batching ---------------- */

class EventBatcher {
  constructor() {
    this.batches = new Map(); // deviceId -> { events: [], timer: timeout }
  }

  addEvent(deviceId, event, callback) {
    if (!this.batches.has(deviceId)) {
      this.batches.set(deviceId, { events: [], timer: null });
    }

    const batch = this.batches.get(deviceId);
    batch.events.push(event);

    // Clear existing timer
    if (batch.timer) {
      clearTimeout(batch.timer);
    }

    // Set new timer to process batch after delay
    batch.timer = setTimeout(() => {
      const events = batch.events;
      this.batches.delete(deviceId);
      
      // Merge all events into one with combined traits
      const merged = this.mergeEvents(events);
      console.log('[BATCH]', deviceId, 'processed', events.length, 'events');
      callback(merged);
    }, EVENT_BATCH_MS);
  }

  mergeEvents(events) {
    // Use the most recent timestamp
    const sortedByTime = events.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    
    const merged = { ...sortedByTime[sortedByTime.length - 1] };
    
    // Merge traits from all events, with later events overwriting earlier ones
    for (const evt of sortedByTime) {
      Object.assign(merged, evt);
    }
    
    return merged;
  }
}

/* ---------------- Sessions ---------------- */

class SessionManager {
  constructor() {
    this.byDevice = new Map();
    this.batcher = new EventBatcher();
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
        lastPostedState: null, // Track last posted state for deduplication
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

  // Public method that batches events
  queueEvent(input, callback) {
    this.batcher.addEvent(input.deviceId, input, (mergedInput) => {
      const result = this.process(mergedInput);
      callback(result);
    });
  }

  // Internal processing method
  process(input) {
    const prev = this.getPrev(input.deviceId);
    const nowMs = new Date(input.when).getTime();

    // Sticky only if hvacStatusRaw missing AND we have recent valid state
    const hasRecentState = prev.lastAt > 0 && (nowMs - prev.lastAt < RECENT_WINDOW_MS);
    
    if (input.currentTempC == null && prev.lastTempC != null && hasRecentState) {
      input.currentTempC = prev.lastTempC;
    }
    if (!input.thermostatMode && prev.lastMode && hasRecentState) {
      input.thermostatMode = prev.lastMode;
    }
    // Only apply sticky state for active equipment (heat/cool), not for 'off'
    if (!input.hvacStatusRaw && hasRecentState && (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool')) {
      input.hvacStatusRaw = prev.lastEquipmentStatus === 'heat' ? 'HEATING' : 'COOLING';
      console.log('[STICKY-STATE]', input.deviceId, 'inferred', input.hvacStatusRaw, 'from previous', prev.lastEquipmentStatus);
    }

    let { isReachable, isHvacActive, equipmentStatus, isFanOnly } =
      this.computeActiveAndStatus(input, prev);

    // Fan tail: Wait for fan to finish before calculating runtime
    // Don't extend isHvacActive, just delay the session close
    if (!isHvacActive && prev.isRunning) {
      const justStopped = (prev.lastEquipmentStatus === 'heat' || prev.lastEquipmentStatus === 'cool');
      if (justStopped && FAN_TAIL_MS > 0 && prev.tailUntil === 0) {
        prev.tailUntil = nowMs + FAN_TAIL_MS;
        console.log('[TAIL-START]', input.deviceId, 'fan running until', new Date(prev.tailUntil).toISOString());
      }
    }
    
    // Check if tail expired
    if (prev.tailUntil > 0 && nowMs >= prev.tailUntil) {
      console.log('[TAIL-EXPIRED]', input.deviceId, 'fan stopped, ending session');
      prev.tailUntil = 0;
      becameIdle = true; // Trigger session end now
    }
    
    // If still in tail period, don't end session yet
    if (prev.tailUntil > 0 && nowMs < prev.tailUntil) {
      console.log('[TAIL-WAITING]', input.deviceId, Math.round((prev.tailUntil - nowMs) / 1000), 'seconds remaining');
      becameIdle = false; // Prevent session from ending
    }
    
    // Clear tail if HVAC becomes active again
    if (isHvacActive && prev.tailUntil > 0) {
      console.log('[TAIL-CLEAR]', input.deviceId, 'HVAC active again');
      prev.tailUntil = 0;
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
    let becameIdle = prev.isRunning && !isHvacActive;

    if (becameActive) {
      console.log('[SESSION START]', input.deviceId, 'equipment:', equipmentStatus);
      prev.isRunning = true;
      prev.startedAt = nowMs;
      prev.startStatus = equipmentStatus;
      prev.tailUntil = 0;
    }

    let runtimeSeconds = null;
    let isRuntimeEvent = false;

    // Explicit OFF closes immediately and clears tail
    if (input.hvacStatusRaw === 'OFF') {
      if (prev.isRunning && prev.startedAt) {
        const ms = Math.max(0, nowMs - prev.startedAt);
        runtimeSeconds = Math.round(ms / 1000);
        isRuntimeEvent = true;
        console.log('[SESSION END - EXPLICIT OFF]', input.deviceId, 'runtime', runtimeSeconds);
        prev.isRunning = false;
        prev.startedAt = null;
        prev.startStatus = 'off';
      }
      // Clear tail and force inactive state when explicit OFF received
      prev.tailUntil = 0;
      prev.lastEquipmentStatus = 'off';
      isHvacActive = false;
      equipmentStatus = 'off';
      console.log('[EXPLICIT-OFF]', input.deviceId, 'forced inactive, cleared tail');
    }
    // Normal idle transition
    else if (becameIdle && prev.startedAt) {
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

    // Determine if this should be posted to Bubble
    result.shouldPost = this.shouldPostToBubble(result, prev);

    console.log('[STATE]', {
      thermo: input.deviceId,
      mode: input.thermostatMode,
      hvacStatusRaw: input.hvacStatusRaw,
      active: isHvacActive,
      equip: equipmentStatus,
      runtimeSeconds,
      shouldPost: result.shouldPost,
      eventTime: input.when,
    });

    return result;
  }

  shouldPostToBubble(result, prev) {
    // Always post runtime events
    if (result.isRuntimeEvent) {
      console.log('[POST-REASON]', result.thermostatId, 'runtime event');
      return true;
    }

    const last = prev.lastPostedState;
    
    // First event for this device
    if (!last) {
      console.log('[POST-REASON]', result.thermostatId, 'first event');
      prev.lastPostedState = this.captureState(result);
      return true;
    }

    // HVAC active state changed
    if (result.isHvacActive !== last.isHvacActive) {
      console.log('[POST-REASON]', result.thermostatId, 'active state changed:', last.isHvacActive, '→', result.isHvacActive);
      prev.lastPostedState = this.captureState(result);
      return true;
    }

    // Equipment status changed (heat/cool/fan/off)
    if (result.equipmentStatus !== last.equipmentStatus) {
      console.log('[POST-REASON]', result.thermostatId, 'equipment changed:', last.equipmentStatus, '→', result.equipmentStatus);
      prev.lastPostedState = this.captureState(result);
      return true;
    }

    // Thermostat mode changed (HEAT/COOL/HEATCOOL/OFF)
    if (result.thermostatMode !== last.thermostatMode) {
      console.log('[POST-REASON]', result.thermostatId, 'mode changed:', last.thermostatMode, '→', result.thermostatMode);
      prev.lastPostedState = this.captureState(result);
      return true;
    }

    // Indoor temperature changed (rounded to 0.1°C to avoid noise)
    const tempChanged = result.currentTempC != null && last.currentTempC != null &&
      Math.abs(result.currentTempC - last.currentTempC) >= 0.1;
    if (tempChanged) {
      console.log('[POST-REASON]', result.thermostatId, 'temp changed:', last.currentTempC, '→', result.currentTempC);
      prev.lastPostedState = this.captureState(result);
      return true;
    }

    console.log('[POST-SKIP]', result.thermostatId, 'no significant change');
    return false;
  }

  captureState(result) {
    return {
      isHvacActive: result.isHvacActive,
      equipmentStatus: result.equipmentStatus,
      thermostatMode: result.thermostatMode,
      currentTempC: result.currentTempC,
    };
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
      shouldPost: true, // Timeout events should always post
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
