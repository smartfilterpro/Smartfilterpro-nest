'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster'); // new

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
        ds.last_temperature,
        ds.last_heat_setpoint,
        ds.last_cool_setpoint,
        rs.session_id
      FROM device_status ds
      LEFT JOIN runtime_sessions rs ON ds.device_key = rs.device_key AND rs.ended_at IS NULL
      WHERE ds.is_running = true
    `);

    const now = new Date();
    const MAX_SESSION_AGE_HOURS = 4;

    for (const row of result.rows) {
      const sessionAge = (now - new Date(row.session_started_at)) / 1000 / 60 / 60;
      if (sessionAge > MAX_SESSION_AGE_HOURS) {
        console.log(`Skipping stale session for ${row.device_key} - age: ${sessionAge.toFixed(1)}h`);
        await pool.query(`
          UPDATE device_status 
          SET is_running = false, session_started_at = NULL 
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
    if (traits['sdm.devices.traits.Connectivity']) {
      const isReachable = traits['sdm.devices.traits.Connectivity'].status === 'ONLINE';
      await updateDeviceReachability(deviceKey, isReachable);
    }

    if (traits['sdm.devices.traits.Temperature']) {
      const tempC = traits['sdm.devices.traits.Temperature'].ambientTemperatureCelsius;
      const tempF = celsiusToFahrenheit(tempC);
      handleTemperatureChange(deviceKey, tempF, tempC, userId).catch(console.error);
    }

    const thermostatMode = traits['sdm.devices.traits.ThermostatMode']?.mode || null;
    const equipmentStatus = traits['sdm.devices.traits.ThermostatHvac']?.status || null;
    const isFanTimerOn = traits['sdm.devices.traits.Fan']?.timerMode === 'ON' || false;

    let heatSetpoint = null, coolSetpoint = null;
    if (traits['sdm.devices.traits.ThermostatTemperatureSetpoint']) {
      const setpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint'];
      if (setpoint.heatCelsius) heatSetpoint = celsiusToFahrenheit(setpoint.heatCelsius);
      if (setpoint.coolCelsius) coolSetpoint = celsiusToFahrenheit(setpoint.coolCelsius);
    }

    await processRuntimeLogic(
      deviceKey,
      userId,
      deviceName,
      equipmentStatus || 'OFF',
      isFanTimerOn,
      thermostatMode,
      heatSetpoint,
      coolSetpoint
    );
  } catch (error) {
    console.error('Error handling device event:', error);
  }
}

async function processRuntimeLogic(deviceKey, userId, deviceName, equipmentStatus, isFanTimerOn, thermostatMode, heatSetpoint, coolSetpoint) {
  const pool = getPool();
  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isOff = equipmentStatus === 'OFF';
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
}

async function startRuntimeSession(deviceKey, userId, deviceName, equipmentStatus, isFanTimerOn, thermostatMode, heatSetpoint, coolSetpoint) {
  const pool = getPool();
  const sessionId = uuidv4();
  const now = new Date();
  const mode = isFanTimerOn ? 'fan_only' : equipmentStatus.toLowerCase();
  const tempResult = await pool.query('SELECT last_temperature FROM device_status WHERE device_key=$1', [deviceKey]);
  const startTemp = tempResult.rows[0]?.last_temperature || null;

  await pool.query(`
    INSERT INTO runtime_sessions (
      device_key, session_id, mode, equipment_status, started_at, start_temperature, heat_setpoint, cool_setpoint, tick_count, last_tick_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$5)
  `, [deviceKey, sessionId, mode, equipmentStatus, now, startTemp, heatSetpoint, coolSetpoint]);

  await pool.query(`
    UPDATE device_status SET
      is_running = TRUE,
      session_started_at=$2,
      current_mode=$3,
      current_equipment_status=$4,
      updated_at=$2
    WHERE device_key=$1
  `, [deviceKey, now, mode, equipmentStatus]);

  activeDevices.set(deviceKey, {
    deviceKey,
    frontendId: userId,
    deviceName,
    sessionId,
    sessionStartedAt: now,
    currentMode: mode,
    currentEquipmentStatus: equipmentStatus,
    startTemperature: startTemp,
    isHeating: equipmentStatus === 'HEATING',
    isCooling: equipmentStatus === 'COOLING',
    isFanOnly: isFanTimerOn,
    heatSetpoint,
    coolSetpoint
  });

  // POST to Bubble + Core
  const payload = {
    device_key: deviceKey,
    device_id: `nest:${deviceKey}`,
    workspace_id: userId,
    device_name: deviceName,
    manufacturer: 'Google Nest',
    model: 'Nest Thermostat',
    source: 'nest',
    connection_source: 'nest',
    event_type: `${equipmentStatus}_ON`,
    is_active: true,
    equipment_status: equipmentStatus,
    runtime_seconds: null,
    temperature_f: startTemp,
    timestamp: now.toISOString(),
    source_event_id: sessionId,
  };

  await Promise.allSettled([
    postToBubbleAsync({
      userId,
      thermostatId: deviceKey,
      deviceName,
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: mode,
      isHvacActive: true,
      timestamp: now.toISOString(),
    }),
    postToCoreIngestAsync(payload)
  ]);

  console.log(`[runtimeTracker] Session started for ${deviceKey} (${equipmentStatus})`);
}

