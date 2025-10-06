'use strict';

/**
 * SmartFilterPro — Nest Runtime Tracker
 * -------------------------------------
 * Tracks HVAC runtime sessions, dual-posts updates to Bubble and Core Ingest,
 * includes debug logs for every outbound payload, and respects user settings.
 */

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

const activeDevices = new Map(); // In-memory tracking of active sessions

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
    let isFanTimerOn = traits['sdm.devices.traits.Fan']?.timerMode === 'ON' ? true : null;

    // 🧩 Fallbacks for temp-only events
    if (equipmentStatus === null || isFanTimerOn === null) {
      const r = await pool.query(
        `SELECT current_equipment_status, last_fan_status
         FROM device_status
         WHERE device_key = $1`,
        [deviceId]
      );
      if (r.rows.length) {
        if (equipmentStatus === null) equipmentStatus = r.rows[0].current_equipment_status || 'OFF';
        if (isFanTimerOn === null) isFanTimerOn = r.rows[0].last_fan_status === 'ON';
      } else {
        equipmentStatus = equipmentStatus ?? 'OFF';
        isFanTimerOn = isFanTimerOn ?? false;
      }
    }

    // 🧠 Persist latest statuses
    await pool.query(
      `UPDATE device_status
       SET current_equipment_status=$2,
           last_fan_status=$3,
           updated_at=NOW()
       WHERE device_id=$1`,
      [deviceId, equipmentStatus, isFanTimerOn ? 'ON' : 'OFF']
    );

    await processRuntimeLogic(
      deviceId,
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
 * Runtime logic controlling state transitions
 */
async function processRuntimeLogic(
  deviceId,
  userId,
  deviceName,
  equipmentStatus,
  isFanTimerOn,
  thermostatMode,
  heatSetpoint,
  coolSetpoint
) {
  const state = activeDevices.get(deviceId);
  const useForcedAirForHeat = await getUseForcedAirForHeat(deviceId);

  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isFan = isFanTimerOn === true;
  const shouldBeActive = isHeating || isCooling || isFan;

  if (!state && shouldBeActive) {
    await startRuntimeSession(deviceId, userId, deviceName, equipmentStatus, isFanTimerOn, thermostatMode);
  } else if (state && !shouldBeActive) {
    await stopRuntimeSession(deviceId, userId, deviceName, equipmentStatus);
  } else if (state && shouldBeActive) {
    await handleTemperatureChange(deviceId, userId);
  }

  // Ignore heating runtimes if user disabled forced air
  if (isHeating && !useForcedAirForHeat) {
    console.log(`[runtimeTracker] ⚠️ Ignoring HEAT runtime for ${deviceId} (forcedAirForHeat=false)`);
  }
}

/**
 * Start new runtime session
 */
async function startRuntimeSession(deviceId, userId, deviceName, equipmentStatus, isFanTimerOn, thermostatMode) {
  const now = new Date();
  const startTemp = await getCurrentTemp(deviceId);
  const sessionId = uuidv4();

  const state = {
    sessionId,
    startedAt: now,
    isCooling: equipmentStatus === 'COOLING',
    isHeating: equipmentStatus === 'HEATING',
    isFanOnly: isFanTimerOn,
    currentEquipmentStatus: equipmentStatus,
  };
  activeDevices.set(deviceId, state);

  const runtimeSeconds = 0;
  const isActive = true;
  const currentTemp = startTemp ?? null;
  const eventType = deriveEventType(equipmentStatus, isFanTimerOn, true);

  // 🌐 Core payload
  const corePayload = {
    device_id: deviceId,
    event_type: eventType,
    is_active: isActive,
    equipment_status: equipmentStatus,
    temperature_f: currentTemp,
    temperature_c: currentTemp != null ? ((currentTemp - 32) * 5 / 9).toFixed(2) : null,
    runtime_seconds: runtimeSeconds,
    timestamp: now.toISOString(),
    current_temp: currentTemp,
  };

  // 💧 Bubble payload (original schema)
  const bubblePayload = {
    isHvacActive: equipmentStatus !== 'OFF',
    hvacMode: equipmentStatus ?? 'OFF',
    runtimeMinutes: runtimeSeconds ? Math.round(runtimeSeconds / 60) : 0,
    isRuntimeEvent: isActive ?? false,
  };

  console.log('📤 CORE POST:', JSON.stringify(corePayload, null, 2));
  console.log('📤 BUBBLE POST:', JSON.stringify(bubblePayload, null, 2));

  postToCoreIngestAsync(corePayload);
  postToBubbleAsync(bubblePayload);

  console.log(`[runtimeTracker] ▶️ Session started for ${deviceName} (${deviceId})`);
}

/**
 * Stop runtime session
 */
async function stopRuntimeSession(deviceId, userId, deviceName, finalStatus) {
  const state = activeDevices.get(deviceId);
  if (!state) return;

  const now = new Date();
  const runtimeSeconds = Math.floor((now - new Date(state.startedAt)) / 1000);
  activeDevices.delete(deviceId);

  const isActive = false;
  const currentTemp = await getCurrentTemp(deviceId);
  const eventType = 'SESSION_END';

  const corePayload = {
    device_id: deviceId,
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
    isHvacActive: false,
    hvacMode: finalStatus ?? 'OFF',
    runtimeMinutes: Math.round(runtimeSeconds / 60),
    isRuntimeEvent: true,
  };

  console.log('📤 CORE POST:', JSON.stringify(corePayload, null, 2));
  console.log('📤 BUBBLE POST:', JSON.stringify(bubblePayload, null, 2));

  postToCoreIngestAsync(corePayload);
  postToBubbleAsync(bubblePayload);

  console.log(`[runtimeTracker] ⏹️ Session ended for ${deviceName} (${deviceId}) after ${runtimeSeconds}s`);
}

/**
 * Handle temp-only updates (no state change)
 */
async function handleTemperatureChange(deviceId, userId) {
  const tempF = await getCurrentTemp(deviceId);
  const tempC = tempF != null ? ((tempF - 32) * 5) / 9 : null;
  const isActive = !!activeDevices.get(deviceId);
  const equipmentStatus = activeDevices.get(deviceId)?.currentEquipmentStatus || 'OFF';

  const corePayload = {
    device_id: deviceId,
    event_type: 'TEMP',
    is_active: isActive,
    equipment_status: equipmentStatus,
    temperature_f: tempF,
    temperature_c: tempC,
    runtime_seconds: null,
    timestamp: new Date().toISOString(),
    current_temp: tempF,
  };

  const bubblePayload = {
    isHvacActive: equipmentStatus !== 'OFF',
    hvacMode: equipmentStatus,
    runtimeMinutes: null,
    isRuntimeEvent: false,
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

async function getCurrentTemp(deviceId) {
  const pool = getPool();
  try {
    const r = await pool.query(`SELECT current_temp_f FROM device_status WHERE device_id=$1`, [deviceId]);
    return r.rows.length ? r.rows[0].current_temp_f : null;
  } catch {
    return null;
  }
}

async function getUseForcedAirForHeat(deviceId) {
  const pool = getPool();
  try {
    const r = await pool.query(`SELECT use_forced_air_for_heat FROM device_status WHERE device_id=$1`, [deviceId]);
    if (!r.rows.length) return true;
    const v = r.rows[0]?.use_forced_air_for_heat;
    return (v === null || v === undefined) ? true : !!v;
  } catch {
    return true;
  }
}

/**
 * Recover sessions on restart — stubbed (Nest DB doesn't track session state)
 */
async function recoverActiveSessions() {
  console.log('[runtimeTracker] Skipping recovery — device_status has no session columns.');
  return;
}

module.exports = {
  handleDeviceEvent,
  recoverActiveSessions,
};
