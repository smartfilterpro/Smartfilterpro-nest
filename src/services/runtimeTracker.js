'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToCoreIngestAsync } = require('./ingestPoster');
const { buildCorePayload } = require('./buildCorePayload');

// ===========================
// In-memory active sessions
// ===========================
const activeDevices = new Map();
// deviceKey -> {
//   deviceKey, frontendId, deviceName,
//   sessionId, sessionStartedAt, currentMode,
//   currentEquipmentStatus, startTemperature,
//   isHeating, isCooling, isAuxHeat, isFanOnly,
//   heatSetpoint, coolSetpoint,
//   lastEventTime, isReachable
// }

// ===========================
// Reachability Check
// ===========================
function checkDeviceReachability(deviceState, nowMs) {
  if (!deviceState || !deviceState.lastEventTime) return true;
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const timeSinceLastEvent = nowMs - deviceState.lastEventTime;
  return timeSinceLastEvent <= TWO_HOURS_MS;
}

// ===========================
// State Classification (8-State System)
// ===========================
// ===========================
// State Classification (8-State System)
// ===========================
function classifyEquipmentState(equipmentStatus, isFanTimerOn, hvacMode) {
  const status = (equipmentStatus || 'OFF').toUpperCase();
  
  let eventType;
  let finalEquipmentStatus;
  let isActive;

  // Check for auxiliary heat (typically reported as 'AUX_HEATING' or detected via hvacMode)
  const isAuxHeat = status === 'AUX_HEATING' || status === 'EMERGENCY_HEAT';

  if (isAuxHeat) {
    // Auxiliary/Emergency heat (expensive)
    if (isFanTimerOn) {
      eventType = 'AuxHeat_Fan';
      finalEquipmentStatus = 'AUX_HEATING';
      isActive = true;
    } else {
      eventType = 'AuxHeat';
      finalEquipmentStatus = 'AUX_HEATING';
      isActive = true;
    }
  } else if (status === 'HEATING') {
    // Primary heating (heat pump, furnace)
    if (isFanTimerOn) {
      eventType = 'Heating_Fan';
      finalEquipmentStatus = 'HEATING';
      isActive = true;
    } else {
      eventType = 'Heating';
      finalEquipmentStatus = 'HEATING';
      isActive = true;
    }
  } else if (status === 'COOLING') {
    if (isFanTimerOn) {
      eventType = 'Cooling_Fan';
      finalEquipmentStatus = 'COOLING';
      isActive = true;
    } else {
      eventType = 'Cooling';
      finalEquipmentStatus = 'COOLING';
      isActive = true;
    }
  } else if (isFanTimerOn) {
    eventType = 'Fan_only';
    finalEquipmentStatus = 'FAN';
    isActive = true;
  } else {
    eventType = 'Idle';              // ✅ Changed from 'Fan_off'
    finalEquipmentStatus = 'IDLE';    // ✅ Changed from 'OFF'
    isActive = false;
  }

  return { eventType, equipmentStatus: finalEquipmentStatus, isActive };
}