async function endRuntimeSession(deviceKey, userId, deviceName, finalEquipmentStatus) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) return;

  const now = new Date();
  const runtimeSeconds = Math.max(0, Math.floor((now - deviceState.sessionStartedAt) / 1000));
  activeDevices.delete(deviceKey);

  await pool.query(`
    UPDATE runtime_sessions
    SET ended_at=$2, duration_seconds=$3, updated_at=$2
    WHERE session_id=$1
  `, [deviceState.sessionId, now, runtimeSeconds]);

  await pool.query(`
    UPDATE device_status SET
      is_running=FALSE,
      current_equipment_status='OFF',
      updated_at=$2
    WHERE device_key=$1
  `, [deviceKey, now]);

  const payload = {
    device_key: deviceKey,
    device_id: `nest:${deviceKey}`,
    workspace_id: userId,
    device_name: deviceName,
    manufacturer: 'Google Nest',
    model: 'Nest Thermostat',
    source: 'nest',
    connection_source: 'nest',
    event_type: 'STATUS_CHANGE',
    is_active: false,
    equipment_status: 'OFF',
    runtime_seconds: runtimeSeconds,
    timestamp: now.toISOString(),
    source_event_id: deviceState.sessionId,
  };

  await Promise.allSettled([
    postToBubbleAsync({
      userId,
      thermostatId: deviceKey,
      deviceName,
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      isRuntimeEvent: true,
      hvacMode: deviceState.currentMode,
      isHvacActive: false,
      timestamp: now.toISOString(),
    }),
    postToCoreIngestAsync(payload)
  ]);

  console.log(`[runtimeTracker] Session ended for ${deviceKey}, runtime=${runtimeSeconds}s`);
}

async function updateRuntimeSession(deviceKey, equipmentStatus, isFanTimerOn, heatSetpoint, coolSetpoint) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) return;

  const now = new Date();
  await pool.query(`
    UPDATE runtime_sessions SET
      tick_count = tick_count + 1,
      last_tick_at = $2,
      heat_setpoint=$3,
      cool_setpoint=$4,
      updated_at=$2
    WHERE session_id=$1
  `, [deviceState.sessionId, now, heatSetpoint, coolSetpoint]);

  deviceState.currentEquipmentStatus = equipmentStatus;
  activeDevices.set(deviceKey, deviceState);
}

function extractDeviceKey(name) {
  const parts = name.split('/');
  return parts[parts.length - 1];
}

function celsiusToFahrenheit(c) {
  return Math.round((c * 9/5 + 32) * 100) / 100;
}

async function ensureDeviceExists(deviceKey, userId, deviceName) {
  const pool = getPool();
  await pool.query(`
    INSERT INTO device_status (device_key, frontend_id, device_name, created_at, updated_at)
    VALUES ($1,$2,$3,NOW(),NOW())
    ON CONFLICT (device_key) DO UPDATE SET updated_at=NOW()
  `, [deviceKey, userId, deviceName]);
}

async function updateDeviceReachability(deviceKey, isReachable) {
  const pool = getPool();
  await pool.query(`
    UPDATE device_status
    SET is_reachable=$2, updated_at=NOW()
    WHERE device_key=$1
  `, [deviceKey, isReachable]);
}

async function handleTemperatureChange(deviceKey, tempF, tempC, userId) {
  const pool = getPool();
  await pool.query(`
    UPDATE device_status SET last_temperature=$2, updated_at=NOW() WHERE device_key=$1
  `, [deviceKey, tempF]);
}

module.exports = {
  handleDeviceEvent,
  recoverActiveSessions,
  activeDevices
};
