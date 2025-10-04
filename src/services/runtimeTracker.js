const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');

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
        console.log(`Skipping stale session for ${row.device_key} - age: ${sessionAge.toFixed(1)} hours`);
        
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
      console.log(`Recovered active session for device: ${row.device_key} (age: ${sessionAge.toFixed(1)} hours)`);
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
    
    // Handle connectivity
    if (traits['sdm.devices.traits.Connectivity']) {
      const isReachable = traits['sdm.devices.traits.Connectivity'].status === 'ONLINE';
      await updateDeviceReachability(deviceKey, isReachable);
    }
    
    // Handle temperature
    if (traits['sdm.devices.traits.Temperature']) {
      const tempC = traits['sdm.devices.traits.Temperature'].ambientTemperatureCelsius;
      const tempF = celsiusToFahrenheit(tempC);
      try {
        handleTemperatureChange(deviceKey, tempF, tempC, userId).catch(err => {
          console.error('Error in handleTemperatureChange (non-blocking):', err);
        });
      } catch (error) {
        console.error('Error calling handleTemperatureChange:', error);
      }
    }
    
    // Handle thermostat mode
    let thermostatMode = null;
    if (traits['sdm.devices.traits.ThermostatMode']) {
      thermostatMode = traits['sdm.devices.traits.ThermostatMode'].mode;
    }
    
    // Handle equipment status
    let equipmentStatus = null;
    if (traits['sdm.devices.traits.ThermostatHvac']) {
      equipmentStatus = traits['sdm.devices.traits.ThermostatHvac'].status;
    }
    
    // Handle fan timer
    let isFanTimerOn = null;
    if (traits['sdm.devices.traits.Fan']) {
      isFanTimerOn = traits['sdm.devices.traits.Fan'].timerMode === 'ON';
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
    }
    
    // DEBUG: Log what we extracted from webhook
    console.log('DEBUG - Extracted from webhook:', {
      thermostatMode,
      equipmentStatus,
      isFanTimerOn,
      hasActiveSession: activeDevices.has(deviceKey)
    });
    
    // If this event doesn't contain equipment status or fan info, fetch from database
    if (equipmentStatus === null || isFanTimerOn === null) {
      console.log('DEBUG - Fetching missing data from database...');
      const currentState = await pool.query(`
        SELECT current_equipment_status, last_fan_status 
        FROM device_status 
        WHERE device_key = $1
      `, [deviceKey]);
      
      if (currentState.rows.length > 0) {
        if (equipmentStatus === null) {
          equipmentStatus = currentState.rows[0].current_equipment_status || 'OFF';
          console.log(`DEBUG - Equipment Status from DB: ${equipmentStatus}`);
        }
        if (isFanTimerOn === null) {
          isFanTimerOn = currentState.rows[0].last_fan_status === 'ON';
          console.log(`DEBUG - Fan Timer from DB: ${isFanTimerOn ? 'ON' : 'OFF'}`);
        }
      } else {
        if (equipmentStatus === null) equipmentStatus = 'OFF';
        if (isFanTimerOn === null) isFanTimerOn = false;
      }
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
    
  } catch (error) {
    console.error('Error handling device event:', error);
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
  console.log('\n=== RUNTIME LOGIC EVALUATION ===');
  
  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isOff = equipmentStatus === 'OFF';
  
  console.log('Equipment Status:', equipmentStatus);
  console.log('  - Heating:', isHeating);
  console.log('  - Cooling:', isCooling);
  console.log('  - Off:', isOff);
  console.log('Fan Timer:', isFanTimerOn ? 'ON' : 'OFF');
  
  const shouldBeActive = isHeating || isCooling || isFanTimerOn;
  const currentState = activeDevices.get(deviceKey);
  const wasActive = !!currentState;
  
  console.log('\nACTIVITY DETERMINATION:');
  console.log('Should be active:', shouldBeActive);
  console.log('  Reason:', isHeating ? 'Heating' : isCooling ? 'Cooling' : isFanTimerOn ? 'Fan Timer ON' : 'NONE');
  console.log('Was active:', wasActive);
  console.log('In-memory session exists:', currentState ? 'YES' : 'NO');
  
  if (shouldBeActive && !wasActive) {
    console.log('\nACTION: START NEW RUNTIME SESSION');
    await startRuntimeSession(
      deviceKey, userId, deviceName, equipmentStatus,
      isFanTimerOn, thermostatMode, heatSetpoint, coolSetpoint
    );
  } else if (!shouldBeActive && wasActive) {
    console.log('\nACTION: END RUNTIME SESSION');
    console.log(`  Both equipment OFF (${equipmentStatus}) AND fan OFF (${!isFanTimerOn})`);
    await endRuntimeSession(deviceKey, userId, deviceName, equipmentStatus);
  } else if (shouldBeActive && wasActive) {
    console.log('\nACTION: UPDATE EXISTING SESSION (still active)');
    const elapsed = Math.floor((new Date() - currentState.sessionStartedAt) / 1000);
    console.log(`  Session has been running for ${elapsed} seconds`);
    await updateRuntimeSession(
      deviceKey, equipmentStatus, isFanTimerOn, heatSetpoint, coolSetpoint
    );
  } else {
    console.log('\nACTION: NO CHANGE (system idle)');
  }
  
  console.log('=== RUNTIME LOGIC COMPLETE ===\n');
  
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
    
    console.log('Starting session:');
    console.log('  Mode:', mode);
    console.log('  Session ID:', sessionId);
    console.log('  Equipment:', equipmentStatus);
    console.log('  Fan Timer:', isFanTimerOn ? 'ON' : 'OFF');
    
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
        last_fan_status = $5,
        last_heat_setpoint = $6,
        last_cool_setpoint = $7,
        last_activity_at = $2,
        updated_at = $2
      WHERE device_key = $1
    `, [deviceKey, now, mode, equipmentStatus, isFanTimerOn ? 'ON' : 'OFF', heatSetpoint, coolSetpoint]);
    
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
    
    console.log('Session started at', now.toISOString());
    console.log('isHvacActive is now: TRUE');
    
    // POST TO BUBBLE - NON-BLOCKING
    const reachableResult = await pool.query(
      'SELECT is_reachable FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const isReachable = reachableResult.rows[0]?.is_reachable ?? true;
    
    postToBubbleAsync({
      userId: userId,
      thermostatId: deviceKey,
      deviceName: deviceName,
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: mode,
      isHvacActive: true,
      thermostatMode: mode.toUpperCase(),
      isReachable: isReachable,
      currentTempF: startTemp,
      currentTempC: startTemp ? (startTemp - 32) * 5/9 : null,
      lastIsCooling: false,
      lastIsHeating: false,
      lastIsFanOnly: false,
      lastEquipmentStatus: 'off',
      equipmentStatus: equipmentStatus.toLowerCase(),
      isFanOnly: isFanTimerOn,
      timestamp: now.toISOString(),
      eventId: uuidv4(),
      eventTimestamp: now.getTime()
    });
    
  } catch (error) {
    console.error('Error starting runtime session:', error);
    throw error;
  }
}

async function endRuntimeSession(deviceKey, userId, deviceName, finalEquipmentStatus) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  
  if (!deviceState) {
    console.log('No active session found - cannot end session');
    return;
  }
  
  const now = new Date();
  const runtimeSeconds = Math.floor((now - deviceState.sessionStartedAt) / 1000);
  const fanTailSeconds = parseInt(process.env.LAST_FAN_TAIL_SECONDS || '0', 10);
  const totalRuntimeSeconds = runtimeSeconds + fanTailSeconds;
  
  console.log('Ending session - Started:', deviceState.sessionStartedAt.toISOString());
  console.log('Runtime:', runtimeSeconds, 's +', fanTailSeconds, 's tail =', totalRuntimeSeconds, 's total');
  
  // CRITICAL: Delete from in-memory FIRST to prevent race conditions
  // This ensures subsequent webhooks won't see an active session
  activeDevices.delete(deviceKey);
  console.log('Cleared in-memory session state');
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const tempResult = await client.query(
      'SELECT last_temperature FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const endTemp = tempResult.rows[0]?.last_temperature || null;
    
    // Update runtime session
    await client.query(`
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
    
    // Update device status - mark as NOT running with OFF status
    await client.query(`
      UPDATE device_status SET
        is_running = false,
        session_started_at = NULL,
        current_equipment_status = 'OFF',
        current_mode = 'off',
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
    
    await client.query('COMMIT');
    console.log('Database transaction committed - state is now OFF');
    
    const reachableResult = await client.query(
      'SELECT is_reachable FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const isReachable = reachableResult.rows[0]?.is_reachable ?? true;
    
    console.log('isHvacActive is now: FALSE');
    
    if (totalRuntimeSeconds > 0) {
      postToBubbleAsync({
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
      console.log('Runtime was 0 seconds - skipping Bubble post');
    }
    
    console.log('Session ended successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    // Restore in-memory state on error
    activeDevices.set(deviceKey, deviceState);
    console.error('Error ending runtime session (rolled back):', error);
    throw error;
  } finally {
    client.release();
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
  
  console.log('Updating session - Elapsed:', elapsed, 's');
  
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
    
    await pool.query(`
      UPDATE device_status SET
        last_fan_status = $2,
        current_equipment_status = $3,
        updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, isFanTimerOn ? 'ON' : 'OFF', equipmentStatus]);
    
    deviceState.isHeating = equipmentStatus === 'HEATING';
    deviceState.isCooling = equipmentStatus === 'COOLING';
    deviceState.isFanOnly = isFanTimerOn;
    deviceState.currentEquipmentStatus = equipmentStatus;
    deviceState.heatSetpoint = heatSetpoint;
    deviceState.coolSetpoint = coolSetpoint;
    
    console.log('Session updated - isHvacActive: TRUE');
  } catch (error) {
    console.error('Error updating runtime session:', error);
  }
}