// ===========================
// Runtime / Session Logic
// ===========================
async function processRuntimeLogic({
  eventData,
  deviceKey,
  userId,
  deviceName,
  equipmentStatus,
  isFanTimerOn,
  thermostatMode,
  heatSetpoint,
  coolSetpoint,
  temperatureF,
  humidity,
  firmwareVersion,
  serialNumber,
  isReachable,
  now,
  nowMs
}) {
  console.log('\n=== RUNTIME LOGIC EVALUATION ===');
  const pool = getPool();

  // Classify current state (8-state system)
  const label = classifyEquipmentState(equipmentStatus, isFanTimerOn, thermostatMode);
  const isActiveNow = label.isActive;

  const currentState = activeDevices.get(deviceKey);
  const wasActive = !!currentState;
  const prevEventType = currentState?.currentEventType || 'Idle';  // ✅ Changed from 'Fan_off'
  const equipmentModeChanged = wasActive && (label.eventType !== currentState.currentEventType);

  console.log('Equipment Status:', equipmentStatus);
  console.log('  - Event Type:', label.eventType);
  console.log('  - Equipment Status:', label.equipmentStatus);
  console.log('  - Active:', isActiveNow);
  console.log('Fan Timer:', isFanTimerOn ? 'ON' : 'OFF');
  console.log('Thermostat Mode:', thermostatMode);
  console.log('\nACTIVITY DETERMINATION:');
  console.log('Should be active:', isActiveNow);
  console.log('Was active:', wasActive);
  console.log('Equipment mode changed:', equipmentModeChanged);
  console.log('Previous event type:', currentState?.currentEventType || 'none');

  // Calculate runtime if transitioning
  let runtimeSeconds = null;
  if ((equipmentModeChanged || (!isActiveNow && wasActive)) && currentState?.sessionStartedAt) {
    runtimeSeconds = Math.max(0, Math.round((nowMs - currentState.sessionStartedAt.getTime()) / 1000));
    console.log(`[RUNTIME] Calculated: ${runtimeSeconds}s`);
  }

  // Session START (inactive → active)
  if (isActiveNow && !wasActive) {
    console.log('\nACTION: START NEW RUNTIME SESSION');
    await startRuntimeSession({
      deviceKey, userId, deviceName,
      label,
      thermostatMode,
      heatSetpoint,
      coolSetpoint,
      temperatureF,
      humidity,
      firmwareVersion,
      serialNumber,
      isReachable,
      eventData,
      now,
      prevEventType
    });

  // Session END (active → inactive)
  } else if (!isActiveNow && wasActive) {
    console.log('\nACTION: END RUNTIME SESSION');
    await endRuntimeSession({
      deviceKey, userId, deviceName,
      label,
      previousStatus: prevEventType,
      runtimeSeconds,
      temperatureF,
      humidity,
      heatSetpoint,
      coolSetpoint,
      thermostatMode,
      firmwareVersion,
      serialNumber,
      isReachable,
      eventData,
      now
    });

  // MODE SWITCH (equipment changes while active: Heating → Cooling, etc.)
  } else if (isActiveNow && equipmentModeChanged) {
    console.log('\nACTION: MODE SWITCH');
    await modeSwitchSession({
      deviceKey, userId, deviceName,
      label,
      previousStatus: prevEventType,
      runtimeSeconds,
      thermostatMode,
      heatSetpoint,
      coolSetpoint,
      temperatureF,
      humidity,
      firmwareVersion,
      serialNumber,
      isReachable,
      eventData,
      now,
      nowMs
    });

  // UPDATE existing session (no state change)
  } else if (isActiveNow && wasActive) {
    console.log('\nACTION: UPDATE EXISTING SESSION (still active)');
    const elapsed = Math.floor((nowMs - currentState.sessionStartedAt.getTime()) / 1000);
    console.log(`  Session has been running for ${elapsed} seconds`);
    await updateRuntimeSession({
      deviceKey,
      label,
      heatSetpoint,
      coolSetpoint,
      now
    });

  // TELEMETRY UPDATE (idle, no state change)
  } else {
    console.log('\nACTION: TELEMETRY UPDATE (system idle)');
    
    const backfill = await getBackfillState(deviceKey);
    const lastPostTime = currentState?.lastTelemetryPost || 0;
    const timeExceeded = (nowMs - lastPostTime) >= 15 * 60 * 1000; // 15 min
    
    if (timeExceeded) {
      await postCoreEvent({
        deviceKey,
        userId,
        deviceName,
        firmwareVersion,
        serialNumber,
        label: { 
          eventType: 'Telemetry_Update',     // ✅ Type of event
          equipmentStatus: 'IDLE'            // ✅ Current state
        },
        previousStatus: prevEventType,
        isActive: false,
        isReachable,
        runtimeSeconds: null,
        temperatureF: temperatureF ?? backfill?.last_temperature,
        humidity: humidity ?? backfill?.last_humidity,
        heatSetpoint: heatSetpoint ?? backfill?.last_heat_setpoint,
        coolSetpoint: coolSetpoint ?? backfill?.last_cool_setpoint,
        thermostatMode,
        observedAt: now,
        sourceEventId: uuidv4(),
        eventData
      });

      if (currentState) {
        currentState.lastTelemetryPost = nowMs;
      }
    }
  }

  console.log('=== RUNTIME LOGIC COMPLETE ===\n');
}

