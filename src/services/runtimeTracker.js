'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToCoreIngestAsync } = require('./ingestPoster');
const { buildCorePayload } = require('./buildCorePayload');

const deviceMemory = new Map();

function mapNestModeToStandard(nestMode) {
  const modeMap = { 'HEAT': 'heat', 'COOL': 'cool', 'HEATCOOL': 'auto', 'OFF': 'off' };
  return modeMap[nestMode] || (nestMode || 'off').toLowerCase();
}

function checkDeviceReachability(mem, nowMs) {
  if (!mem || !mem.lastEventTime) return true;
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  return (nowMs - mem.lastEventTime) <= TWO_HOURS_MS;
}

function classifyCurrentState(mem) {
  const equipmentStatus = mem.equipmentStatus || 'Idle';
  const isFanTimerOn = mem.isFanTimerOn || false;
  let stateLabel, finalEquipmentStatus, isActive;
  const isAuxHeat = equipmentStatus === 'Aux_Heating' || equipmentStatus === 'EMERGENCY_HEAT';

  if (isAuxHeat) {
    stateLabel = isFanTimerOn ? 'AuxHeat_Fan' : 'AuxHeat';
    finalEquipmentStatus = isFanTimerOn ? 'Aux_heating_Fan' : 'Aux_Heating';
    isActive = true;
  } else if (equipmentStatus === 'Heating') {
    stateLabel = isFanTimerOn ? 'Heating_Fan' : 'Heating';
    finalEquipmentStatus = isFanTimerOn ? 'Heating_Fan' : 'Heating';
    isActive = true;
  } else if (equipmentStatus === 'Cooling') {
    stateLabel = isFanTimerOn ? 'Cooling_Fan' : 'Cooling';
    finalEquipmentStatus = isFanTimerOn ? 'Cooling_Fan' : 'Cooling';
    isActive = true;
  } else if (isFanTimerOn) {
    stateLabel = 'Fan_only';
    finalEquipmentStatus = 'FAN';
    isActive = true;
  } else {
    stateLabel = 'Fan_off';
    finalEquipmentStatus = 'Idle';
    isActive = false;
  }

  return { stateLabel, equipmentStatus: finalEquipmentStatus, isActive };
}

async function recoverActiveSessions() {
  const pool = getPool();
  try {
    const result = await pool.query('SELECT ds.device_key, ds.frontend_id, ds.device_name, ds.is_running, ds.session_started_at, ds.current_mode, ds.current_equipment_status, ds.last_temperature, ds.last_heat_setpoint, ds.last_cool_setpoint, ds.last_humidity, ds.is_reachable, rs.session_id FROM device_status ds LEFT JOIN runtime_sessions rs ON ds.device_key = rs.device_key AND rs.ended_at IS NULL WHERE ds.is_running = TRUE');
    const now = new Date();
    const nowMs = now.getTime();
    const MAX_SESSION_AGE_HOURS = 4;

    for (const row of result.rows) {
      const sessionAgeHrs = (now - new Date(row.session_started_at)) / 3600000;
      if (sessionAgeHrs > MAX_SESSION_AGE_HOURS) {
        console.log('[runtimeTracker] Skipping stale session for ' + row.device_key);
        await pool.query('UPDATE device_status SET is_running = FALSE, session_started_at = NULL WHERE device_key = $1', [row.device_key]);
        if (row.session_id) await pool.query('UPDATE runtime_sessions SET ended_at = NOW(), duration_seconds = 0 WHERE session_id = $1', [row.session_id]);
        continue;
      }

      deviceMemory.set(row.device_key, {
        deviceKey: row.device_key, frontendId: row.frontend_id, deviceName: row.device_name,
        equipmentStatus: row.current_equipment_status,
        isFanTimerOn: row.current_equipment_status === 'FAN' || row.current_equipment_status?.includes('_FAN'),
        thermostatMode: row.current_mode?.toUpperCase() || 'OFF', running: true,
        sessionId: row.session_id || uuidv4(), sessionStartedAt: new Date(row.session_started_at),
        currentStateLabel: row.current_equipment_status === 'HEATING' ? 'Heating' : row.current_equipment_status === 'COOLING' ? 'Cooling' : row.current_equipment_status === 'FAN' ? 'Fan_only' : 'Fan_off',
        currentEquipmentStatus: row.current_equipment_status,
        lastTemperatureF: row.last_temperature, lastTemperatureC: row.last_temperature ? (row.last_temperature - 32) * 5 / 9 : null,
        lastHumidity: row.last_humidity, lastHeatSetpoint: row.last_heat_setpoint, lastCoolSetpoint: row.last_cool_setpoint,
        lastEventTime: nowMs, isReachable: row.is_reachable !== false, lastTelemetryPost: nowMs
      });
      console.log('[runtimeTracker] Recovered active session for ' + row.device_key);
    }
    console.log('[runtimeTracker] Recovery complete — ' + deviceMemory.size + ' active session(s).');
  } catch (error) {
    console.error('[runtimeTracker] Error recovering active sessions:', error);
  }
}

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
    await pool.query('INSERT INTO device_status (device_key, frontend_id, device_name, created_at, updated_at) VALUES ($1,$2,$3,NOW(),NOW()) ON CONFLICT (device_key) DO UPDATE SET frontend_id = EXCLUDED.frontend_id, device_name = EXCLUDED.device_name, updated_at = NOW()', [deviceKey, userId, deviceName]);
  } catch (error) {
    console.error('[runtimeTracker] Error ensuring device exists:', error);
  }
}

