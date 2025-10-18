'use strict';
const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToCoreIngestAsync } = require('./ingestPoster');
const { buildCorePayload } = require('./buildCorePayload');

// ================================
// In-memory device state
// ================================
const deviceStateMemory = new Map();

// ================================
// Reachability check
// ================================
function checkDeviceReachability(prevState, nowMs) {
  // If we've never seen an event, assume reachable
  if (!prevState.lastEventTime) return true;
  
  // If event is more than 2 hours old, mark as unreachable
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const timeSinceLastEvent = nowMs - prevState.lastEventTime;
  
  if (timeSinceLastEvent > TWO_HOURS_MS) {
    return false;
  }
  
  return true;
}

// =========================================
// Handle Nest device updates
// =========================================
async function handleDeviceUpdate(normalized) {
  const {
    deviceKey,
    userId,
    deviceName,
    manufacturer,
    model,
    serialNumber,
    tempF,
    humidity,
    isActive,
    equipmentStatus,
    heatSetpoint,
    coolSetpoint,
    outdoorTemperatureF,      // ✅ ADD
    outdoorHumidity,          // ✅ ADD
    pressureHpa,              // ✅ ADD
    thermostatMode,           // ✅ ADD
    isReachable,              // ✅ ADD (explicit from Nest API if available)
  } = normalized;

  const now = new Date();
  const nowMs = now.getTime();

  const prevState = deviceStateMemory.get(deviceKey) || {
    lastEventTime: null,
    lastTempF: null,
    lastHumidity: null,
    lastIsActive: false,
    lastEquipStatus: 'OFF',
    lastPostTempAt: null,
    isReachable: true,
  };

  // ✅ Check reachability
  const calculatedReachable = checkDeviceReachability(prevState, nowMs);
  const finalReachable = isReachable !== undefined ? isReachable : calculatedReachable;
  
  // ✅ Log reachability changes
  if (prevState.isReachable !== finalReachable) {
    console.log(`[Nest] Device ${deviceKey} reachability changed: ${prevState.isReachable} -> ${finalReachable}`);
  }

  const MIN_TEMP_DELTA = 0.5; // °F
  const MIN_TIME_DELTA_MS = 15 * 60 * 1000; // 15 min

  const tempChanged =
    typeof tempF === 'number' &&
    typeof prevState.lastTempF === 'number' &&
    Math.abs(tempF - prevState.lastTempF) >= MIN_TEMP_DELTA;

  const timeExceeded =
    !prevState.lastPostTempAt || nowMs - prevState.lastPostTempAt >= MIN_TIME_DELTA_MS;

  const shouldPostTempUpdate = tempChanged || timeExceeded;

  // --- post temperature update while idle or if reachability changed
  if (shouldPostTempUpdate || prevState.isReachable !== finalReachable) {
    const payload = buildCorePayload({
      deviceKey,
      userId,
      deviceName,
      manufacturer,
      model,
      serialNumber,
      connectionSource: 'nest',
      source: 'nest',
      sourceVendor: 'nest',
      eventType: prevState.isReachable !== finalReachable ? 'CONNECTIVITY_CHANGE' : 'Telemetry_Update',  // ✅ CHANGED
      equipmentStatus: equipmentStatus || 'OFF',
      previousStatus: prevState.lastEquipStatus || 'UNKNOWN',
      isActive: isActive || false,
      isReachable: finalReachable,  // ✅ ADD
      mode: thermostatMode || 'off',  // ✅ CHANGED
      thermostatMode: thermostatMode || null,  // ✅ ADD
      runtimeSeconds: null,
      runtimeType: 'UPDATE',  // ✅ ADD
      temperatureF: tempF,
      humidity,
      heatSetpoint,
      coolSetpoint,
      outdoorTemperatureF,  // ✅ ADD
      outdoorHumidity,      // ✅ ADD
      pressureHpa,          // ✅ ADD
      observedAt: now,
      sourceEventId: uuidv4(),
      payloadRaw: normalized
    });

    await postToCoreIngestAsync(payload, prevState.isReachable !== finalReachable ? 'connectivity-change' : 'telemetry-update');
  }

  // --- persist latest state
  deviceStateMemory.set(deviceKey, {
    lastTempF: tempF,
    lastHumidity: humidity,
    lastIsActive: isActive,
    lastEquipStatus: equipmentStatus,
    lastPostTempAt: shouldPostTempUpdate ? nowMs : prevState.lastPostTempAt,
    lastEventTime: nowMs,  // ✅ ADD
    isReachable: finalReachable,  // ✅ ADD
  });
}

// =========================================
// Stub for runtime events (session tracking)
// =========================================
async function handleRuntimeEvent(event) {
  console.log('[runtimeTracker] handleRuntimeEvent called (stub)', event?.deviceKey);
  // You can extend this to process session-based runtime later.
}

// =========================================
// Recovery stub for startup
// =========================================
async function recoverActiveSessions() {
  console.log('[runtimeTracker] ⚠️ Skipping active session recovery (not implemented)');
  return;
}

// =========================================
// Unified export
// =========================================
module.exports = {
  handleDeviceEvent: handleDeviceUpdate, // ✅ Alias so webhook.js works
  handleDeviceUpdate,
  handleRuntimeEvent,
  recoverActiveSessions,
};