async function startRuntimeSession({
  deviceKey,
  userId,
  deviceName,
  label,
  thermostatMode,
  heatSetpoint,
  coolSetpoint,
  temperatureF,
  humidity,
  firmwareVersion,
  serialNumber,
  isReachable,
  eventData,
  now,
  prevEventType
}) {
  const pool = getPool();
  const sessionId = uuidv4();
  const mode = label.eventType.toLowerCase();

  console.log('[runtimeTracker] Starting session:', {
    sessionId, mode, equipmentStatus: label.equipmentStatus,
    startTempF: temperatureF, heatSetpoint, coolSetpoint
  });

  // Create runtime session
  await pool.query(`
    INSERT INTO runtime_sessions (
      device_key, session_id, mode, equipment_status,
      started_at, start_temperature, heat_setpoint, cool_setpoint,
      tick_count, last_tick_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$5,NOW())
  `, [deviceKey, sessionId, mode, label.equipmentStatus, now, temperatureF, heatSetpoint, coolSetpoint]);

  // Update device_status
  await pool.query(`
    UPDATE device_status SET
      is_running = TRUE,
      session_started_at = $2,
      current_mode = $3,
      current_equipment_status = $4,
      last_heat_setpoint = COALESCE($5, last_heat_setpoint),
      last_cool_setpoint = COALESCE($6, last_cool_setpoint),
      updated_at = $2
    WHERE device_key = $1
  `, [deviceKey, now, mode, label.equipmentStatus, heatSetpoint, coolSetpoint]);

  // Cache in memory
  activeDevices.set(deviceKey, {
    deviceKey,
    frontendId: userId,
    deviceName,
    sessionId,
    sessionStartedAt: now,
    currentMode: mode,
    currentEventType: label.eventType,
    currentEquipmentStatus: label.equipmentStatus,
    startTemperature: temperatureF,
    isHeating: label.equipmentStatus === 'HEATING',
    isCooling: label.equipmentStatus === 'COOLING',
    isAuxHeat: label.equipmentStatus === 'AUX_HEATING',
    isFanOnly: label.equipmentStatus === 'FAN',
    heatSetpoint,
    coolSetpoint,
    lastEventTime: now.getTime(),
    lastTelemetryPost: now.getTime(),
    isReachable
  });

  // Post to Core with Mode_Change
  await postCoreEvent({
    deviceKey,
    userId,
    deviceName,
    firmwareVersion,
    serialNumber,
    label: {
      eventType: 'Mode_Change',           // ✅ Event type
      equipmentStatus: label.equipmentStatus  // ✅ Current state
    },
    previousStatus: prevEventType,
    isActive: true,
    isReachable,
    runtimeSeconds: undefined,
    temperatureF,
    humidity,
    heatSetpoint,
    coolSetpoint,
    thermostatMode,
    observedAt: now,
    sourceEventId: sessionId,
    eventData
  });

  console.log('[runtimeTracker] Session started OK.');
}

async function endRuntimeSession({
  deviceKey,
  userId,
  deviceName,
  label,
  previousStatus,
  runtimeSeconds,
  temperatureF,
  humidity,
  heatSetpoint,
  coolSetpoint,
  thermostatMode,
  firmwareVersion,
  serialNumber,
  isReachable,
  eventData,
  now
}) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) {
    console.log('[runtimeTracker] No active session found; cannot end.');
    return;
  }

  activeDevices.delete(deviceKey);

  // Update runtime session
  await pool.query(`
    UPDATE runtime_sessions SET
      ended_at = $2,
      duration_seconds = $3,
      updated_at = $2
    WHERE session_id = $1
  `, [deviceState.sessionId, now, runtimeSeconds]);

  // Update device_status → IDLE snapshot
  await pool.query(`
    UPDATE device_status SET
      is_running = FALSE,
      session_started_at = NULL,
      last_equipment_status = current_equipment_status,
      current_equipment_status = 'IDLE',
      current_mode = 'idle',
      updated_at = $2
    WHERE device_key = $1
  `, [deviceKey, now]);

  // Post to Core with Mode_Change
  await postCoreEvent({
    deviceKey,
    userId,
    deviceName,
    firmwareVersion,
    serialNumber,
    label: { 
      eventType: 'Mode_Change',     // ✅ Event type
      equipmentStatus: 'IDLE'       // ✅ Current state
    },
    previousStatus,
    isActive: false,
    isReachable,
    runtimeSeconds,
    temperatureF: temperatureF ?? deviceState.startTemperature,
    humidity,
    heatSetpoint: heatSetpoint ?? deviceState.heatSetpoint,
    coolSetpoint: coolSetpoint ?? deviceState.coolSetpoint,
    thermostatMode,
    observedAt: now,
    sourceEventId: deviceState.sessionId,
    eventData
  });

  console.log('[runtimeTracker] Session ended OK.', { runtimeSeconds });
}

