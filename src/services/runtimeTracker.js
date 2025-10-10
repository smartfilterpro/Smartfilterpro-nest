'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

// ===========================
// In-memory active sessions
// ===========================
const activeDevices = new Map();

// ===========================
// Persistent state memory (for partial webhooks)
// ===========================
const deviceStateMemory = new Map();
// deviceKey -> { lastHvacStatus, lastFanMode, lastThermostatMode, lastFanTimerUntil }

// ===========================
// Startup recovery
// ===========================
async function recoverActiveSessions() {
  const pool = getPool();
  try {
    const result = await pool.query(`
      SELECT 
        ds.device_key,
        ds.frontend_id,
        ds.device_name,
        ds.is_running,
        ds.session_started_at,
        ds.current_mode,
        ds.current_equipment_status,
        ds.last_temperature,
        ds.last_heat_setpoint,
        ds.last_cool_setpoint,
        rs.session_id
      FROM device_status ds
      LEFT JOIN runtime_sessions rs ON ds.device_key = rs.device_key AND rs.ended_at IS NULL
      WHERE ds.is_running = TRUE
    `);

    const now = new Date();
    const MAX_SESSION_AGE_HOURS = 4;

    for (const row of result.rows) {
      const sessionAgeHrs = (now - new Date(row.session_started_at)) / 3600000;
      if (sessionAgeHrs > MAX_SESSION_AGE_HOURS) {
        console.log(`[runtimeTracker] Skipping stale session for ${row.device_key} (age=${sessionAgeHrs.toFixed(1)}h)`);

        await pool.query(`
          UPDATE device_status 
          SET is_running = FALSE, session_started_at = NULL 
          WHERE device_key = $1
        `, [row.device_key]);

        if (row.session_id) {
          await pool.query(`
            UPDATE runtime_sessions 
            SET ended_at = NOW(), duration_seconds = 0
            WHERE session_id = $1
          `, [row.session_id]);
        }
        continue;
      }

      activeDevices.set(row.device_key, {
        deviceKey: row.device_key,
        frontendId: row.frontend_id,
        deviceName: row.device_name,
        sessionId: row.session_id || uuidv4(),
        sessionStartedAt: new Date(row.session_started_at),
        currentMode: row.current_mode,
        currentEquipmentStatus: row.current_equipment_status,
        startTemperature: row.last_temperature,
        isHeating: row.current_equipment_status === 'HEATING',
        isCooling: row.current_equipment_status === 'COOLING',
        isFanOnly: row.current_equipment_status === 'FAN',
        heatSetpoint: row.last_heat_setpoint,
        coolSetpoint: row.last_cool_setpoint
      });

      console.log(`[runtimeTracker] Recovered active session for ${row.device_key} (age=${sessionAgeHrs.toFixed(1)}h)`);
    }

    console.log(`[runtimeTracker] Recovery complete — ${activeDevices.size} active session(s).`);
  } catch (error) {
    console.error('[runtimeTracker] Error recovering active sessions:', error);
  }
}

// ===========================
// Helpers
// ===========================
function extractDeviceKey(deviceName) {
  const parts = (deviceName || '').split('/');
  return parts[parts.length - 1] || null;
}

function celsiusToFahrenheit(celsius) {
  if (typeof celsius !== 'number') return null;
  return Math.round((celsius * 9/5 + 32) * 100) / 100;
}

async function ensureDeviceExists(deviceKey, userId, deviceName) {
  const pool = getPool();
  try {
    await pool.query(`
      INSERT INTO device_status (device_key, frontend_id, device_name, created_at, updated_at)
      VALUES ($1,$2,$3,NOW(),NOW())
      ON CONFLICT (device_key) DO UPDATE
        SET frontend_id = EXCLUDED.frontend_id,
            device_name = EXCLUDED.device_name,
            updated_at = NOW()
    `, [deviceKey, userId, deviceName]);
  } catch (error) {
    console.error('[runtimeTracker] Error ensuring device exists:', error);
  }
}