async function updateDeviceReachability(deviceKey, isReachable) {
  const pool = getPool();
  try {
    await pool.query('UPDATE device_status SET is_reachable = $2, last_seen_at = NOW(), updated_at = NOW() WHERE device_key = $1', [deviceKey, isReachable]);
  } catch (error) {
    console.error('[runtimeTracker] Error updating device reachability:', error);
  }
}

async function postCoreEvent({ deviceKey, userId, deviceName, firmwareVersion, serialNumber, eventType, equipmentStatus, previousStatus, isActive, isReachable, runtimeSeconds, temperatureF, humidity, heatSetpoint, coolSetpoint, thermostatMode, observedAt, sourceEventId, eventData }) {
  let runtimeType = 'UPDATE';
  if (runtimeSeconds === undefined) runtimeType = 'START';
  else if (typeof runtimeSeconds === 'number' && runtimeSeconds > 0) runtimeType = 'END';

  const payload = buildCorePayload({ deviceKey, userId, deviceName: deviceName || 'Nest Thermostat', manufacturer: 'Google Nest', model: 'Nest Thermostat', serialNumber, firmwareVersion, connectionSource: 'nest', source: 'nest', sourceVendor: 'nest', eventType, equipmentStatus, previousStatus: previousStatus || 'UNKNOWN', isActive: !!isActive, isReachable: isReachable !== undefined ? !!isReachable : true, mode: thermostatMode || equipmentStatus.toLowerCase(), thermostatMode, runtimeSeconds: typeof runtimeSeconds === 'number' ? runtimeSeconds : null, runtimeType, temperatureF, humidity, heatSetpoint, coolSetpoint, observedAt: observedAt || new Date(), sourceEventId: sourceEventId || uuidv4(), payloadRaw: eventData });

  const rtDisplay = runtimeSeconds === undefined ? 'START' : runtimeSeconds === null ? 'UPDATE' : runtimeSeconds + 's';
  console.log('[CORE POST] ' + deviceKey + ' -> ' + eventType + ' (' + runtimeType + ') runtime=' + rtDisplay + ' eq=' + equipmentStatus + ' prev=' + previousStatus + ' reachable=' + isReachable);
  await postToCoreIngestAsync(payload, runtimeType.toLowerCase());
}

