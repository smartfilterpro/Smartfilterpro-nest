'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');
const { buildCorePayload } = require('./buildCorePayload');

// ===========================
// In-memory active sessions
// ===========================
const activeDevices = new Map();

// ===========================
// Persistent state memory (for partial webhooks)
// ===========================
const deviceStateMemory = new Map();

// ===========================
// Utility helpers
// ===========================
function fToC(f) {
  if (typeof f !== 'number') return null;
  return Math.round(((f - 32) * 5 / 9) * 100) / 100;
}

// ===========================
// Session helpers
// ===========================
function startSession(deviceKey, data) {
  const now = new Date();
  activeDevices.set(deviceKey, {
    ...data,
    startTime: now,
    lastTempF: data.temperatureF,
    lastHumidity: data.humidity ?? null,
  });
}

function endSession(deviceKey) {
  const sess = activeDevices.get(deviceKey);
  if (!sess) return null;
  const endTime = new Date();
  const runtimeSeconds = Math.round((endTime - sess.startTime) / 1000);
  activeDevices.delete(deviceKey);
  return runtimeSeconds;
}

// ===========================
// Core + Bubble posting logic
// ===========================
async function handleDeviceUpdate(normalized) {
  const {
    userId,
    thermostatId,
    deviceName,
    isActive,
    currentTemperature,
    currentHumidity,
    eventType,
    equipmentStatus,
    heatSetpoint,
    coolSetpoint,
    manufacturer,
    model,
    serialNumber,
    firmwareVersion,
    timezone,
    zipPrefix,
  } = normalized;

  const deviceKey = thermostatId;
  const now = new Date();

  // ---- Initialize state memory ----
  const prevState = deviceStateMemory.get(deviceKey) || {
    lastTempF: null,
    lastHumidity: null,
    lastIsActive: null,
    lastEquipStatus: null,
    lastPostTempAt: 0,
  };

  const tempF = typeof currentTemperature === 'number' ? currentTemperature : prevState.lastTempF;
  const humidity = typeof currentHumidity === 'number' ? currentHumidity : prevState.lastHumidity;

  const tempChanged = Math.abs((tempF ?? 0) - (prevState.lastTempF ?? 0)) >= 0.5; // only post if Δ ≥ 0.5°F
  const humidChanged = Math.abs((humidity ?? 0) - (prevState.lastHumidity ?? 0)) >= 2;
  const nowMs = now.getTime();
  const elapsedMs = nowMs - (prevState.lastPostTempAt || 0);
  const enoughTimeElapsed = elapsedMs > 5 * 60 * 1000; // 5 minutes min interval

  const activeStateChanged = prevState.lastIsActive !== isActive;
  const equipChanged = prevState.lastEquipStatus !== equipmentStatus;

  const shouldPostTempUpdate =
    (!isActive && (tempChanged || humidChanged) && enoughTimeElapsed);

  // --- always forward to Bubble
  await postToBubbleAsync({
    userId,
    thermostatId,
    runtimeSeconds: isActive ? null : 0,
    currentTemperature: tempF,
    isActive,
  });

  // --- handle active transitions
  if (activeStateChanged || equipChanged) {
    if (isActive) {
      // Session start
      startSession(deviceKey, { temperatureF: tempF, humidity });
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
        eventType: `${equipmentStatus || 'UNKNOWN'}_START`,
        equipmentStatus: equipmentStatus || 'OFF',
        previousStatus: prevState.lastEquipStatus || 'OFF',
        isActive: true,
        mode: equipmentStatus === 'COOLING' ? 'cooling' :
              equipmentStatus === 'HEATING' ? 'heating' : 'fanonly',
        runtimeSeconds: null,
        temperatureF: tempF,
        humidity,
        heatSetpoint,
        coolSetpoint,
        observedAt: now,
        sourceEventId: uuidv4(),
        payloadRaw: normalized
      });
      await postToCoreIngestAsync(payload, 'session-start');
    } else {
      // Session end
      const runtimeSeconds = endSession(deviceKey);
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
        eventType: 'STATUS_CHANGE',
        equipmentStatus: 'OFF',
        previousStatus: prevState.lastEquipStatus || 'UNKNOWN',
        isActive: false,
        mode: 'off',
        runtimeSeconds,
        temperatureF: tempF,
        humidity,
        heatSetpoint,
        coolSetpoint,
        observedAt: now,
        sourceEventId: uuidv4(),
        payloadRaw: normalized
      });
      await postToCoreIngestAsync(payload, 'session-end');
    }
  }

  // --- handle idle telemetry update (temp/humidity only)
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
} // <-- closes handleDeviceUpdate function

// =========================================
// Recovery stub for startup
// =========================================
async function recoverActiveSessions() {
  console.log("[runtimeTracker] ⚠️ Skipping active session recovery (not implemented)");
  return;
}

// =========================================
// Unified export
// =========================================
module.exports = {
  handleDeviceUpdate,
  handleRuntimeEvent,
  recoverActiveSessions
};
