'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToCoreIngestAsync } = require('./ingestPoster');
const { buildCorePayload } = require('./buildCorePayload');

// ================================
// In-memory device state
// ================================
const deviceStateMemory = new Map();

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
  } = normalized;

  const now = new Date();
  const nowMs = now.getTime();
  const prevState = deviceStateMemory.get(deviceKey) || {};

  const MIN_TEMP_DELTA = 0.5; // °F
  const MIN_TIME_DELTA_MS = 15 * 60 * 1000; // 15 min

  const tempChanged =
    typeof tempF === 'number' &&
    typeof prevState.lastTempF === 'number' &&
    Math.abs(tempF - prevState.lastTempF) >= MIN_TEMP_DELTA;

  const timeExceeded =
    !prevState.lastPostTempAt || nowMs - prevState.lastPostTempAt >= MIN_TIME_DELTA_MS;

  const shouldPostTempUpdate = tempChanged || timeExceeded;

  // --- post temperature update while idle
  if (shouldPostTempUpdate) {
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
      eventType: 'STATE_UPDATE',
      equipmentStatus: equipmentStatus || 'OFF',
      previousStatus: prevState.lastEquipStatus || 'UNKNOWN',
      isActive: false,
      mode: 'off',
      runtimeSeconds: null,
      temperatureF: tempF,
      humidity,
      heatSetpoint,
      coolSetpoint,
      observedAt: now,
      sourceEventId: uuidv4(),
      payloadRaw: normalized
    });

    await postToCoreIngestAsync(payload, 'state-update');
  }

  // --- persist latest state
  deviceStateMemory.set(deviceKey, {
    lastTempF: tempF,
    lastHumidity: humidity,
    lastIsActive: isActive,
    lastEquipStatus: equipmentStatus,
    lastPostTempAt: shouldPostTempUpdate ? nowMs : prevState.lastPostTempAt,
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