async function modeSwitchSession({
  deviceKey,
  userId,
  deviceName,
  label,
  previousStatus,
  runtimeSeconds,
  thermostatMode,
  heatSetpoint,
  coolSetpoint,
  temperatureF,
  humidity,
  firmwareVersion,
  serialNumber,
  isReachable,
  eventData,
  now,
  nowMs
}) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) return;

  const oldSessionId = deviceState.sessionId;
  const newSessionId = uuidv4();

  console.log(`[runtimeTracker] Mode switch: ${previousStatus} -> ${label.eventType}, runtime=${runtimeSeconds}s`);

  // End old session
  await pool.query(`
    UPDATE runtime_sessions SET
      ended_at = $2,
      duration_seconds = $3,
      updated_at = $2
    WHERE session_id = $1
  `, [oldSessionId, now, runtimeSeconds]);

  // Start new session
  const mode = label.eventType.toLowerCase();
  await pool.query(`
    INSERT INTO runtime_sessions (
      device_key, session_id, mode, equipment_status,
      started_at, start_temperature, heat_setpoint, cool_setpoint,
      tick_count, last_tick_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$5,NOW())
  `, [deviceKey, newSessionId, mode, label.equipmentStatus, now, temperatureF, heatSetpoint, coolSetpoint]);

  // Update device_status
  await pool.query(`
    UPDATE device_status SET
      current_mode = $2,
      current_equipment_status = $3,
      session_started_at = $4,
      updated_at = $4
    WHERE device_key = $1
  `, [deviceKey, mode, label.equipmentStatus, now]);

  // Update memory
  deviceState.sessionId = newSessionId;
  deviceState.sessionStartedAt = now;
  deviceState.currentMode = mode;
  deviceState.currentEventType = label.eventType;
  deviceState.currentEquipmentStatus = label.equipmentStatus;
  deviceState.isHeating = label.equipmentStatus === 'HEATING';
  deviceState.isCooling = label.equipmentStatus === 'COOLING';
  deviceState.isAuxHeat = label.equipmentStatus === 'AUX_HEATING';
  deviceState.isFanOnly = label.equipmentStatus === 'FAN';
  deviceState.lastEventTime = nowMs;

  // Post to Core with Mode_Change
  await postCoreEvent({
    deviceKey,
    userId,
    deviceName,
    firmwareVersion,
    serialNumber,
    label: {
      eventType: 'Mode_Change',           // ✅ Event type
      equipmentStatus: label.equipmentStatus  // ✅ New state
    },
    previousStatus,
    isActive: true,
    isReachable,
    runtimeSeconds,
    temperatureF,
    humidity,
    heatSetpoint,
    coolSetpoint,
    thermostatMode,
    observedAt: now,
    sourceEventId: newSessionId,
    eventData
  });

  console.log('[runtimeTracker] Mode switch complete.');
}

async function startRuntimeSession({
  deviceKey,
  userId,
  deviceName,
  label,
  thermostatMode,
  heatSetpoint,
  coolSetpoint,
  temperatureF,
  humidity,
  firmwareVersion,
  serialNumber,
  isReachable,
  eventData,
  now
}) {
  const pool = getPool();
  const sessionId = uuidv4();
  const mode = label.eventType.toLowerCase();

  console.log('[runtimeTracker] Starting session:', {
    sessionId, mode, equipmentStatus: label.equipmentStatus,
    startTempF: temperatureF, heatSetpoint, coolSetpoint
  });

  // Create runtime session
  await pool.query(`
    INSERT INTO runtime_sessions (
      device_key, session_id, mode, equipment_status,
      started_at, start_temperature, heat_setpoint, cool_setpoint,
      tick_count, last_tick_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$5,NOW())
  `, [deviceKey, sessionId, mode, label.equipmentStatus, now, temperatureF, heatSetpoint, coolSetpoint]);

  // Update device_status
  await pool.query(`
    UPDATE device_status SET
      is_running = TRUE,
      session_started_at = $2,
      current_mode = $3,
      current_equipment_status = $4,
      last_heat_setpoint = COALESCE($5, last_heat_setpoint),
      last_cool_setpoint = COALESCE($6, last_cool_setpoint),
      updated_at = $2
    WHERE device_key = $1
  `, [deviceKey, now, mode, label.equipmentStatus, heatSetpoint, coolSetpoint]);

  // Cache in memory
  activeDevices.set(deviceKey, {
    deviceKey,
    frontendId: userId,
    deviceName,
    sessionId,
    sessionStartedAt: now,
    currentMode: mode,
    currentEventType: label.eventType,
    currentEquipmentStatus: label.equipmentStatus,
    startTemperature: temperatureF,
    isHeating: label.equipmentStatus === 'HEATING',
    isCooling: label.equipmentStatus === 'COOLING',
    isAuxHeat: label.equipmentStatus === 'AUX_HEATING',
    isFanOnly: label.equipmentStatus === 'FAN',
    heatSetpoint,
    coolSetpoint,
    lastEventTime: now.getTime(),
    lastTelemetryPost: now.getTime(),
    isReachable
  });

  // Post to Core
  await postCoreEvent({
    deviceKey,
    userId,
    deviceName,
    firmwareVersion,
    serialNumber,
    label,
    previousStatus: 'OFF',
    isActive: true,
    isReachable,
    runtimeSeconds: undefined,
    temperatureF,
    humidity,
    heatSetpoint,
    coolSetpoint,
    thermostatMode,
    observedAt: now,
    sourceEventId: sessionId,
    eventData
  });

  console.log('[runtimeTracker] Session started OK.');
}

