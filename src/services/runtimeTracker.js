'use strict';

/**
 * SmartFilterPro — Nest Runtime Tracker
 * -------------------------------------
 * Tracks HVAC runtime sessions, dual-posts updates to Bubble and Core Ingest,
 * keeps last_* state tracking in device_status, and includes detailed debug logs.
 */

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

const activeDevices = new Map();

/**
 * Handle an SDM device event
 */
async function handleDeviceEvent(eventData) {
  const pool = getPool();

  try {
    const { resourceUpdate, userId } = eventData;
    const deviceName = resourceUpdate?.name || '';
    const traits = resourceUpdate?.traits || {};
    const deviceKey = deviceName.split('/').pop();

    // Extract thermostat state
    const heatSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius ?? null;
    const coolSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius ?? null;
    const thermostatMode = traits['sdm.devices.traits.ThermostatMode']?.mode ?? null;
    let equipmentStatus = traits['sdm.devices.traits.ThermostatHvac']?.status ?? null;
    const fanTrait = traits['sdm.devices.traits.Fan'];
    let isFanTimerOn = fanTrait?.timerMode === 'ON';

    // Fallbacks for partial events
    const r = await pool.query(
      `SELECT 
         current_equipment_status,
         last_fan_status,
         last_mode,
         last_is_cooling,
         last_is_heating,
         last_is_fan_only,
         last_equipment_status
       FROM device_status
       WHERE device_key = $1`,
      [deviceKey]
    );

    if (r.rows.length) {
      const last = r.rows[0];
      equipmentStatus = equipmentStatus ?? last.current_equipment_status ?? 'OFF';
      if (isFanTimerOn === undefined || isFanTimerOn === null)
        isFanTimerOn = last.last_fan_status === 'ON';
    } else {
      equipmentStatus = equipmentStatus ?? 'OFF';
      isFanTimerOn = isFanTimerOn ?? false;
    }

    // Update last known states
    await pool.query(
      `UPDATE device_status
       SET 
         current_equipment_status = $2,
         last_fan_status = $3,
         last_mode = $4,
         last_is_cooling = $5,
         last_is_heating = $6,
         last_is_fan_only = $7,
         last_equipment_status = $8,
         updated_at = NOW()
       WHERE device_key = $1`,
      [
        deviceKey,
        equipmentStatus,
        isFanTimerOn ? 'ON' : 'OFF',
        thermostatMode,
        equipmentStatus === 'COOLING',
        equipmentStatus === 'HEATING',
        isFanTimerOn,
        equipmentStatus,
      ]
    );

    await processRuntimeLogic(
      deviceKey,
      userId,
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
 * Runtime logic controlling start/stop/temp events
 */
async function processRuntimeLogic(
  deviceKey,
  userId,
  equipmentStatus,
  isFanTimerOn,
  thermostatMode,
  heatSetpoint,
  coolSetpoint
) {
  const pool = getPool();
  const state = activeDevices.get(deviceKey);

  const useForcedAirForHeat = await getUseForcedAirForHeat(deviceKey);
  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isFan = isFanTimerOn === true;
  const shouldBeActive = isHeating || isCooling || isFan;

  if (!state && shouldBeActive) {
    await startRuntimeSession(deviceKey, userId, equipmentStatus, isFanTimerOn, thermostatMode);
  } else if (state && !shouldBeActive) {
    await stopRuntimeSession(deviceKey, userId, equipmentStatus);
  } else if (state && shouldBeActive) {
    await handleTemperatureChange(deviceKey, userId);
  }

  // Ignore heating runtime if user disabled forced-air
  if (isHeating && !useForcedAirForHeat) {
    console.log(`[runtimeTracker] ⚠️ Ignoring HEAT runtime for ${deviceKey} (forcedAirForHeat=false)`);
  }
}

/**
 * Start runtime session
 */
async function startRuntimeSession(deviceKey, userId, equipmentStatus, isFanTimerOn, thermostatMode) {
  const now = new Date();
  const startTemp = await getCurrentTemp(deviceKey);
  const sessionId = uuidv4();

  activeDevices.set(deviceKey, {
    sessionId,
    startedAt: now,
    isCooling: equipmentStatus === 'COOLING',
    isHeating: equipmentStatus === 'HEATING',
    isFanOnly: isFanTimerOn,
    currentEquipmentStatus: equipmentStatus,
  });

  const runtimeSeconds = 0;
  const isActive = true;
  const currentTemp = startTemp ?? null;
  const eventType = deriveEventType(equipmentStatus, isFanTimerOn, true);

  // CORE payload
  const corePayload = {
    device_id: deviceKey,
    event_type: eventType,
    is_active: isActive,
    equipment_status: equipmentStatus,
    temperature_f: currentTemp,
    temperature_c: currentTemp != null ? ((currentTemp - 32) * 5 / 9).toFixed(2) : null,
    runtime_seconds: runtimeSeconds,
    timestamp: now.toISOString(),
    current_temp: currentTemp,
  };

  // BUBBLE payload (unchanged)
  const bubblePayload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds,
    currentTemperature: currentTemp,
    isActive,
  };

  console.log('📤 CORE POST:', JSON.stringify(corePayload, null, 2));
  console.log('📤 BUBBLE POST:', JSON.stringify(bubblePayload, null, 2));

  postToCoreIngestAsync(corePayload);
  postToBubbleAsync(bubblePayload);

  console.log(`[runtimeTracker] ▶️ Session started for ${deviceKey}`);
}

/**
 * Stop runtime session
 */
async function stopRuntimeSession(deviceKey, userId, finalStatus) {
  const state = activeDevices.get(deviceKey);
  if (!state) return;

  const now = new Date();
  const runtimeSeconds = Math.floor((now - new Date(state.startedAt)) / 1000);
  activeDevices.delete(deviceKey);

  const isActive = false;
  const currentTemp = await getCurrentTemp(deviceKey);
  const eventType = 'SESSION_END';

  const corePayload = {
    device_id: deviceKey,
    event_type: eventType,
    is_active: isActive,
    equipment_status: finalStatus,
    temperature_f: currentTemp,
    temperature_c: currentTemp != null ? ((currentTemp - 32) * 5 / 9).toFixed(2) : null,
    runtime_seconds: runtimeSeconds,
    timestamp: now.toISOString(),
    current_temp: currentTemp,
  };

  const bubblePayload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds,
    currentTemperature: currentTemp,
    isActive,
  };

  console.log('📤 CORE POST:', JSON.stringify(corePayload, null, 2));
  console.log('📤 BUBBLE POST:', JSON.stringify(bubblePayload, null, 2));

  postToCoreIngestAsync(corePayload);
  postToBubbleAsync(bubblePayload);

  console.log(`[runtimeTracker] ⏹️ Session ended for ${deviceKey} (${runtimeSeconds}s)`);
}

/**
 * Handle temperature-only events (no state change)
 */
async function handleTemperatureChange(deviceKey, userId) {
  const tempF = await getCurrentTemp(deviceKey);
  const tempC = tempF != null ? ((tempF - 32) * 5) / 9 : null;
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
    currentTemperature: tempF,
    isActive,
  };

  console.log('📤 CORE POST:', JSON.stringify(corePayload, null, 2));
  console.log('📤 BUBBLE POST:', JSON.stringify(bubblePayload, null, 2));

  postToCoreIngestAsync(corePayload);
  postToBubbleAsync(bubblePayload);
}