async function handleDeviceEvent(eventData) {
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const deviceName = eventData.resourceUpdate?.name || eventData.eventId;
    const deviceKey = extractDeviceKey(deviceName);
    const userId = eventData.userId;

    if (!deviceKey) {
      console.error('[runtimeTracker] Could not extract device key from event');
      return;
    }

    await ensureDeviceExists(deviceKey, userId, deviceName);

    let mem = deviceMemory.get(deviceKey);
    if (!mem) {
      console.log('[runtimeTracker] Initializing new device memory for ' + deviceKey);
      mem = { deviceKey, frontendId: userId, deviceName, equipmentStatus: 'Idle', isFanTimerOn: false, thermostatMode: 'OFF', running: false, sessionId: null, sessionStartedAt: null, currentStateLabel: 'Fan_off', currentEquipmentStatus: 'IDLE', lastTemperatureF: null, lastTemperatureC: null, lastHumidity: null, lastHeatSetpoint: null, lastCoolSetpoint: null, lastEventTime: nowMs, isReachable: true, firmwareVersion: null, serialNumber: null, lastTelemetryPost: 0 };
      deviceMemory.set(deviceKey, mem);
    }

    const traits = eventData.resourceUpdate?.traits || {};
    const tConnectivity = traits['sdm.devices.traits.Connectivity'];
    const tTemp = traits['sdm.devices.traits.Temperature'];
    const tHumidity = traits['sdm.devices.traits.Humidity'];
    const tHvac = traits['sdm.devices.traits.ThermostatHvac'];
    const tFan = traits['sdm.devices.traits.Fan'];
    const tSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint'];
    const tMode = traits['sdm.devices.traits.ThermostatMode'];
    const tInfo = traits['sdm.devices.traits.Info'] || traits['sdm.devices.traits.DeviceInfo'] || {};
    const tSwUpdate = traits['sdm.devices.traits.SoftwareUpdate'] || {};

    if (tSwUpdate.currentVersion || tInfo.currentVersion) mem.firmwareVersion = tSwUpdate.currentVersion || tInfo.currentVersion;
    if (tInfo.serialNumber || tInfo.serial) mem.serialNumber = tInfo.serialNumber || tInfo.serial;

    let isReachable = mem.isReachable;
    if (tConnectivity) {
      isReachable = tConnectivity.status === 'ONLINE';
      if (mem.isReachable !== isReachable) {
        console.log('[REACHABILITY] ' + deviceKey + ' changed: ' + mem.isReachable + ' -> ' + isReachable);
        mem.isReachable = isReachable;
        await updateDeviceReachability(deviceKey, isReachable);
      }
    } else {
      isReachable = checkDeviceReachability(mem, nowMs);
      mem.isReachable = isReachable;
    }

    mem.lastEventTime = nowMs;

    let hvacChanged = false, fanChanged = false, modeChanged = false, telemetryChanged = false, setpointChanged = false;

    if (tHvac && tHvac.status) {
      const newStatus = tHvac.status;
      if (mem.equipmentStatus !== newStatus) {
        console.log('[HVAC] ' + deviceKey + ' equipment status: ' + mem.equipmentStatus + ' -> ' + newStatus);
        mem.equipmentStatus = newStatus;
        hvacChanged = true;
      }
    }

    if (tFan && tFan.timerMode !== undefined) {
      const newFanState = tFan.timerMode === 'ON';
      if (mem.isFanTimerOn !== newFanState) {
        console.log('[FAN] ' + deviceKey + ' fan timer: ' + mem.isFanTimerOn + ' -> ' + newFanState);
        mem.isFanTimerOn = newFanState;
        fanChanged = true;
      }
    }

    if (tMode && tMode.mode) {
      const rawMode = tMode.mode;
      const mappedMode = mapNestModeToStandard(rawMode);
      if (mem.thermostatMode !== rawMode) {
        console.log('[MODE] ' + deviceKey + ' mode: ' + mem.thermostatMode + ' -> ' + rawMode + ' (mapped: ' + mappedMode + ')');
        mem.thermostatMode = rawMode;
        mem.thermostatModeMapped = mappedMode;
        modeChanged = true;
      }
    }

    if (tTemp && typeof tTemp.ambientTemperatureCelsius === 'number') {
      const tempC = tTemp.ambientTemperatureCelsius;
      const tempF = celsiusToFahrenheit(tempC);
      mem.lastTemperatureC = tempC;
      mem.lastTemperatureF = tempF;
      telemetryChanged = true;
      console.log('[TEMP] ' + deviceKey + ' temperature: ' + tempF + '°F');
    }

    if (tHumidity && typeof tHumidity.ambientHumidityPercent === 'number') {
      mem.lastHumidity = tHumidity.ambientHumidityPercent;
      telemetryChanged = true;
      console.log('[HUMIDITY] ' + deviceKey + ' humidity: ' + mem.lastHumidity + '%');
    }

    if (tSetpoint) {
      if (typeof tSetpoint.heatCelsius === 'number') {
        const newHeat = celsiusToFahrenheit(tSetpoint.heatCelsius);
        if (mem.lastHeatSetpoint !== newHeat) {
          mem.lastHeatSetpoint = newHeat;
          setpointChanged = true;
          console.log('[SETPOINT] ' + deviceKey + ' heat setpoint: ' + newHeat + '°F');
        }
      }
      if (typeof tSetpoint.coolCelsius === 'number') {
        const newCool = celsiusToFahrenheit(tSetpoint.coolCelsius);
        if (mem.lastCoolSetpoint !== newCool) {
          mem.lastCoolSetpoint = newCool;
          setpointChanged = true;
          console.log('[SETPOINT] ' + deviceKey + ' cool setpoint: ' + newCool + '°F');
        }
      }
    }

    if (telemetryChanged) await handleTelemetryUpdate(deviceKey, mem.lastTemperatureF, mem.lastTemperatureC, mem.lastHumidity);

    const state = classifyCurrentState(mem);
    const isActiveNow = state.isActive;
    const wasActive = mem.running;
    const prevStateLabel = mem.currentStateLabel;
    const stateLabelChanged = state.stateLabel !== prevStateLabel;

    console.log('\n[STATE] ' + deviceKey + ':');
    console.log('  Current: ' + state.stateLabel + ' (' + state.equipmentStatus + ')');
    console.log('  Previous: ' + prevStateLabel + ' (' + mem.currentEquipmentStatus + ')');
    console.log('  Active: ' + isActiveNow + ' (was: ' + wasActive + ')');
    console.log('  Equipment: ' + mem.equipmentStatus + ', Fan: ' + mem.isFanTimerOn);
    console.log('  Mode: ' + mem.thermostatMode + ' -> ' + (mem.thermostatModeMapped || mapNestModeToStandard(mem.thermostatMode)));
    console.log('  Changes: hvac=' + hvacChanged + ', fan=' + fanChanged + ', mode=' + modeChanged + ', telemetry=' + telemetryChanged + ', setpoint=' + setpointChanged);

    let runtimeSeconds = null;
    if ((stateLabelChanged || (!isActiveNow && wasActive)) && mem.sessionStartedAt) {
      runtimeSeconds = Math.max(0, Math.round((nowMs - mem.sessionStartedAt.getTime()) / 1000));
      console.log('[RUNTIME] Calculated: ' + runtimeSeconds + 's');
    }

    const isStateChangingEvent = hvacChanged || fanChanged;
    const mappedMode = mem.thermostatModeMapped || mapNestModeToStandard(mem.thermostatMode);

    if (isActiveNow && !wasActive) {
      console.log('[ACTION] START NEW RUNTIME SESSION');
      await startRuntimeSession({ deviceKey, userId, deviceName, mem, state, mappedMode, previousStatus: prevStateLabel, now, nowMs, eventData });
    } else if (!isActiveNow && wasActive) {
      console.log('[ACTION] END RUNTIME SESSION');
      await endRuntimeSession({ deviceKey, userId, deviceName, mem, state, previousStatus: prevStateLabel, runtimeSeconds, mappedMode, now, eventData });
    } else if (isActiveNow && stateLabelChanged) {
      console.log('[ACTION] MODE SWITCH');
      await modeSwitchSession({ deviceKey, userId, deviceName, mem, state, previousStatus: prevStateLabel, runtimeSeconds, mappedMode, now, nowMs, eventData });
    } else if (isActiveNow && wasActive) {
      await updateRuntimeSession({ deviceKey, mem, state, now });
      if (isStateChangingEvent) {
        console.log('[ACTION] STATE CHANGE UPDATE (active)');
        await postCoreEvent({ deviceKey, userId, deviceName, firmwareVersion: mem.firmwareVersion, serialNumber: mem.serialNumber, eventType: 'Mode_Change', equipmentStatus: state.equipmentStatus, previousStatus: prevStateLabel, isActive: true, isReachable, runtimeSeconds: null, temperatureF: mem.lastTemperatureF, humidity: mem.lastHumidity, heatSetpoint: mem.lastHeatSetpoint, coolSetpoint: mem.lastCoolSetpoint, thermostatMode: mappedMode, observedAt: now, sourceEventId: uuidv4(), eventData });
      } else if (telemetryChanged || setpointChanged || modeChanged) {
        console.log('[ACTION] TELEMETRY UPDATE (active)');
        await postCoreEvent({ deviceKey, userId, deviceName, firmwareVersion: mem.firmwareVersion, serialNumber: mem.serialNumber, eventType: 'Telemetry_Update', equipmentStatus: state.equipmentStatus, previousStatus: prevStateLabel, isActive: true, isReachable, runtimeSeconds: null, temperatureF: mem.lastTemperatureF, humidity: mem.lastHumidity, heatSetpoint: mem.lastHeatSetpoint, coolSetpoint: mem.lastCoolSetpoint, thermostatMode: mappedMode, observedAt: now, sourceEventId: uuidv4(), eventData });
      }
    } else {
      const timeExceeded = (nowMs - mem.lastTelemetryPost) >= 900000;
      const shouldPost = (setpointChanged || modeChanged) || (telemetryChanged && timeExceeded);
      if (shouldPost) {
        console.log('[ACTION] TELEMETRY UPDATE (idle)');
        await postCoreEvent({ deviceKey, userId, deviceName, firmwareVersion: mem.firmwareVersion, serialNumber: mem.serialNumber, eventType: 'Telemetry_Update', equipmentStatus: 'IDLE', previousStatus: prevStateLabel, isActive: false, isReachable, runtimeSeconds: null, temperatureF: mem.lastTemperatureF, humidity: mem.lastHumidity, heatSetpoint: mem.lastHeatSetpoint, coolSetpoint: mem.lastCoolSetpoint, thermostatMode: mappedMode, observedAt: now, sourceEventId: uuidv4(), eventData });
        mem.lastTelemetryPost = nowMs;
      }
    }

    mem.currentStateLabel = state.stateLabel;
    mem.currentEquipmentStatus = state.equipmentStatus;
  } catch (error) {
    console.error('[runtimeTracker] Error handling device event:', error);
    console.error(error.stack);
  }
}