async function endRuntimeSession({
  deviceKey,
  userId,
  deviceName,
  label,
  previousStatus,
  runtimeSeconds,
  temperatureF,
  humidity,
  heatSetpoint,
  coolSetpoint,
  thermostatMode,
  firmwareVersion,
  serialNumber,
  isReachable,
  eventData,
  now
}) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) {
    console.log('[runtimeTracker] No active session found; cannot end.');
    return;
  }

  activeDevices.delete(deviceKey);

  // Update runtime session
  await pool.query(`
    UPDATE runtime_sessions SET
      ended_at = $2,
      duration_seconds = $3,
      updated_at = $2
    WHERE session_id = $1
  `, [deviceState.sessionId, now, runtimeSeconds]);

  // Update device_status → OFF snapshot
  await pool.query(`
    UPDATE device_status SET
      is_running = FALSE,
      session_started_at = NULL,
      last_equipment_status = current_equipment_status,
      current_equipment_status = 'OFF',
      current_mode = 'off',
      updated_at = $2
    WHERE device_key = $1
  `, [deviceKey, now]);

  // Post to Core
  await postCoreEvent({
    deviceKey,
    userId,
    deviceName,
    firmwareVersion,
    serialNumber,
    label: { eventType: 'Fan_off', equipmentStatus: 'OFF' },
    previousStatus,
    isActive: false,
    isReachable,
    runtimeSeconds,
    temperatureF: temperatureF ?? deviceState.startTemperature,
    humidity,
    heatSetpoint: heatSetpoint ?? deviceState.heatSetpoint,
    coolSetpoint: coolSetpoint ?? deviceState.coolSetpoint,
    thermostatMode,
    observedAt: now,
    sourceEventId: deviceState.sessionId,
    eventData
  });

  console.log('[runtimeTracker] Session ended OK.', { runtimeSeconds });
}

async function modeSwitchSession({
  deviceKey,
  userId,
  deviceName,
  label,
  previousStatus,
  runtimeSeconds,
  thermostatMode,
  heatSetpoint,
  coolSetpoint,
  temperatureF,
  humidity,
  firmwareVersion,
  serialNumber,
  isReachable,
  eventData,
  now,
  nowMs
}) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) return;

  const oldSessionId = deviceState.sessionId;
  const newSessionId = uuidv4();

  console.log(`[runtimeTracker] Mode switch: ${previousStatus} -> ${label.eventType}, runtime=${runtimeSeconds}s`);

  // End old session
  await pool.query(`
    UPDATE runtime_sessions SET
      ended_at = $2,
      duration_seconds = $3,
      updated_at = $2
    WHERE session_id = $1
  `, [oldSessionId, now, runtimeSeconds]);

  // Start new session
  const mode = label.eventType.toLowerCase();
  await pool.query(`
    INSERT INTO runtime_sessions (
      device_key, session_id, mode, equipment_status,
      started_at, start_temperature, heat_setpoint, cool_setpoint,
      tick_count, last_tick_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$5,NOW())
  `, [deviceKey, newSessionId, mode, label.equipmentStatus, now, temperatureF, heatSetpoint, coolSetpoint]);

  // Update device_status
  await pool.query(`
    UPDATE device_status SET
      current_mode = $2,
      current_equipment_status = $3,
      session_started_at = $4,
      updated_at = $4
    WHERE device_key = $1
  `, [deviceKey, mode, label.equipmentStatus, now]);

  // Update memory
  deviceState.sessionId = newSessionId;
  deviceState.sessionStartedAt = now;
  deviceState.currentMode = mode;
  deviceState.currentEventType = label.eventType;
  deviceState.currentEquipmentStatus = label.equipmentStatus;
  deviceState.isHeating = label.equipmentStatus === 'HEATING';
  deviceState.isCooling = label.equipmentStatus === 'COOLING';
  deviceState.isAuxHeat = label.equipmentStatus === 'AUX_HEATING';
  deviceState.isFanOnly = label.equipmentStatus === 'FAN';
  deviceState.lastEventTime = nowMs;

  // Post to Core
  await postCoreEvent({
    deviceKey,
    userId,
    deviceName,
    firmwareVersion,
    serialNumber,
    label,
    previousStatus,
    isActive: true,
    isReachable,
    runtimeSeconds,
    temperatureF,
    humidity,
    heatSetpoint,
    coolSetpoint,
    thermostatMode,
    observedAt: now,
    sourceEventId: newSessionId,
    eventData
  });

  console.log('[runtimeTracker] Mode switch complete.');
}