async function handleTemperatureChange(deviceKey, tempF, tempC, userId) {
  console.log('\nhandleTemperatureChange called for', deviceKey);
  const pool = getPool();
  
  try {
    await pool.query(`
      UPDATE device_status SET
        last_temperature = $2,
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, tempF]);
    
    console.log('Temperature updated in database:', tempF, 'F');
    
    const deviceState = activeDevices.get(deviceKey);
    const sessionId = deviceState?.sessionId || null;
    const isHvacActive = !!deviceState;
    
    await pool.query(`
      INSERT INTO temp_readings (
        device_key, temperature, units, event_type, session_id
      ) VALUES ($1, $2, 'F', 'temperature_update', $3)
    `, [deviceKey, tempF, sessionId]);
    
    console.log('Temperature reading logged to database');
    
    const deviceResult = await pool.query(`
      SELECT device_name, is_reachable, current_mode, current_equipment_status,
             last_was_cooling, last_was_heating, last_was_fan_only
      FROM device_status
      WHERE device_key = $1
    `, [deviceKey]);
    
    if (deviceResult.rows.length === 0) {
      console.log('Device not found in database - skipping Bubble post');
      return;
    }
    
    const device = deviceResult.rows[0];
    const currentMode = device.current_mode || 'off';
    
    console.log('Posting temperature to Bubble - isHvacActive:', isHvacActive);
    
    postToBubbleAsync({
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
    console.error('Error handling temperature change:', error);
    throw error;
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
    
    console.log('Device reachability updated');
  } catch (error) {
    console.error('Error updating device reachability:', error);
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
    console.error('Error logging equipment event:', error);
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
    console.error('Error ensuring device exists:', error);
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
  recoverActiveSessions,
  activeDevices
};