async function startRuntimeSession(params) {
  const pool = getPool();
  const sessionId = uuidv4();
  const mode = params.state.stateLabel.toLowerCase();
  console.log('[SESSION START] ' + params.deviceKey + ' -> ' + params.state.stateLabel);
  await pool.query('INSERT INTO runtime_sessions (device_key, session_id, mode, equipment_status, started_at, start_temperature, heat_setpoint, cool_setpoint, tick_count, last_tick_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$5,NOW())', [params.deviceKey, sessionId, mode, params.state.equipmentStatus, params.now, params.mem.lastTemperatureF, params.mem.lastHeatSetpoint, params.mem.lastCoolSetpoint]);
  await pool.query('UPDATE device_status SET is_running = TRUE, session_started_at = $2, current_mode = $3, current_equipment_status = $4, last_heat_setpoint = COALESCE($5, last_heat_setpoint), last_cool_setpoint = COALESCE($6, last_cool_setpoint), updated_at = $2 WHERE device_key = $1', [params.deviceKey, params.now, mode, params.state.equipmentStatus, params.mem.lastHeatSetpoint, params.mem.lastCoolSetpoint]);
  params.mem.running = true;
  params.mem.sessionId = sessionId;
  params.mem.sessionStartedAt = params.now;
  await postCoreEvent({ deviceKey: params.deviceKey, userId: params.userId, deviceName: params.deviceName, firmwareVersion: params.mem.firmwareVersion, serialNumber: params.mem.serialNumber, eventType: 'Mode_Change', equipmentStatus: params.state.equipmentStatus, previousStatus: params.previousStatus, isActive: true, isReachable: params.mem.isReachable, runtimeSeconds: undefined, temperatureF: params.mem.lastTemperatureF, humidity: params.mem.lastHumidity, heatSetpoint: params.mem.lastHeatSetpoint, coolSetpoint: params.mem.lastCoolSetpoint, thermostatMode: params.mappedMode, observedAt: params.now, sourceEventId: uuidv4(), eventData: params.eventData });
}

