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
  } else if (state &&
