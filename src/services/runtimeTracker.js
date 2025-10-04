const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');

// In-memory tracking of active devices
const activeDevices = new Map();

// Device info cache to reduce DB queries
const deviceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
      
      // Populate cache
      deviceCache.set(row.device_key, {
        deviceName: row.device_name,
        userId: row.frontend_id,
        cachedAt: Date.now()
      });
      
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
    
    // Use event timestamp if available, otherwise use server time
    const eventTimestamp = eventData.timestamp ? new Date(eventData.timestamp) : new Date();
    const serverTime = new Date();
    
    const delay = Math.floor((serverTime - eventTimestamp) / 1000);
    if (delay > 60) {
      console.log(`⚠️ Event delayed ${delay}s (${Math.floor(delay/60)}min) - Device: ${deviceKey}`);
    }
    
    if (!deviceKey) {
      console.error('Could not extract device key from event');
      return;
    }
    
    // Ensure device exists (with caching)
    await ensureDeviceExists(deviceKey, userId, deviceName);
    
    const traits = eventData.resourceUpdate?.traits || {};
    
    // Parallel processing of independent traits
    const processingPromises = [];
    
    // Handle connectivity
    if (traits['sdm.devices.traits.Connectivity']) {
      const isReachable = traits['sdm.devices.traits.Connectivity'].status === 'ONLINE';
      processingPromises.push(
        updateDeviceReachability(deviceKey, isReachable, eventTimestamp)
      );
    }
    
    // Handle temperature
    if (traits['sdm.devices.traits.Temperature']) {
      const tempC = traits['sdm.devices.traits.Temperature'].ambientTemperatureCelsius;
      const tempF = celsiusToFahrenheit(tempC);
      processingPromises.push(
        handleTemperatureChange(deviceKey, tempF, tempC, userId, eventTimestamp)
          .catch(err => console.error('Temp update failed:', err.message))
      );
    }
    
    // Wait for parallel operations
    if (processingPromises.length > 0) {
      await Promise.all(processingPromises);
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
    
    // If this event doesn't contain equipment status or fan info, fetch from database
    if (equipmentStatus === null || isFanTimerOn === null) {
      const currentState = await pool.query(`
        SELECT current_equipment_status, last_fan_status 
        FROM device_status 
        WHERE device_key = $1
      `, [deviceKey]);
      
      if (currentState.rows.length > 0) {
        if (equipmentStatus === null) {
          equipmentStatus = currentState.rows[0].current_equipment_status || 'OFF';
        }
        if (isFanTimerOn === null) {
          isFanTimerOn = currentState.rows[0].last_fan_status === 'ON';
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
      coolSetpoint,
      eventTimestamp
    );
    
  } catch (error) {
    console.error(`Event processing failed for ${deviceKey}:`, error.message);
    // Don't throw - let other events continue processing
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
  coolSetpoint,
  eventTimestamp
) {
  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isOff = equipmentStatus === 'OFF';
  
  const shouldBeActive = isHeating || isCooling || isFanTimerOn;
  const currentState = activeDevices.get(deviceKey);
  const wasActive = !!currentState;
  
  // CHECK FOR STALE SESSION
  if (wasActive && isOff && !isFanTimerOn) {
    const minutesSinceStart = (eventTimestamp - currentState.sessionStartedAt) / 1000 / 60;
    const ACTIVITY_TIMEOUT_MINUTES = 20;
    
    if (minutesSinceStart > ACTIVITY_TIMEOUT_MINUTES) {
      await endRuntimeSession(deviceKey, userId, deviceName, 'OFF', eventTimestamp);
      return;
    }
  }
  
  if (shouldBeActive && !wasActive) {
    await startRuntimeSession(
      deviceKey, userId, deviceName, equipmentStatus,
      isFanTimerOn, thermostatMode, heatSetpoint, coolSetpoint, eventTimestamp
    );
  } else if (!shouldBeActive && wasActive) {
    await endRuntimeSession(deviceKey, userId, deviceName, equipmentStatus, eventTimestamp);
  } else if (shouldBeActive && wasActive) {
    await updateRuntimeSession(
      deviceKey, equipmentStatus, isFanTimerOn, heatSetpoint, coolSetpoint, eventTimestamp
    );
  }
  
  // Log equipment event asynchronously (fire-and-forget)
  logEquipmentEvent(deviceKey, equipmentStatus, isFanTimerOn, currentState, eventTimestamp)
    .catch(err => console.error('Equipment log failed:', err.message));
}

async function startRuntimeSession(
  deviceKey,
  userId,
  deviceName,
  equipmentStatus,
  isFanTimerOn,
  thermostatMode,
  heatSetpoint,
  coolSetpoint,
  eventTimestamp
) {
  const pool = getPool();
  const sessionId = uuidv4();
  
  try {
    let mode = 'off';
    if (equipmentStatus === 'HEATING') mode = 'heating';
    else if (equipmentStatus === 'COOLING') mode = 'cooling';
    else if (isFanTimerOn) mode = 'fan_only';
    
    const tempResult = await pool.query(
      'SELECT last_temperature FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const startTemp = tempResult.rows[0]?.last_temperature || null;
    
    // Batch insert and update into single transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(`
        INSERT INTO runtime_sessions (
          device_key, session_id, mode, equipment_status,
          started_at, start_temperature, heat_setpoint, cool_setpoint,
          tick_count, last_tick_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $5)
      `, [
        deviceKey, sessionId, mode, equipmentStatus,
        eventTimestamp, startTemp, heatSetpoint, coolSetpoint
      ]);
      
      await client.query(`
        UPDATE device_status SET
          is_running = true,
          session_started_at = $2,
          current_mode = $3,
          current_equipment_status = $4,
          last_fan_status = $5,
          last_heat_setpoint = $6,
          last_cool_setpoint = $7,
          last_activity_at = $2,
          updated_at = NOW()
        WHERE device_key = $1
      `, [deviceKey, eventTimestamp, mode, equipmentStatus, isFanTimerOn ? 'ON' : 'OFF', heatSetpoint, coolSetpoint]);
      
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    
    activeDevices.set(deviceKey, {
      deviceKey,
      frontendId: userId,
      deviceName,
      sessionId,
      sessionStartedAt: eventTimestamp,
      currentMode: mode,
      currentEquipmentStatus: equipmentStatus,
      startTemperature: startTemp,
      isHeating: equipmentStatus === 'HEATING',
      isCooling: equipmentStatus === 'COOLING',
      isFanOnly: isFanTimerOn,
      heatSetpoint,
      coolSetpoint
    });
    
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
      timestamp: eventTimestamp.toISOString(),
      eventId: uuidv4(),
      eventTimestamp: eventTimestamp.getTime()
    });
    
  } catch (error) {
    console.error('Error starting runtime session:', error);
    throw error;
  }
}

async function endRuntimeSession(deviceKey, userId, deviceName, finalEquipmentStatus, eventTimestamp) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  
  if (!deviceState) {
    return;
  }
  
  const runtimeSeconds = Math.floor((eventTimestamp - deviceState.sessionStartedAt) / 1000);
  const fanTailSeconds = parseInt(process.env.LAST_FAN_TAIL_SECONDS || '0', 10);
  const totalRuntimeSeconds = runtimeSeconds + fanTailSeconds;
  
  try {
    const tempResult = await pool.query(
      'SELECT last_temperature FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const endTemp = tempResult.rows[0]?.last_temperature || null;
    
    const lastWasCooling = deviceState.isCooling;
    const lastWasHeating = deviceState.isHeating;
    const lastWasFanOnly = deviceState.isFanOnly && !deviceState.isHeating && !deviceState.isCooling;
    
    // Batch update in transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(`
        UPDATE runtime_sessions SET
          ended_at = $2,
          duration_seconds = $3,
          end_temperature = $4,
          updated_at = NOW()
        WHERE session_id = $1
      `, [deviceState.sessionId, eventTimestamp, runtimeSeconds, endTemp]);
      
      await client.query(`
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
          updated_at = NOW()
        WHERE device_key = $1
      `, [
        deviceKey,
        deviceState.currentEquipmentStatus,
        deviceState.currentMode,
        lastWasCooling,
        lastWasHeating,
        lastWasFanOnly,
        eventTimestamp,
        fanTailSeconds > 0 ? new Date(eventTimestamp.getTime() + fanTailSeconds * 1000) : null
      ]);
      
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    
    const reachableResult = await pool.query(
      'SELECT is_reachable FROM device_status WHERE device_key = $1',
      [deviceKey]
    );
    const isReachable = reachableResult.rows[0]?.is_reachable ?? true;
    
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
        timestamp: eventTimestamp.toISOString(),
        eventId: uuidv4(),
        eventTimestamp: eventTimestamp.getTime()
      });
    }
    
    activeDevices.delete(deviceKey);
  } catch (error) {
    console.error('Error ending runtime session:', error);
    throw error;
  }
}

async function updateRuntimeSession(
  deviceKey,
  equipmentStatus,
  isFanTimerOn,
  heatSetpoint,
  coolSetpoint,
  eventTimestamp
) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  
  if (!deviceState) return;
  
  try {
    // Batch updates
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(`
        UPDATE runtime_sessions SET
          tick_count = tick_count + 1,
          last_tick_at = $2,
          heat_setpoint = $3,
          cool_setpoint = $4,
          updated_at = NOW()
        WHERE session_id = $1
      `, [deviceState.sessionId, eventTimestamp, heatSetpoint, coolSetpoint]);
      
      await client.query(`
        UPDATE device_status SET
          last_fan_status = $2,
          current_equipment_status = $3,
          updated_at = NOW()
        WHERE device_key = $1
      `, [deviceKey, isFanTimerOn ? 'ON' : 'OFF', equipmentStatus]);
      
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    
    deviceState.isHeating = equipmentStatus === 'HEATING';
    deviceState.isCooling = equipmentStatus === 'COOLING';
    deviceState.isFanOnly = isFanTimerOn;
    deviceState.currentEquipmentStatus = equipmentStatus;
    deviceState.heatSetpoint = heatSetpoint;
    deviceState.coolSetpoint = coolSetpoint;
    
  } catch (error) {
    console.error('Error updating runtime session:', error);
  }
}

async function handleTemperatureChange(deviceKey, tempF, tempC, userId, eventTimestamp) {
  const pool = getPool();
  
  try {
    const deviceState = activeDevices.get(deviceKey);
    const sessionId = deviceState?.sessionId || null;
    const isHvacActive = !!deviceState;
    
    // Batch insert and update in transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      await client.query(`
        UPDATE device_status SET
          last_temperature = $2,
          last_seen_at = $3,
          updated_at = NOW()
        WHERE device_key = $1
      `, [deviceKey, tempF, eventTimestamp]);
      
      await client.query(`
        INSERT INTO temp_readings (
          device_key, temperature, units, event_type, session_id, recorded_at
        ) VALUES ($1, $2, 'F', 'temperature_update', $3, $4)
      `, [deviceKey, tempF, sessionId, eventTimestamp]);
      
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    
    const deviceResult = await pool.query(`
      SELECT device_name, is_reachable, current_mode, current_equipment_status,
             last_was_cooling, last_was_heating, last_was_fan_only
      FROM device_status
      WHERE device_key = $1
    `, [deviceKey]);
    
    if (deviceResult.rows.length === 0) {
      return;
    }
    
    const device = deviceResult.rows[0];
    const currentMode = device.current_mode || 'off';
    
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
      timestamp: eventTimestamp.toISOString(),
      eventId: uuidv4(),
      eventTimestamp: eventTimestamp.getTime()
    });
    
  } catch (error) {
    console.error('Error handling temperature change:', error);
    throw error;
  }
}

async function updateDeviceReachability(deviceKey, isReachable, eventTimestamp) {
  const pool = getPool();
  
  try {
    await pool.query(`
      UPDATE device_status SET
        is_reachable = $2,
        last_seen_at = $3,
        updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, isReachable, eventTimestamp]);
  } catch (error) {
    console.error('Error updating device reachability:', error);
  }
}

async function logEquipmentEvent(deviceKey, equipmentStatus, isFanTimerOn, previousState, eventTimestamp) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  
  try {
    await pool.query(`
      INSERT INTO equipment_events (
        device_key, event_type, equipment_status, previous_status,
        is_active, session_id, event_data, recorded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      deviceKey,
      'status_change',
      equipmentStatus,
      previousState?.currentEquipmentStatus || 'unknown',
      !!deviceState,
      deviceState?.sessionId || null,
      JSON.stringify({ isFanTimerOn }),
      eventTimestamp
    ]);
  } catch (error) {
    console.error('Error logging equipment event:', error);
  }
}

async function ensureDeviceExists(deviceKey, userId, deviceName) {
  // Check cache first
  const cached = deviceCache.get(deviceKey);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
    return; // Device exists, cache still valid
  }
  
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
    
    // Update cache
    deviceCache.set(deviceKey, {
      deviceName,
      userId,
      cachedAt: Date.now()
    });
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