async function endRuntimeSession(params) {
  const pool = getPool();
  console.log('[SESSION END] ' + params.deviceKey + ' -> ' + params.state.stateLabel + ', runtime=' + params.runtimeSeconds + 's');
  await pool.query('UPDATE runtime_sessions SET ended_at = $2, duration_seconds = $3, updated_at = $2 WHERE session_id = $1', [params.mem.sessionId, params.now, params.runtimeSeconds]);
  await pool.query('UPDATE device_status SET is_running = FALSE, session_started_at = NULL, last_equipment_status = current_equipment_status, current_equipment_status = $2, current_mode = $3, updated_at = $4 WHERE device_key = $1', [params.deviceKey, 'IDLE', 'off', params.now]);
  params.mem.running = false;
  params.mem.sessionId = null;
  params.mem.sessionStartedAt = null;
  await postCoreEvent({ deviceKey: params.deviceKey, userId: params.userId, deviceName: params.deviceName, firmwareVersion: params.mem.firmwareVersion, serialNumber: params.mem.serialNumber, eventType: 'Mode_Change', equipmentStatus: 'IDLE', previousStatus: params.previousStatus, isActive: false, isReachable: params.mem.isReachable, runtimeSeconds: params.runtimeSeconds, temperatureF: params.mem.lastTemperatureF, humidity: params.mem.lastHumidity, heatSetpoint: params.mem.lastHeatSetpoint, coolSetpoint: params.mem.lastCoolSetpoint, thermostatMode: params.mappedMode, observedAt: params.now, sourceEventId: uuidv4(), eventData: params.eventData });
}

