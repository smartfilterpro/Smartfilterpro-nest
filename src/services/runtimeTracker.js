'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster'); // 🆕 dual-post helper

// In-memory tracking of active devices
const activeDevices = new Map();

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
        rs.session_id
      FROM device_status ds
      LEFT JOIN runtime_sessions rs ON ds.device_key = rs.device_key AND rs.ended_at IS NULL
      WHERE ds.is_running = true
    `);

    const now = new Date();
    for (const row of result.rows) {
      const deviceState = {
        deviceKey: row.device_key,
        frontendId: row.frontend_id,
        deviceName: row.device_name,
        sessionId: row.session_id || uuidv4(),
        sessionStartedAt: new Date(row.session_started_at),
        currentMode: row.current_mode,
        currentEquipmentStatus: row.current_equipment_status,
        isHeating: row.current_equipment_status === 'HEATING',
        isCooling: row.current_equipment_status === 'COOLING',
        isFanOnly: row.current_equipment_status === 'FAN'
      };
      activeDevices.set(row.device_key, deviceState);
    }

    console.log(`Recovered ${activeDevices.size} active session(s)`);
  } catch (error) {
    console.error('Error recovering active sessions:', error);
  }
}

async function handleDeviceEvent(eventData) {
  const pool = getPool();
  try {
    const deviceName = eventData.resourceUpdate?.name || eventData.eventId;
    const deviceKey = extractDeviceKey(deviceName);
    const userId = eventData.userId;

    if (!deviceKey) {
      console.error('Could not extract device key from event');
      return;
    }

    await ensureDeviceExists(deviceKey, userId, deviceName);

    const traits = eventData.resourceUpdate?.traits || {};

    // Connectivity
    if (traits['sdm.devices.traits.Connectivity']) {
      const isReachable = traits['sdm.devices.traits.Connectivity'].status === 'ONLINE';
      await updateDeviceReachability(deviceKey, isReachable);
    }

    // Temperature
    if (traits['sdm.devices.traits.Temperature']) {
      const tempC = traits['sdm.devices.traits.Temperature'].ambientTemperatureCelsius;
      const tempF = celsiusToFahrenheit(tempC);
      handleTemperatureChange(deviceKey, tempF, tempC, userId).catch(err =>
        console.error('Error handling temperature change:', err)
      );
    }

    const thermostatMode = traits['sdm.devices.traits.ThermostatMode']?.mode || null;
    const equipmentStatus = traits['sdm.devices.traits.ThermostatHvac']?.status || 'OFF';
    const isFanTimerOn = traits['sdm.devices.traits.Fan']?.timerMode === 'ON' || false;

    const setpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint'] || {};
    const heatSetpoint = setpoint.heatCelsius ? celsiusToFahrenheit(setpoint.heatCelsius) : null;
    const coolSetpoint = setpoint.coolCelsius ? celsiusToFahrenheit(setpoint.coolCelsius) : null;

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
  } catch (error) {
    console.error('Error handling device event:', error);
  }
}

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
  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const shouldBeActive = isHeating || isCooling || isFanTimerOn;
  const currentState = activeDevices.get(deviceKey);
  const wasActive = !!currentState;

  if (shouldBeActive && !wasActive) {
    await startRuntimeSession(deviceKey, userId, deviceName, equipmentStatus, isFanTimerOn, thermostatMode, heatSetpoint, coolSetpoint);
  } else if (!shouldBeActive && wasActive) {
    await endRuntimeSession(deviceKey, userId, deviceName, equipmentStatus);
  } else if (shouldBeActive && wasActive) {
    await updateRuntimeSession(deviceKey, equipmentStatus, isFanTimerOn, heatSetpoint, coolSetpoint);
  }

  await logEquipmentEvent(deviceKey, equipmentStatus, isFanTimerOn, currentState);
}

async function startRuntimeSession(deviceKey, userId, deviceName, equipmentStatus, isFanTimerOn, thermostatMode, heatSetpoint, coolSetpoint) {
  const pool = getPool();
  const now = new Date();
  const sessionId = uuidv4();

  const mode = equipmentStatus === 'HEATING' ? 'heating'
              : equipmentStatus === 'COOLING' ? 'cooling'
              : isFanTimerOn ? 'fan_only'
              : 'off';

  const startTempResult = await pool.query('SELECT last_temperature FROM device_status WHERE device_key = $1', [deviceKey]);
  const startTemp = startTempResult.rows[0]?.last_temperature || null;

  await pool.query(`
    INSERT INTO runtime_sessions (device_key, session_id, mode, equipment_status, started_at, start_temperature, heat_setpoint, cool_setpoint)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
  `, [deviceKey, sessionId, mode, equipmentStatus, now, startTemp, heatSetpoint, coolSetpoint]);

  activeDevices.set(deviceKey, {
    sessionId,
    sessionStartedAt: now,
    currentMode: mode,
    currentEquipmentStatus: equipmentStatus,
    isHeating,
    isCooling,
    isFanOnly: isFanTimerOn
  });

  const payload = {
    userId,
    thermostatId: deviceKey,
    deviceName,
    runtimeSeconds: 0,
    isRuntimeEvent: false,
    hvacMode: mode,
    isHvacActive: true,
    thermostatMode: mode.toUpperCase(),
    currentTempF: startTemp,
    timestamp: now.toISOString(),
    eventId: uuidv4()
  };

  postToBubbleAsync(payload);

  // 🆕 Dual-post to Core Ingest
  postToCoreIngestAsync({
    source: 'nest',
    workspace_id: userId,
    device_id: deviceKey,
    device_name: deviceName,
    zip_code_prefix: null, // to be filled per thermostat later
    is_active: true,
    is_cooling: equipmentStatus === 'COOLING',
    is_heating: equipmentStatus === 'HEATING',
    is_fan_running: !!isFanTimerOn,
    current_temperature: startTemp,
    target_temperature: heatSetpoint || coolSetpoint || null,
    timestamp: now.toISOString(),
    metadata: { model: 'Nest Thermostat', manufacturer: 'Google', vendor_account_id: userId }
  });
}

async function endRuntimeSession(deviceKey, userId, deviceName, finalStatus) {
  const pool = getPool();
  const now = new Date();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) return;

  const runtimeSeconds = Math.floor((now - deviceState.sessionStartedAt) / 1000);
  activeDevices.delete(deviceKey);

  await pool.query(`
    UPDATE runtime_sessions SET ended_at=$2,duration_seconds=$3 WHERE session_id=$1
  `, [deviceState.sessionId, now, runtimeSeconds]);

  const payload = {
    userId,
    thermostatId: deviceKey,
    deviceName,
    runtimeSeconds,
    isRuntimeEvent: true,
    hvacMode: deviceState.currentMode,
    isHvacActive: false,
    thermostatMode: deviceState.currentMode?.toUpperCase() || 'OFF',
    timestamp: now.toISOString(),
    eventId: uuidv4()
  };

  postToBubbleAsync(payload);

  // 🆕 Dual-post to Core Ingest
  postToCoreIngestAsync({
    source: 'nest',
    workspace_id: userId,
    device_id: deviceKey,
    device_name: deviceName,
    zip_code_prefix: null,
    is_active: false,
    is_cooling: deviceState.isCooling,
    is_heating: deviceState.isHeating,
    is_fan_running: false,
    current_temperature: null,
    target_temperature: null,
    timestamp: now.toISOString(),
    metadata: { model: 'Nest Thermostat', manufacturer: 'Google', vendor_account_id: userId }
  });
}

async function updateRuntimeSession(deviceKey, equipmentStatus, isFanTimerOn, heatSetpoint, coolSetpoint) {
  const pool = getPool();
  const now = new Date();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) return;

  await pool.query(`
    UPDATE runtime_sessions SET tick_count=tick_count+1,last_tick_at=$2,updated_at=$2 WHERE session_id=$1
  `, [deviceState.sessionId, now]);
}

async function handleTemperatureChange(deviceKey, tempF, tempC, userId) {
  const pool = getPool();
  await pool.query(`
    UPDATE device_status SET last_temperature=$2,last_seen_at=NOW(),updated_at=NOW() WHERE device_key=$1
  `, [deviceKey, tempF]);

  const deviceState = activeDevices.get(deviceKey);
  const payload = {
    userId,
    thermostatId: deviceKey,
    runtimeSeconds: 0,
    isRuntimeEvent: false,
    isHvacActive: !!deviceState,
    currentTempF: tempF,
    timestamp: new Date().toISOString(),
    eventId: uuidv4()
  };

  postToBubbleAsync(payload);

  // 🆕 Dual-post to Core Ingest
  postToCoreIngestAsync({
    source: 'nest',
    workspace_id: userId,
    device_id: deviceKey,
    device_name: deviceState?.deviceName || null,
    zip_code_prefix: null,
    is_active: !!deviceState,
    is_cooling: deviceState?.isCooling || false,
    is_heating: deviceState?.isHeating || false,
    is_fan_running: deviceState?.isFanOnly || false,
    current_temperature: tempF,
    target_temperature: null,
    timestamp: new Date().toISOString(),
    metadata: { model: 'Nest Thermostat', manufacturer: 'Google', vendor_account_id: userId }
  });
}

async function ensureDeviceExists(deviceKey, userId, deviceName) {
  const pool = getPool();
  await pool.query(`
    INSERT INTO device_status (device_key, frontend_id, device_name, created_at, updated_at)
    VALUES ($1,$2,$3,NOW(),NOW())
    ON CONFLICT (device_key) DO UPDATE
      SET frontend_id=EXCLUDED.frontend_id,device_name=EXCLUDED.device_name,updated_at=NOW()
  `, [deviceKey, userId, deviceName]);
}

async function updateDeviceReachability(deviceKey, isReachable) {
  const pool = getPool();
  await pool.query(`UPDATE device_status SET is_reachable=$2,updated_at=NOW() WHERE device_key=$1`, [deviceKey, isReachable]);
}

async function logEquipmentEvent(deviceKey, equipmentStatus, isFanTimerOn, previousState) {
  const pool = getPool();
  await pool.query(`
    INSERT INTO equipment_events (device_key, event_type, equipment_status, previous_status, is_active, session_id, event_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `, [
    deviceKey,
    'status_change',
    equipmentStatus,
    previousState?.currentEquipmentStatus || 'unknown',
    !!previousState,
    previousState?.sessionId || null,
    JSON.stringify({ isFanTimerOn })
  ]);
}

function extractDeviceKey(deviceName) {
  const parts = deviceName.split('/');
  return parts[parts.length - 1];
}

function celsiusToFahrenheit(celsius) {
  return Math.round((celsius * 9 / 5 + 32) * 100) / 100;
}

module.exports = {
  handleDeviceEvent,
  recoverActiveSessions,
  activeDevices
};