/**
 * Helpers
 */
function deriveEventType(equipmentStatus, isFanTimerOn, isStart) {
  if (equipmentStatus === 'HEATING') return isStart ? 'HEAT_ON' : 'HEAT';
  if (equipmentStatus === 'COOLING') return isStart ? 'COOL_ON' : 'COOL';
  if (isFanTimerOn) return isStart ? 'FAN_ON' : 'FAN';
  return 'IDLE';
}

async function getCurrentTemp(deviceKey) {
  const pool = getPool();
  try {
    const r = await pool.query(`SELECT current_temp_f FROM device_status WHERE device_key=$1`, [deviceKey]);
    return r.rows.length ? r.rows[0].current_temp_f : null;
  } catch {
    return null;
  }
}

async function getUseForcedAirForHeat(deviceKey) {
  const pool = getPool();
  try {
    const r = await pool.query(`SELECT use_forced_air_for_heat FROM device_status WHERE device_key=$1`, [deviceKey]);
    if (!r.rows.length) return true;
    const v = r.rows[0]?.use_forced_air_for_heat;
    return (v === null || v === undefined) ? true : !!v;
  } catch {
    return true;
  }
}

async function recoverActiveSessions() {
  const pool = getPool();
  try {
    const result = await pool.query(`
      SELECT device_key, is_running, started_at
      FROM device_status
      WHERE is_running = TRUE
    `);
    result.rows.forEach(r => {
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