async function updateDeviceReachability(deviceKey, isReachable) {
  const pool = getPool();
  try {
    await pool.query(`
      UPDATE device_status
      SET is_reachable = $2, last_seen_at = NOW(), updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, isReachable]);
  } catch (error) {
    console.error('[runtimeTracker] Error updating device reachability:', error);
  }
}

async function getBackfillState(deviceKey) {
  const pool = getPool();
  try {
    const r = await pool.query(`
      SELECT
        last_temperature,
        last_humidity,
        last_heat_setpoint,
        last_cool_setpoint,
        current_equipment_status,
        current_mode,
        is_reachable
      FROM device_status
      WHERE device_key = $1
    `, [deviceKey]);
    return r.rows[0] || null;
  } catch (err) {
    console.error('[runtimeTracker] getBackfillState error:', err.message);
    return null;
  }
}

// ===========================
// Public entrypoint
// ===========================
async function handleDeviceEvent(eventData) {
  try {
    const deviceName = eventData.resourceUpdate?.name || eventData.eventId;
    const deviceKey = extractDeviceKey(deviceName);
    const userId = eventData.userId;

    if (!deviceKey) {
      console.error('[runtimeTracker] Could not extract device key from event');
      return;
    }

    await ensureDeviceExists(deviceKey, userId, deviceName);

    const traits = eventData.resourceUpdate?.traits || {};
    const tConnectivity = traits['sdm.devices.traits.Connectivity'];
    const tTemp = traits['sdm.devices.traits.Temperature'];
    const tHvac = traits['sdm.devices.traits.ThermostatHvac'];
    const tFan = traits['sdm.devices.traits.Fan'];
    const tSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint'];

    const tInfo = traits['sdm.devices.traits.Info'] || traits['sdm.devices.traits.DeviceInfo'] || {};
    const tSwUpdate = traits['sdm.devices.traits.SoftwareUpdate'] || {};
    const firmwareVersion = tSwUpdate.currentVersion || tInfo.currentVersion || null;
    const serialNumber = tInfo.serialNumber || tInfo.serial || null;

    if (tConnectivity) {
      const isReachable = tConnectivity.status === 'ONLINE';
      await updateDeviceReachability(deviceKey, isReachable);
      console.log('[runtimeTracker] Connectivity:', isReachable ? 'ONLINE' : 'OFFLINE');
    }

    // Handle temperature telemetry
    if (tTemp && typeof tTemp.ambientTemperatureCelsius === 'number') {
      const tempC = tTemp.ambientTemperatureCelsius;
      const tempF = celsiusToFahrenheit(tempC);
      console.log('[runtimeTracker] Temperature event:', { tempC, tempF });
      handleTemperatureChange(deviceKey, tempF, tempC, userId)
        .catch(err => console.error('[runtimeTracker] Error in handleTemperatureChange:', err));
    }

    // ===========================
    // NEW: Memory-backed HVAC + Fan logic
    // ===========================
    let state = deviceStateMemory.get(deviceKey) || {
      lastHvacStatus: 'OFF',
      lastFanMode: 'OFF',
      lastThermostatMode: 'HEATCOOL',
      lastFanTimerUntil: null
    };

    const hvacStatus = tHvac?.status ?? null;
    const fanMode = tFan?.timerMode ?? null;
    const fanTimeout = tFan?.timerTimeout ?? null;
    const thermostatMode = traits['sdm.devices.traits.ThermostatMode']?.mode ?? null;

    if (hvacStatus) state.lastHvacStatus = hvacStatus;
    if (fanMode) state.lastFanMode = fanMode;
    if (fanTimeout) state.lastFanTimerUntil = new Date(fanTimeout);
    if (thermostatMode) state.lastThermostatMode = thermostatMode;

    deviceStateMemory.set(deviceKey, state);

    const hvacActive = ['COOLING', 'HEATING'].includes(state.lastHvacStatus);
    const fanActive =
      state.lastFanMode === 'ON' &&
      (!state.lastFanTimerUntil || new Date() < state.lastFanTimerUntil);

    const effectiveEquip = state.lastHvacStatus || 'OFF';
    const effectiveFan = fanActive;
    const isHeating = state.lastHvacStatus === 'HEATING';
    const isCooling = state.lastHvacStatus === 'COOLING';

    console.log('DEBUG - Combined state memory:', {
      lastHvacStatus: state.lastHvacStatus,
      lastFanMode: state.lastFanMode,
      fanTimeout: state.lastFanTimerUntil,
      thermostatMode: state.lastThermostatMode,
      hvacActive,
      fanActive
    });

    // Setpoints
    let heatSetpoint = null, coolSetpoint = null;
    if (tSetpoint) {
      if (typeof tSetpoint.heatCelsius === 'number') heatSetpoint = celsiusToFahrenheit(tSetpoint.heatCelsius);
      if (typeof tSetpoint.coolCelsius === 'number') coolSetpoint = celsiusToFahrenheit(tSetpoint.coolCelsius);
    }

    await processRuntimeLogic({
      eventData,
      deviceKey,
      userId,
      deviceName,
      equipmentStatus: effectiveEquip,
      isFanTimerOn: effectiveFan,
      heatSetpoint,
      coolSetpoint,
      firmwareVersion,
      serialNumber
    });
  } catch (error) {
    console.error('[runtimeTracker] Error handling device event:', error);
  }
}

// ===========================
// Runtime/session logic
// ===========================
async function processRuntimeLogic({
  eventData,
  deviceKey,
  userId,
  deviceName,
  equipmentStatus,
  isFanTimerOn,
  heatSetpoint,
  coolSetpoint,
  firmwareVersion,
  serialNumber
}) {
  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isFanOnly = !isHeating && !isCooling && isFanTimerOn;
  const shouldBeActive = isHeating || isCooling || isFanTimerOn;
  const wasActive = activeDevices.has(deviceKey);

  console.log('RUNTIME STATE:', {
    equipmentStatus,
    isHeating,
    isCooling,
    isFanOnly,
    shouldBeActive,
    wasActive
  });

  if (shouldBeActive && !wasActive) {
    await startRuntimeSession({
      deviceKey, userId, deviceName, equipmentStatus,
      isFanTimerOn, heatSetpoint, coolSetpoint,
      firmwareVersion, serialNumber, eventData
    });
  } else if (!shouldBeActive && wasActive) {
    await endRuntimeSession({
      deviceKey, userId, deviceName, finalEquipmentStatus: equipmentStatus,
      firmwareVersion, serialNumber, eventData
    });
  } else if (shouldBeActive && wasActive) {
    await updateRuntimeSession({ deviceKey, equipmentStatus, isFanTimerOn, heatSetpoint, coolSetpoint });
  }
}

// ===========================
// Session lifecycle helpers
// ===========================
async function startRuntimeSession({...args}) { /* use your existing implementation */ }
async function endRuntimeSession({...args}) { /* use your existing implementation */ }
async function updateRuntimeSession({...args}) { /* use your existing implementation */ }
async function handleTemperatureChange({...args}) { /* unchanged from your current version */ }

// ===========================
// Exports
// ===========================
module.exports = {
  handleDeviceEvent,
  recoverActiveSessions,
  activeDevices
};
