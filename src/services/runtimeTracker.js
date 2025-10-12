'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToCoreIngestAsync } = require('./ingestPoster');
const { postToBubbleAsync } = require('./bubblePoster');
const { buildCorePayload } = require('./buildCorePayload');

// ================================
// In-memory device state
// ================================
const deviceStateMemory = new Map();

// =========================================
// Handle Nest device updates (core logic)
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
      payloadRaw: normalized,
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
// 🆕 handleDeviceEvent — public entrypoint for webhook.js
// =========================================
async function handleDeviceEvent(eventData) {
  try {
    const resource = eventData?.resourceUpdate || {};
    const traits = resource.traits || {};
    const hvac = traits['sdm.devices.traits.ThermostatHvac'] || {};
    const temp = traits['sdm.devices.traits.Temperature'] || {};
    const humidity = traits['sdm.devices.traits.Humidity'] || {};
    const deviceKey = eventData.deviceKey || resource.name?.split('/').pop();

    if (!deviceKey) {
      console.warn('[handleDeviceEvent] ⚠️ Missing deviceKey — skipping event');
      return;
    }

    const status = hvac.status || 'OFF';
    const isActive = status !== 'OFF' && status !== 'IDLE';
    const equipmentStatus = status.toUpperCase();

    const normalized = {
      deviceKey,
      userId: eventData.userId || 'unknown',
      deviceName: eventData.deviceName || 'Nest Thermostat',
      manufacturer: 'Google Nest',
      model: 'Nest Thermostat',
      serialNumber: null,
      tempF: temp.ambientTemperatureFahrenheit ?? null,
      humidity: humidity.ambientHumidityPercent ?? null,
      isActive,
      equipmentStatus,
      heatSetpoint: traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius ?? null,
      coolSetpoint: traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius ?? null,
    };

    console.log(
      `[handleDeviceEvent] ${deviceKey} → ${equipmentStatus} (${isActive ? 'ACTIVE' : 'IDLE'})`
    );

    // Reuse your existing logic
    await handleDeviceUpdate(normalized);

    // Post runtime event if HVAC changes
    if (equipmentStatus === 'OFF' || equipmentStatus === 'IDLE') {
      await handleRuntimeEvent({ deviceKey, eventType: 'HVAC_OFF' });
    } else if (isActive) {
      await handleRuntimeEvent({ deviceKey, eventType: 'HVAC_ON' });
    }

    // Optional dual post (state update already posts to Core)
    const bubblePayload = {
      userId: eventData.userId || 'unknown',
      thermostatId: deviceKey,
      currentTemperature: normalized.tempF,
      isActive,
      equipmentStatus,
    };
    await postToBubbleAsync(bubblePayload);
  } catch (err) {
    console.error('[handleDeviceEvent] ❌ Error:', err);
  }
}

// =========================================
// Unified export
// =========================================
module.exports = {
  handleDeviceEvent,
  handleDeviceUpdate,
  handleRuntimeEvent,
  recoverActiveSessions,
};
