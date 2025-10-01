const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubble } = require('./bubblePoster');

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
    
    for (const row of result.rows) {
      const deviceState = {
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
      };
      
      activeDevices.set(row.device_key, deviceState);
      console.log(`✓ Recovered active session for device: ${row.device_key}`);
    }
    
    console.log(`✓ Recovered ${activeDevices.size} active session(s)`);
  } catch (error) {
    console.error('✗ Error recovering active sessions:', error);
  }
}

async function handleDeviceEvent(eventData) {
  console.log('\n========== PROCESSING DEVICE EVENT ==========');
  
  const pool = getPool();
  
  try {
    const deviceName = eventData.resourceUpdate?.name || eventData.eventId;
    const deviceKey = extractDeviceKey(deviceName);
    const userId = eventData.userId;
    
    console.log(`Device Key: ${deviceKey}`);
    console.log(`User ID: ${userId}`);
    
    if (!deviceKey) {
      console.error('✗ Could not extract device key from event');
      return;
    }
    
    await ensureDeviceExists(deviceKey, userId, deviceName);
    
    const traits = eventData.resourceUpdate?.traits || {};
    console.log('Traits received:', Object.keys(traits));
    
    // Handle connectivity
    if (traits['sdm.devices.traits.Connectivity']) {
      const isReachable = traits['sdm.devices.traits.Connectivity'].status === 'ONLINE';
      console.log(`Connectivity: ${isReachable ? 'ONLINE' : 'OFFLINE'}`);
      await updateDeviceReachability(deviceKey, isReachable);
    }
    
    // Handle temperature
    if (traits['sdm.devices.traits.Temperature']) {
      const tempC = traits['sdm.devices.traits.Temperature'].ambientTemperatureCelsius;
      const tempF = celsiusToFahrenheit(tempC);
      console.log(`Temperature: ${tempF}°F (${tempC}°C)`);
      await handleTemperatureChange(deviceKey, tempF, tempC, userId);
    }
    
    // Handle thermostat mode
    let thermostatMode = null;
    if (traits['sdm.devices.traits.ThermostatMode']) {
      thermostatMode = traits['sdm.devices.traits.ThermostatMode'].mode;
      console.log(`Thermostat Mode: ${thermostatMode}`);
    }
    
    // Handle equipment status
    let equipmentStatus = 'OFF';
    if (traits['sdm.devices.traits.ThermostatHvac']) {
      equipmentStatus = traits['sdm.devices.traits.ThermostatHvac'].status || 'OFF';
      console.log(`Equipment Status: ${equipmentStatus}`);
    }
    
    // Handle fan timer
    let isFanTimerOn = false;
    if (traits['sdm.devices.traits.Fan']) {
      isFanTimerOn = traits['sdm.devices.traits.Fan'].timerMode === 'ON';
      console.log(`Fan Timer: ${isFanTimerOn ? 'ON' : 'OFF'}`);
    }
    
    // Handle setpoints
    let heatSetpoint = null;
    let coolSetpoint = null;
    if (traits['sdm.devices.traits.ThermostatTemperatureSetpoint']) {
      const setpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint'];
      if (setpoint.heatCelsius) {
        heatSetpoint = celsiusToFahrenheit(setpoint.heatCelsius);
      }
      if (setpoint.coolCelsius) {
        coolSetpoint = celsiusToFahrenheit(setpoint.coolCelsius);
      }
      console.log(`Setpoints - Heat: ${heatSetpoint}°F, Cool: ${coolSetpoint}°F`);
    }
    
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
    
    console.log('========== EVENT PROCESSING COMPLETE ==========\n');
    
  } catch (error) {
    console.error('✗ Error handling device event:', error);
    throw error;
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
  console.log('\n--- RUNTIME LOGIC ---');
  
  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isOff = equipmentStatus === 'OFF';
  
  console.log(`Equipment State - Heating: ${isHeating}, Cooling: ${isCooling}, Off: ${isOff}`);
  console.log(`Fan Timer: ${isFanTimerOn}`);
  
  const shouldBeActive = isHeating || isCooling || isFanTimerOn;
  const currentState = activeDevices.get(deviceKey);
  const wasActive = !!currentState;
  
  console.log(`Should be active: ${shouldBeActive} (was active: ${wasActive})`);
  
  if (shouldBeActive && !wasActive) {
    console.log('→ ACTION: START NEW SESSION');
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
  } else if (!shouldBeActive && wasActive) {
    console.log('→ ACTION: END SESSION');
    await endRuntimeSession(deviceKey, userId, deviceName, equipmentStatus);
  } else if (shouldBeActive && wasActive) {
    console.log('→ ACTION: UPDATE EXISTING SESSION');
    await updateRuntimeSession(
      deviceKey,
      equipmentStatus,
      isFanTimerOn,
      heatSetpoint,
      coolSetpoint
    );
  } else {
    console.log('→ ACTION: NO CHANGE (idle)');
  }
  
  await logEquipmentEvent(deviceKey, equipmentStatus, isFanTimerOn, currentState);
}

async function startRuntimeSession(
  deviceKey,
  userId,
  deviceName,
  equipmentStatus,
  isFanTimerOn,
  thermostatMode,
  heatSetpoint,
  coolSetpoint
) {
  const pool = getPool();
  const sessionId = uuidv4();
  const now = new Date();
  
  try {
    let mode = 'off';
    if (equipmentStatus === 'HEATING') mode = 'heating';
    else if (equipmentStatus === 'COOLING') mode = 'cooling';
    else if (isFanTimerOn) mode = 'fan_only';
    
    console.log(`Starting session - Mode: ${mode}, Session ID: ${sessionId}`);
    
    const tempResult = await pool.query(
      'SELECT last_temperature FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const startTemp = tempResult.rows[0]?.last_temperature || null;
    
    await pool.query(`
      INSERT INTO runtime_sessions (
        device_key, session_id, mode, equipment_status,
        started_at, start_temperature, heat_setpoint, cool_setpoint,
        tick_count, last_tick_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $5)
    `, [
      deviceKey, sessionId, mode, equipmentStatus,
      now, startTemp, heatSetpoint, coolSetpoint
    ]);
    
    await pool.query(`
      UPDATE device_status SET
        is_running = true,
        session_started_at = $2,
        current_mode = $3,
        current_equipment_status = $4,
        last_heat_setpoint = $5,
        last_cool_setpoint = $6,
        last_activity_at = $2,
        updated_at = $2
      WHERE device_key = $1
    `, [deviceKey, now, mode, equipmentStatus, heatSetpoint, coolSetpoint]);
    
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
    
    console.log(`✓ Session started at ${now.toISOString()}`);
    console.log(`✓ isHvacActive is now: TRUE`);
  } catch (error) {
    console.error('✗ Error starting runtime session:', error);
    throw error;
  }
}

async function endRuntimeSession(deviceKey, userId, deviceName, finalEquipmentStatus) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  
  if (!deviceState) {
    console.log('✗ No active session found - cannot end session');
    return;
  }
  
  const now = new Date();
  const runtimeSeconds = Math.floor((now - deviceState.sessionStartedAt) / 1000);
  const fanTailSeconds = parseInt(process.env.LAST_FAN_TAIL_SECONDS || '0', 10);
  const totalRuntimeSeconds = runtimeSeconds + fanTailSeconds;
  
  console.log(`Ending session - Started: ${deviceState.sessionStartedAt.toISOString()}`);
  console.log(`Runtime: ${runtimeSeconds}s + ${fanTailSeconds}s tail = ${totalRuntimeSeconds}s total`);
  
  try {
    const tempResult = await pool.query(
      'SELECT last_temperature FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const endTemp = tempResult.rows[0]?.last_temperature || null;
    
    await pool.query(`
      UPDATE runtime_sessions SET
        ended_at = $2,
        duration_seconds = $3,
        end_temperature = $4,
        updated_at = $2
      WHERE session_id = $1
    `, [deviceState.sessionId, now, runtimeSeconds, endTemp]);
    
    const lastWasCooling = deviceState.isCooling;
    const lastWasHeating = deviceState.isHeating;
    const lastWasFanOnly = deviceState.isFanOnly && !deviceState.isHeating && !deviceState.isCooling;
    
    await pool.query(`
      UPDATE device_status SET
        is_running = false,
        session_started_at = NULL,
        last_equipment_status = $2,
        last_mode = $3,
        last_was_cooling = $4,
        last_was_heating = $5,
        last_was_fan_only = $6,
        last_activity_at = $7,
        last_post_at = $7,
        last_fan_tail_until = $8,
        updated_at = $7
      WHERE device_key = $1
    `, [
      deviceKey,
      deviceState.currentEquipmentStatus,
      deviceState.currentMode,
      lastWasCooling,
      lastWasHeating,
      lastWasFanOnly,
      now,
      fanTailSeconds > 0 ? new Date(now.getTime() + fanTailSeconds * 1000) : null
    ]);
    
    const reachableResult = await pool.query(
      'SELECT is_reachable FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const isReachable = reachableResult.rows[0]?.is_reachable ?? true;
    
    console.log(`✓ isHvacActive is now: FALSE`);
    
    if (totalRuntimeSeconds > 0) {
      console.log('\n>>> POSTING RUNTIME EVENT TO BUBBLE <<<');
      await postToBubble({
        userId: userId,
        thermostatId: deviceKey,
        deviceName: deviceName,
        runtimeSeconds: totalRuntimeSeconds,
        runtimeMinutes: Math.round(totalRuntimeSeconds / 60),
        isRuntimeEvent: true,
        hvacMode: deviceState.currentMode,
        isHvacActive: false,
        thermostatMode: deviceState.currentMode.toUpperCase(),
        isReachable: isReachable,
        currentTempF: null,
        currentTempC: null,
        lastIsCooling: lastWasCooling,
        lastIsHeating: lastWasHeating,
        lastIsFanOnly: lastWasFanOnly,
        lastEquipmentStatus: deviceState.currentEquipmentStatus.toLowerCase(),
        equipmentStatus: finalEquipmentStatus.toLowerCase(),
        isFanOnly: false,
        timestamp: now.toISOString(),
        eventId: uuidv4(),
        eventTimestamp: now.getTime()
      });
    } else {
      console.log('⊘ Runtime was 0 seconds - skipping Bubble post');
    }
    
    activeDevices.delete(deviceKey);
    console.log(`✓ Session ended successfully`);
  } catch (error) {
    console.error('✗ Error ending runtime session:', error);
    throw error;
  }
}

async function updateRuntimeSession(
  deviceKey,
  equipmentStatus,
  isFanTimerOn,
  heatSetpoint,
  coolSetpoint
) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  
  if (!deviceState) return;
  
  const now = new Date();
  const elapsed = Math.floor((now - deviceState.sessionStartedAt) / 1000);
  
  console.log(`Updating session - Elapsed: ${elapsed}s`);
  
  try {
    await pool.query(`
      UPDATE runtime_sessions SET
        tick_count = tick_count + 1,
        last_tick_at = $2,
        heat_setpoint = $3,
        cool_setpoint = $4,
        updated_at = $2
      WHERE session_id = $1
    `, [deviceState.sessionId, now, heatSetpoint, coolSetpoint]);
    
    deviceState.isHeating = equipmentStatus === 'HEATING';
    deviceState.isCooling = equipmentStatus === 'COOLING';
    deviceState.isFanOnly = isFanTimerOn;
    deviceState.currentEquipmentStatus = equipmentStatus;
    deviceState.heatSetpoint = heatSetpoint;
    deviceState.coolSetpoint = coolSetpoint;
    
    console.log(`✓ Session updated - isHvacActive: TRUE`);
  } catch (error) {
    console.error('✗ Error updating runtime session:', error);
  }
}

async function handleTemperatureChange(deviceKey, tempF, tempC, userId) {
  const pool = getPool();
  
  try {
    await pool.query(`
      UPDATE device_status SET
        last_temperature = $2,
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, tempF]);
    
    const deviceState = activeDevices.get(deviceKey);
    const sessionId = deviceState?.sessionId || null;
    const isHvacActive = !!deviceState;
    
    await pool.query(`
      INSERT INTO temp_readings (
        device_key, temperature, units, event_type, session_id
      ) VALUES ($1, $2, 'F', 'temperature_update', $3)
    `, [deviceKey, tempF, sessionId]);
    
    const deviceResult = await pool.query(`
      SELECT device_name, is_reachable, current_mode, current_equipment_status,
             last_was_cooling, last_was_heating, last_was_fan_only
      FROM device_status
      WHERE device_key = $1
    `, [deviceKey]);
    
    if (deviceResult.rows.length === 0) return;
    
    const device = deviceResult.rows[0];
    const currentMode = device.current_mode || 'off';
    
    console.log('\n>>> POSTING TEMPERATURE EVENT TO BUBBLE <<<');
    console.log(`isHvacActive: ${isHvacActive}`);
    
    await postToBubble({
      userId: userId,
      thermostatId: deviceKey,
      deviceName: device.device_name,
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: currentMode,
      isHvacActive: isHvacActive,
      thermostatMode: currentMode.toUpperCase(),
      isReachable: device.is_reachable ?? true,
      currentTempF: tempF,
      currentTempC: tempC,
      lastIsCooling: device.last_was_cooling || false,
      lastIsHeating: device.last_was_heating || false,
      lastIsFanOnly: device.last_was_fan_only || false,
      lastEquipmentStatus: device.current_equipment_status?.toLowerCase() || 'off',
      equipmentStatus: device.current_equipment_status?.toLowerCase() || 'off',
      isFanOnly: deviceState?.isFanOnly || false,
      timestamp: new Date().toISOString(),
      eventId: uuidv4(),
      eventTimestamp: Date.now()
    });
    
  } catch (error) {
    console.error('✗ Error handling temperature change:', error);
  }
}

async function updateDeviceReachability(deviceKey, isReachable) {
  const pool = getPool();
  
  try {
    await pool.query(`
      UPDATE device_status SET
        is_reachable = $2,
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, isReachable]);
    
    console.log(`✓ Device reachability updated`);
  } catch (error) {
    console.error('✗ Error updating device reachability:', error);
  }
}

async function logEquipmentEvent(deviceKey, equipmentStatus, isFanTimerOn, previousState) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  
  try {
    await pool.query(`
      INSERT INTO equipment_events (
        device_key, event_type, equipment_status, previous_status,
        is_active, session_id, event_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      deviceKey,
      'status_change',
      equipmentStatus,
      previousState?.currentEquipmentStatus || 'unknown',
      !!deviceState,
      deviceState?.sessionId || null,
      JSON.stringify({ isFanTimerOn })
    ]);
  } catch (error) {
    console.error('✗ Error logging equipment event:', error);
  }
}

async function ensureDeviceExists(deviceKey, userId, deviceName) {
  const pool = getPool();
  
  try {
    await pool.query(`
      INSERT INTO device_status (
        device_key, frontend_id, device_name, created_at, updated_at
      ) VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (device_key) DO UPDATE SET
        frontend_id = EXCLUDED.frontend_id,
        device_name = EXCLUDED.device_name,
        updated_at = NOW()
    `, [deviceKey, userId, deviceName]);
  } catch (error) {
    console.error('✗ Error ensuring device exists:', error);
  }
}

function extractDeviceKey(deviceName) {
  const parts = deviceName.split('/');
  return parts[parts.length - 1];
}

function celsiusToFahrenheit(celsius) {
  return Math.round((celsius * 9/5 + 32) * 100) / 100;
}

module.exports = {
  handleDeviceEvent,
  recoverActiveSessions
};