async function modeSwitchSession(params) {
  const pool = getPool();
  const oldSessionId = params.mem.sessionId;
  const newSessionId = uuidv4();
  console.log('[MODE SWITCH] ' + params.deviceKey + ' ' + params.previousStatus + ' -> ' + params.state.stateLabel + ', runtime=' + params.runtimeSeconds + 's');
  await pool.query('UPDATE runtime_sessions SET ended_at = $2, duration_seconds = $3, updated_at = $2 WHERE session_id = $1', [oldSessionId, params.now, params.runtimeSeconds]);
  const mode = params.state.stateLabel.toLowerCase();
  await pool.query('INSERT INTO runtime_sessions (device_key, session_id, mode, equipment_status, started_at, start_temperature, heat_setpoint, cool_setpoint, tick_count, last_tick_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$5,NOW())', [params.deviceKey, newSessionId, mode, params.state.equipmentStatus, params.now, params.mem.lastTemperatureF, params.mem.lastHeatSetpoint, params.mem.lastCoolSetpoint]);
  await pool.query('UPDATE device_status SET current_mode = $2, current_equipment_status = $3, session_started_at = $4, updated_at = $4 WHERE device_key = $1', [params.deviceKey, mode, params.state.equipmentStatus, params.now]);
  params.mem.sessionId = newSessionId;
  params.mem.sessionStartedAt = params.now;
  await postCoreEvent({ deviceKey: params.deviceKey, userId: params.userId, deviceName: params.deviceName, firmwareVersion: params.mem.firmwareVersion, serialNumber: params.mem.serialNumber, eventType: 'Mode_Change', equipmentStatus: params.state.equipmentStatus, previousStatus: params.previousStatus, isActive: true, isReachable: params.mem.isReachable, runtimeSeconds: params.runtimeSeconds, temperatureF: params.mem.lastTemperatureF, humidity: params.mem.lastHumidity, heatSetpoint: params.mem.lastHeatSetpoint, coolSetpoint: params.mem.lastCoolSetpoint, thermostatMode: params.mappedMode, observedAt: params.now, sourceEventId: uuidv4(), eventData: params.eventData });
}

async function updateRuntimeSession(params) {
  const pool = getPool();
  try {
    await pool.query('UPDATE runtime_sessions SET tick_count = tick_count + 1, last_tick_at = $2, heat_setpoint = COALESCE($3, heat_setpoint), cool_setpoint = COALESCE($4, cool_setpoint), updated_at = $2 WHERE session_id = $1', [params.mem.sessionId, params.now, params.mem.lastHeatSetpoint, params.mem.lastCoolSetpoint]);
    await pool.query('UPDATE device_status SET current_equipment_status = $2, last_heat_setpoint = COALESCE($3, last_heat_setpoint), last_cool_setpoint = COALESCE($4, last_cool_setpoint), updated_at = NOW() WHERE device_key = $1', [params.deviceKey, params.state.equipmentStatus, params.mem.lastHeatSetpoint, params.mem.lastCoolSetpoint]);
  } catch (error) {
    console.error('[runtimeTracker] Error updating runtime session:', error);
  }
}

async function handleTelemetryUpdate(deviceKey, tempF, tempC, humidity) {
  const pool = getPool();
  try {
    const updates = [];
    const params = [deviceKey];
    let paramIndex = 2;
    if (tempF !== null) { updates.push('last_temperature = $' + paramIndex); params.push(tempF); paramIndex++; }
    if (humidity !== null) { updates.push('last_humidity = $' + paramIndex); params.push(humidity); paramIndex++; }
    if (updates.length > 0) {
      updates.push('last_seen_at = NOW()', 'updated_at = NOW()');
      await pool.query('UPDATE device_status SET ' + updates.join(', ') + ' WHERE device_key = $1', params);
    }
    if (tempF !== null) {
      await pool.query('INSERT INTO temp_readings (device_key, temperature, units, event_type, session_id, recorded_at, created_at) VALUES ($1, $2, $3, $4, (SELECT session_id FROM runtime_sessions WHERE device_key = $1 AND ended_at IS NULL LIMIT 1), NOW(), NOW())', [deviceKey, tempF, 'F', 'temperature_update']);
    }
  } catch (error) {
    console.error('[runtimeTracker] Error handling telemetry update:', error);
  }
}

module.exports = { handleDeviceEvent, recoverActiveSessions, deviceMemory };
