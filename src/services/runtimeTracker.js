'use strict';

/**
 * SmartFilterPro — Nest Runtime Tracker (Restored Bubble Schema + Last-State Tracking)
 */

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

const activeDevices = new Map();

/**
 * Main event handler from Nest SDM webhooks
 */
async function handleDeviceEvent(eventData) {
  const pool = getPool();

  try {
    const { resourceUpdate, userId, deviceName, deviceKey } = eventData;
    const traits = resourceUpdate?.traits || {};

    const heatSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius ?? null;
    const coolSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius ?? null;
    const thermostatMode = traits['sdm.devices.traits.ThermostatMode']?.mode ?? null;
    let equipmentStatus = traits['sdm.devices.traits.ThermostatHvac']?.status ?? null;
    let isFanTimerOn = traits['sdm.devices.traits.Fan']?.timerMode === 'ON' ? true : false;

    // 🧩 Get last known values for transition detection
    const last = await pool.query(`
      SELECT last_mode, last_is_cooling, last_is_heating, last_is_fan_only, last_equipment_status
      FROM device_status
      WHERE device_key = $1
    `, [deviceKey]);

    const clean = {
      lastMode: last.rows[0]?.last_mode || 'OFF',
      lastIsCooling: last.rows[0]?.last_is_cooling || false,
      lastIsHeating: last.rows[0]?.last_is_heating || false,
      lastIsFanOnly: last.rows[0]?.last_is_fan_only || false,
      lastEquipmentStatus: last.rows[0]?.last_equipment_status || 'OFF'
    };

    // Fallback for missing traits
    if (!equipmentStatus) equipmentStatus = clean.lastEquipmentStatus || 'OFF';

    // 🧠 Save current mode for next event
    await pool.query(`
      UPDATE device_status
      SET
        last_mode = $2,
        last_is_cooling = $3,
        last_is_heating = $4,
        last_is_fan_only = $5,
        last_equipment_status = $6,
        updated_at = NOW()
      WHERE device_key = $1
    `, [
      deviceKey,
      thermostatMode || clean.lastMode,
      equipmentStatus === 'COOLING',
      equipmentStatus === 'HEATING',
      isFanTimerOn,
      equipmentStatus
    ]);

    await processRuntimeLogic(
      deviceKey,
      userId,
      deviceName,
      equipmentStatus,
      isFanTimerOn,
      thermostatMode,
      heatSetpoint,
      coolSetpoint,
      clean
    );
  } catch (err) {
    console.error('[runtimeTracker] handleDeviceEvent error:', err);
  }
}

/**
 * Runtime logic controlling state transitions
 */
async function processRuntimeLogic(deviceKey, userId, deviceName, equipmentStatus, isFanTimerOn, thermostatMode, heatSetpoint, coolSetpoint, clean) {
  const pool = getPool();
  const state = activeDevices.get(deviceKey);
  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isFan = isFanTimerOn === true;
  const shouldBeActive = isHeating || isCooling || isFan;

  if (!state && shouldBeActive) {
    await startRuntimeSession(deviceKey, userId, deviceName, equipmentStatus);
  } else if (state && !shouldBeActive) {
    await stopRuntimeSession(deviceKey, userId, deviceName, equipmentStatus);
  } else if (state && shouldBeActive) {
    await handleTemperatureChange(deviceKey, userId);
  }
}

/**
 * Start runtime session
 */
async function startRuntimeSession(deviceKey, userId, deviceName, equipmentStatus) {
  const now = new Date();
  const sessionId = uuidv4();

  activeDevices.set(deviceKey, {
    sessionId,
    startedAt: now,
    currentEquipmentStatus: equipmentStatus,
  });

  const corePayload = {
    device_id: deviceKey,
    event_type: `${equipmentStatus}_ON`,
    is_active: true,
    equipment_status: equipmentStatus,
    runtime_seconds: 0,
    timestamp: now.toISOString(),
  };

  const bubblePayload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds: 0,
    currentTemperature: null,
    isActive: true,
  };

  console.log('📤 CORE POST:', JSON.stringify(corePayload, null, 2));
  console.log('📤 BUBBLE POST:', JSON.stringify(bubblePayload, null, 2));

  postToCoreIngestAsync(corePayload);
  postToBubbleAsync(bubblePayload);

  console.log(`[runtimeTracker] ▶️ Session started for ${deviceName} (${deviceKey})`);
}

/**
 * Stop runtime session
 */
async function stopRuntimeSession(deviceKey, userId, deviceName, finalStatus) {
  const state = activeDevices.get(deviceKey);
  if (!state) return;

  const now = new Date();
  const runtimeSeconds = Math.floor((now - new Date(state.startedAt)) / 1000);
  activeDevices.delete(deviceKey);

  const corePayload = {
    device_id: deviceKey,
    event_type: 'SESSION_END',
    is_active: false,
    equipment_status: finalStatus,
    runtime_seconds: runtimeSeconds,
    timestamp: now.toISOString(),
  };

  const bubblePayload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds,
    currentTemperature: null,
    isActive: false,
  };

  console.log('📤 CORE POST:', JSON.stringify(corePayload, null, 2));
  console.log('📤 BUBBLE POST:', JSON.stringify(bubblePayload, null, 2));

  postToCoreIngestAsync(corePayload);
  postToBubbleAsync(bubblePayload);

  console.log(`[runtimeTracker] ⏹️ Session ended for ${deviceName} (${deviceKey}) after ${runtimeSeconds}s`);
}

/**
 * Temperature-only updates (still forward to Bubble + Core)
 */
async function handleTemperatureChange(deviceKey, userId) {
  const isActive = !!activeDevices.get(deviceKey);
  const corePayload = {
    device_id: deviceKey,
    event_type: 'TEMP',
    is_active: isActive,
    runtime_seconds: null,
    timestamp: new Date().toISOString(),
  };

  const bubblePayload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds: null,
    currentTemperature: null,
    isActive,
  };

  console.log('📤 CORE POST:', JSON.stringify(corePayload, null, 2));
  console.log('📤 BUBBLE POST:', JSON.stringify(bubblePayload, null, 2));

  postToCoreIngestAsync(corePayload);
  postToBubbleAsync(bubblePayload);
}

/**
 * Recovery stub (not using session persistence)
 */
async function recoverActiveSessions() {
  console.log('[runtimeTracker] Skipping recovery — device_status has no session columns.');
}

module.exports = { handleDeviceEvent, recoverActiveSessions };