async function updateRuntimeSession({
  deviceKey,
  label,
  heatSetpoint,
  coolSetpoint,
  now
}) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) return;

  console.log('[runtimeTracker] Updating session tick');

  try {
    await pool.query(`
      UPDATE runtime_sessions SET
        tick_count = tick_count + 1,
        last_tick_at = $2,
        heat_setpoint = COALESCE($3, heat_setpoint),
        cool_setpoint = COALESCE($4, cool_setpoint),
        updated_at = $2
      WHERE session_id = $1
    `, [deviceState.sessionId, now, heatSetpoint, coolSetpoint]);

    await pool.query(`
      UPDATE device_status SET
        current_equipment_status = $2,
        last_heat_setpoint = COALESCE($3, last_heat_setpoint),
        last_cool_setpoint = COALESCE($4, last_cool_setpoint),
        updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, label.equipmentStatus, heatSetpoint, coolSetpoint]);

    // Update in-memory state
    deviceState.currentEquipmentStatus = label.equipmentStatus;
    deviceState.isHeating = label.equipmentStatus === 'HEATING';
    deviceState.isCooling = label.equipmentStatus === 'COOLING';
    deviceState.isAuxHeat = label.equipmentStatus === 'AUX_HEATING';
    deviceState.isFanOnly = label.equipmentStatus === 'FAN';
    if (heatSetpoint != null) deviceState.heatSetpoint = heatSetpoint;
    if (coolSetpoint != null) deviceState.coolSetpoint = coolSetpoint;

    console.log('[runtimeTracker] Session tick persisted.');
  } catch (error) {
    console.error('[runtimeTracker] Error updating runtime session:', error);
  }
}

async function handleTelemetryUpdate(deviceKey, tempF, tempC, humidity) {
  const pool = getPool();
  console.log('[runtimeTracker] handleTelemetryUpdate', { deviceKey, tempF, tempC, humidity });

  try {
    const updates = [];
    const params = [deviceKey];
    let paramIndex = 2;

    if (tempF !== null) {
      updates.push(`last_temperature = ${paramIndex++}`);
      params.push(tempF);
    }

    if (humidity !== null) {
      updates.push(`last_humidity = ${paramIndex++}`);
      params.push(humidity);
    }

    if (updates.length > 0) {
      updates.push('last_seen_at = NOW()');
      updates.push('updated_at = NOW()');

      await pool.query(`
        UPDATE device_status SET ${updates.join(', ')}
        WHERE device_key = $1
      `, params);
    }

    if (tempF !== null) {
      await pool.query(`
        INSERT INTO temp_readings (device_key, temperature, units, event_type, session_id, recorded_at, created_at)
        VALUES ($1, $2, 'F', 'temperature_update',
                (SELECT session_id FROM runtime_sessions WHERE device_key = $1 AND ended_at IS NULL LIMIT 1),
                NOW(), NOW())
      `, [deviceKey, tempF]);
    }

    console.log('[runtimeTracker] Telemetry update persisted.');
  } catch (error) {
    console.error('[runtimeTracker] Error handling telemetry update:', error);
  }
}

module.exports = {
  handleDeviceEvent,
  recoverActiveSessions,
  activeDevices
};
