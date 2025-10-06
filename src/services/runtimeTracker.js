'use strict';

/**
 * SmartFilterPro – Nest Runtime Tracker
 * -------------------------------------
 * Tracks HVAC runtime sessions, posts updates to Bubble and Core Ingest.
 * Includes DB fallbacks, fan-tail logic, and respects useForcedAirForHeat.
 */

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

// In-memory tracking of active devices
const activeDevices = new Map();

/**
 * Called when Nest webhook event arrives
 */
async function handleDeviceEvent(eventData) {
  const pool = getPool();

  try {
    const { resourceUpdate, userId, deviceName, deviceKey } = eventData;
    const traits = resourceUpdate?.traits || {};
    const heatSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius || null;
    const coolSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius || null;

    const thermostatMode = traits['sdm.devices.traits.ThermostatMode']?.mode ?? null;
    let equipmentStatus = traits['sdm.devices.traits.ThermostatHvac']?.status ?? null;
    let isFanTimerOn = traits['sdm.devices.traits.Fan']?.timerMode === 'ON' ? true : null;

    // 🧠 Fallbacks for temperature-only events
    if (equipmentStatus === null || isFanTimerOn === null) {
      const r = await pool.query(
        `SELECT current_equipment_status, last_fan_status FROM device_status WHERE device_key=$1`,
        [deviceKey]
      );
      if (r.rows.length) {
        if (equipmentStatus === null) equipmentStatus = r.rows[0].current_equipment_status || 'OFF';
        if (isFanTimerOn === null) isFanTimerOn = r.rows[0].last_fan_status === 'ON';
      } else {
        equipmentStatus = equipmentStatus ?? 'OFF';
        isFanTimerOn = isFanTimerOn ?? false;
      }
    }

    // 🧩 Persist latest statuses for next fallback
    await pool.query(
      `UPDATE device_status
       SET current_equipment_status=$2, last_fan_status=$3, updated_at=NOW()
       WHERE device_key=$1`,
      [deviceKey, equipmentStatus, isFanTimerOn ? 'ON' : 'OFF']
    );

    await processRuntimeLogic(
      deviceKey,
      userId,
      deviceName,
      equipmentStatus,
      isFanTimerOn,
      thermostatMode,
      heatSetpoint,
      coolSetpoint
    );
  } catch (err) {
    console.error('[runtimeTracker] handleDeviceEvent error:', err);
  }
}

/**
 * Core runtime logic determining state transitions
 */
async function processRuntimeLogic(
  deviceKey,
  userId,
  deviceName,
  equipmentStatus,
  isFanTimerOn,
  thermostatMode,
  heatSetpoint,
  coolSetpoint
) {
  const useForcedAirForHeat = await getUseForcedAirForHeat(deviceKey);

  const isHeating = equipmentStatus === 'HEATING' && useForcedAirForHeat;
  const isCooling = equipmentStatus === 'COOLING';
  const shouldBeActive = isHeating || isCooling || isFanTimerOn;

  const currentState = activeDevices.get(deviceKey);

  if (!currentState && shouldBeActive) {
    await startRuntimeSession(
      deviceKey,
      userId,
      deviceName,
      equipmentStatus,
      isFanTimerOn,
      thermostatMode,
      heatSetpoint,
      coolSetpoint
    );
  } else if (currentState && !shouldBeActive) {
    await stopRuntimeSession(deviceKey, userId, deviceName, equipmentStatus);
  } else if (currentState && shouldBeActive) {
    // Continue active session: temperature change / periodic update
    await handleTemperatureChange(deviceKey, null, null, userId);
  }
}

/**
 * Start of runtime session
 */
async function startRuntimeSession(deviceKey, userId, deviceName, equipmentStatus, isFanTimerOn, thermostatMode, heatSetpoint, coolSetpoint) {
  const now = new Date();
  const startTemp = await getCurrentTemp(deviceKey);
  const sessionId = uuidv4();

  const state = {
    sessionId,
    startedAt: now,
    isCooling: equipmentStatus === 'COOLING',
    isHeating: equipmentStatus === 'HEATING',
    isFanOnly: isFanTimerOn,
    currentEquipmentStatus: equipmentStatus,
  };

  activeDevices.set(deviceKey, state);

  const payload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds: 0,
    currentTemperature: startTemp,
    isActive: true,
    deviceName,
    mode: thermostatMode,
  };

  // 🔁 Bubble payload (restored last* fields)
  postToBubbleAsync({
    ...payload,
    lastIsCooling: false,
    lastIsHeating: false,
    lastIsFanOnly: false,
    lastEquipmentStatus: 'off',
    equipmentStatus: (equipmentStatus || 'OFF').toLowerCase(),
    isFanOnly: isFanTimerOn,
  });

  // 🌐 Core payload
  postToCoreIngestAsync({
    device_id: deviceKey,
    event_type: deriveEventType(equipmentStatus, isFanTimerOn, true),
    is_active: true,
    equipment_status: equipmentStatus,
    temperature_f: startTemp,
    temperature_c: startTemp != null ? ((startTemp - 32) * 5 / 9).toFixed(2) : null,
    runtime_seconds: 0,
    timestamp: now.toISOString(),
    current_temp: startTemp,
  });

  console.log(`[runtimeTracker] Session started for ${deviceName} (${deviceKey})`);
}

/**
 * Stop of runtime session
 */
async function stopRuntimeSession(deviceKey, userId, deviceName, finalStatus) {
  const state = activeDevices.get(deviceKey);
  if (!state) return;

  const now = new Date();
  const runtimeSeconds = Math.floor((now - new Date(state.startedAt)) / 1000);

  activeDevices.delete(deviceKey);

  const payload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds,
    currentTemperature: null,
    isActive: false,
    deviceName,
  };

  // Restore last* flags for Bubble UI
  const lastWasCooling = !!state.isCooling;
  const lastWasHeating = !!state.isHeating;
  const lastWasFanOnly = !!state.isFanOnly && !state.isHeating && !state.isCooling;

  postToBubbleAsync({
    ...payload,
    lastIsCooling: lastWasCooling,
    lastIsHeating: lastWasHeating,
    lastIsFanOnly: lastWasFanOnly,
    lastEquipmentStatus: (state.currentEquipmentStatus || 'OFF').toLowerCase(),
    equipmentStatus: (finalStatus || 'OFF').toLowerCase(),
    isFanOnly: false,
  });

  postToCoreIngestAsync({
    device_id: deviceKey,
    event_type: 'SESSION_END',
    is_active: false,
    equipment_status: finalStatus,
    temperature_f: null,
    temperature_c: null,
    runtime_seconds: runtimeSeconds,
    timestamp: now.toISOString(),
    current_temp: null,
  });

  console.log(`[runtimeTracker] Session ended for ${deviceName} (${deviceKey}) runtime=${runtimeSeconds}s`);
}

/**
 * Temperature update (while idle or active)
 */
async function handleTemperatureChange(deviceKey, tempF, tempC, userId) {
  const deviceState = activeDevices.get(deviceKey);
  const pool = getPool();

  // if no explicit temp provided, try DB
  const temp = tempF ?? (await getCurrentTemp(deviceKey));
  const tempCelsius = tempC ?? (temp != null ? ((temp - 32) * 5) / 9 : null);

  const payload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds: null,
    currentTemperature: temp,
    isActive: !!deviceState,
  };

  // Bubble
  postToBubbleAsync({
    ...payload,
    equipmentStatus: (deviceState?.currentEquipmentStatus || 'OFF').toLowerCase(),
    lastIsCooling: false,
    lastIsHeating: false,
    lastIsFanOnly: false,
    lastEquipmentStatus: (deviceState?.currentEquipmentStatus || 'OFF').toLowerCase(),
    currentTempC: tempCelsius,
  });

  // Core
  postToCoreIngestAsync({
    device_id: deviceKey,
    event_type: 'TEMP',
    is_active: !!deviceState,
    equipment_status: deviceState?.currentEquipmentStatus || 'OFF',
    temperature_f: temp,
    temperature_c: tempCelsius,
    runtime_seconds: null,
    timestamp: new Date().toISOString(),
    current_temp: temp,
  });
}

/**
 * Derives a concise event type label
 */
function deriveEventType(equipmentStatus, isFanTimerOn, isStart) {
  if (equipmentStatus === 'HEATING') return isStart ? 'HEAT_ON' : 'HEAT';
  if (equipmentStatus === 'COOLING') return isStart ? 'COOL_ON' : 'COOL';
  if (isFanTimerOn) return isStart ? 'FAN_ON' : 'FAN';
  return 'IDLE';
}

/**
 * Fetch latest temperature (°F) from DB
 */
async function getCurrentTemp(deviceKey) {
  const pool = getPool();
  try {
    const r = await pool.query(
      `SELECT current_temp_f FROM device_status WHERE device_key=$1`,
      [deviceKey]
    );
    return r.rows.length ? r.rows[0].current_temp_f : null;
  } catch {
    return null;
  }
}

/**
 * Pulls the Bubble-configured preference for forced-air heating
 */
async function getUseForcedAirForHeat(deviceKey) {
  const pool = getPool();
  try {
    const r = await pool.query(
      `SELECT use_forced_air_for_heat FROM device_status WHERE device_key=$1`,
      [deviceKey]
    );
    if (!r.rows.length) return true;
    const v = r.rows[0]?.use_forced_air_for_heat;
    return (v === null || v === undefined) ? true : !!v;
  } catch {
    return true;
  }
}

/**
 * Recovers sessions from DB after restart (optional, if you persist state)
 */
async function recoverActiveSessions() {
  const pool = getPool();
  try {
    const result = await pool.query(`
      SELECT device_key, device_name, is_running, started_at
      FROM device_status
      WHERE is_running = TRUE
    `);
    result.rows.forEach((r) => {
      activeDevices.set(r.device_key, {
        sessionId: uuidv4(),
        startedAt: r.started_at,
        isCooling: false,
        isHeating: false,
        isFanOnly: false,
        currentEquipmentStatus: 'OFF',
      });
    });
    console.log(`[runtimeTracker] Recovered ${result.rows.length} active sessions`);
  } catch (err) {
    console.error('[runtimeTracker] recoverActiveSessions error:', err);
  }
}

module.exports = {
  handleDeviceEvent,
  recoverActiveSessions,
};
