'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

// ===========================
// In-memory active sessions
// ===========================
const activeDevices = new Map();
// deviceKey -> {
//   deviceKey, frontendId, deviceName,
//   sessionId, sessionStartedAt, currentMode,
//   currentEquipmentStatus, startTemperature,
//   isHeating, isCooling, isFanOnly,
//   heatSetpoint, coolSetpoint
// }

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

function hvacIsActive(status) {
  return status === 'HEATING' || status === 'COOLING';
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

/**
 * Backfill from device_status when event lacks telemetry.
 */
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

/**
 * Core payload builder — matches devices / device_status / equipment_events fields (where applicable).
 * Sends a rich, consistent shape; nulls when unknown.
 */
function buildCorePayload({
  deviceKey,
  userId,
  deviceName,
  // traits & vendor info
  manufacturer = 'Google Nest',
  model = 'Nest Thermostat',
  connectionSource = 'nest',
  source = 'nest',
  sourceVendor = 'nest',
  workspaceId = userId,
  deviceType = 'thermostat',
  firmwareVersion = null,
  serialNumber = null,
  ipAddress = null,
  timezone = null,
  zipPrefix = null,

  // runtime
  eventType,                 // e.g., COOLING_ON, STATUS_CHANGE, FAN_ON
  equipmentStatus,           // HEATING/COOLING/OFF/FAN
  previousStatus,            // previous hvac status or 'unknown'
  isActive,                  // boolean
  mode,                      // 'heating' | 'cooling' | 'fan_only' | 'off'
  runtimeSeconds,            // integer or null

  // telemetry
  temperatureF,              // number or null
  humidity,                  // number or null
  heatSetpoint,              // number or null
  coolSetpoint,              // number or null

  // linking
  observedAt,                // JS Date
  sourceEventId,             // stable per logical event / session
  payloadRaw                 // raw event for traceability
}) {
  const temperatureC = typeof temperatureF === 'number'
    ? Math.round(((temperatureF - 32) * 5 / 9) * 100) / 100
    : null;

  const isoNow = (observedAt || new Date()).toISOString();

  return {
    // identity
    device_key: deviceKey,
    device_id: `nest:${deviceKey}`,
    user_id: userId || null,
    workspace_id: workspaceId || userId || null,
    device_name: deviceName || 'Nest Thermostat',
    manufacturer,
    model,
    device_type: deviceType,
    source,
    source_vendor: sourceVendor,
    connection_source: connectionSource,
    firmware_version: firmwareVersion,
    serial_number: serialNumber,
    ip_address: ipAddress,
    timezone,
    zip_prefix: zipPrefix,
    zip_code_prefix: zipPrefix,

    // state snapshot
    last_mode: mode || null,
    last_is_cooling: equipmentStatus === 'COOLING',
    last_is_heating: equipmentStatus === 'HEATING',
    last_is_fan_only: equipmentStatus === 'FAN',
    last_equipment_status: equipmentStatus || null,
    is_reachable: true, // best-effort; device_status table will be authoritative

    // telemetry snapshot (duplicated to ease UPSERTs on devices/device_status)
    last_temperature: temperatureF ?? null,
    last_humidity: humidity ?? null,
    last_heat_setpoint: heatSetpoint ?? null,
    last_cool_setpoint: coolSetpoint ?? null,

    // event-specific fields
    event_type: eventType,
    is_active: !!isActive,
    equipment_status: equipmentStatus || 'OFF',
    previous_status: previousStatus || 'UNKNOWN',
    runtime_seconds: typeof runtimeSeconds === 'number' ? runtimeSeconds : null,
    timestamp: isoNow,
    recorded_at: isoNow,

    // dedupe + trace
    source_event_id: sourceEventId || uuidv4(),
    payload_raw: payloadRaw || null
  };
}

// ===========================
// Public entrypoint
// ===========================
async function handleDeviceEvent(eventData) {
  const pool = getPool();

  try {
    // --------- Basic extraction ---------
    const deviceName = eventData.resourceUpdate?.name || eventData.eventId;
    const deviceKey = extractDeviceKey(deviceName);
    const userId = eventData.userId;

    if (!deviceKey) {
      console.error('[runtimeTracker] Could not extract device key from event');
      return;
    }

    await ensureDeviceExists(deviceKey, userId, deviceName);

    // Traits (only present for some events)
    const traits = eventData.resourceUpdate?.traits || {};
    const tConnectivity = traits['sdm.devices.traits.Connectivity'];
    const tTemp        = traits['sdm.devices.traits.Temperature'];
    const tHvac        = traits['sdm.devices.traits.ThermostatHvac'];
    const tFan         = traits['sdm.devices.traits.Fan'];
    const tSetpoint    = traits['sdm.devices.traits.ThermostatTemperatureSetpoint'];

    // Optional firmware/serial best-effort (trait names vary across docs/firmware)
    const tInfo        = traits['sdm.devices.traits.Info'] || traits['sdm.devices.traits.DeviceInfo'] || {};
    const tSwUpdate    = traits['sdm.devices.traits.SoftwareUpdate'] || {};

    const firmwareVersion = tSwUpdate.currentVersion || tInfo.currentVersion || null;
    const serialNumber    = tInfo.serialNumber || tInfo.serial || null;

    if (tConnectivity) {
      const isReachable = tConnectivity.status === 'ONLINE';
      await updateDeviceReachability(deviceKey, isReachable);
      console.log('[runtimeTracker] Connectivity:', isReachable ? 'ONLINE' : 'OFFLINE');
    }

    // Temperature (telemetry)
    if (tTemp && typeof tTemp.ambientTemperatureCelsius === 'number') {
      const tempC = tTemp.ambientTemperatureCelsius;
      const tempF = celsiusToFahrenheit(tempC);
      console.log('[runtimeTracker] Temperature event:', { tempC, tempF });

      // non-blocking update, but we log failures
      handleTemperatureChange(deviceKey, tempF, tempC, userId)
        .then(() => console.log('[runtimeTracker] Temperature persisted + bubble post queued'))
        .catch(err => console.error('[runtimeTracker] Error in handleTemperatureChange:', err));
    }

    // HVAC + Fan + Setpoints
    const equipmentStatus = tHvac?.status || null;                // HEATING/COOLING/OFF
    const isFanTimerOn    = tFan?.timerMode === 'ON' || false;    // boolean

    let heatSetpoint = null, coolSetpoint = null;
    if (tSetpoint) {
      if (typeof tSetpoint.heatCelsius === 'number') heatSetpoint = celsiusToFahrenheit(tSetpoint.heatCelsius);
      if (typeof tSetpoint.coolCelsius === 'number') coolSetpoint = celsiusToFahrenheit(tSetpoint.coolCelsius);
    }

    console.log('DEBUG - Extracted from webhook:', {
      equipmentStatus,
      isFanTimerOn,
      hasActiveSession: activeDevices.has(deviceKey),
      firmwareVersion,
      serialNumber
    });

    // If this event lacks HVAC or fan info, backfill from DB for correctness
    let effectiveEquip = equipmentStatus;
    let effectiveFan   = isFanTimerOn;

    if (effectiveEquip === null) {
      console.log('DEBUG - Backfilling equipment status from DB...');
      const s = await getBackfillState(deviceKey);
      effectiveEquip = s?.current_equipment_status || 'OFF';
      console.log(`DEBUG - DB equipment_status: ${effectiveEquip}`);
      // also backfill telemetry if missing
      if (heatSetpoint == null) heatSetpoint = s?.last_heat_setpoint ?? null;
      if (coolSetpoint == null) coolSetpoint = s?.last_cool_setpoint ?? null;
    }

    // Process runtime/session logic
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
// Runtime / Session Logic
// ===========================
async function processRuntimeLogic({
  eventData,
  deviceKey,
  userId,
  deviceName,
  equipmentStatus, // HEATING/COOLING/OFF (after backfill)
  isFanTimerOn,
  heatSetpoint,
  coolSetpoint,
  firmwareVersion,
  serialNumber
}) {
  console.log('\n=== RUNTIME LOGIC EVALUATION ===');
  const pool = getPool();

  const isHeating = equipmentStatus === 'HEATING';
  const isCooling = equipmentStatus === 'COOLING';
  const isFanOnly = !isHeating && !isCooling && isFanTimerOn;
  const isOff     = equipmentStatus === 'OFF' && !isFanTimerOn;

  console.log('Equipment Status:', equipmentStatus);
  console.log('  - Heating:', isHeating);
  console.log('  - Cooling:', isCooling);
  console.log('  - FanOnly:', isFanOnly);
  console.log('  - Off:', isOff);
  console.log('Fan Timer:', isFanTimerOn ? 'ON' : 'OFF');

  const shouldBeActive = isHeating || isCooling || isFanTimerOn;
  const currentState = activeDevices.get(deviceKey);
  const wasActive = !!currentState;

  console.log('\nACTIVITY DETERMINATION:');
  console.log('Should be active:', shouldBeActive);
  console.log('  Reason:', isHeating ? 'Heating' : isCooling ? 'Cooling' : isFanTimerOn ? 'Fan Timer ON' : 'NONE');
  console.log('Was active:', wasActive);
  console.log('In-memory session exists:', wasActive ? 'YES' : 'NO');

  if (shouldBeActive && !wasActive) {
    console.log('\nACTION: START NEW RUNTIME SESSION');
    await startRuntimeSession({
      deviceKey, userId, deviceName,
      equipmentStatus,
      isFanTimerOn,
      heatSetpoint,
      coolSetpoint,
      firmwareVersion,
      serialNumber,
      eventData
    });
  } else if (!shouldBeActive && wasActive) {
    console.log('\nACTION: END RUNTIME SESSION');
    await endRuntimeSession({
      deviceKey, userId, deviceName,
      finalEquipmentStatus: equipmentStatus,
      firmwareVersion,
      serialNumber,
      eventData
    });
  } else if (shouldBeActive && wasActive) {
    console.log('\nACTION: UPDATE EXISTING SESSION (still active)');
    const elapsed = Math.floor((new Date() - currentState.sessionStartedAt) / 1000);
    console.log(`  Session has been running for ${elapsed} seconds`);
    await updateRuntimeSession({
      deviceKey,
      equipmentStatus,
      isFanTimerOn,
      heatSetpoint,
      coolSetpoint
    });
  } else {
    console.log('\nACTION: NO CHANGE (system idle)');
  }

  console.log('=== RUNTIME LOGIC COMPLETE ===\n');

  // optional: lightweight audit row if you still want it; otherwise skip to reduce noise.
  // await logEquipmentEvent(deviceKey, equipmentStatus, isFanTimerOn, currentState);
}

async function startRuntimeSession({
  deviceKey,
  userId,
  deviceName,
  equipmentStatus,
  isFanTimerOn,
  heatSetpoint,
  coolSetpoint,
  firmwareVersion,
  serialNumber,
  eventData
}) {
  const pool = getPool();
  const sessionId = uuidv4();
  const now = new Date();
  const mode = isFanTimerOn ? 'fan_only' : equipmentStatus.toLowerCase();

  // Backfill current temp/humidity if needed
  const backfill = await getBackfillState(deviceKey);
  const startTempF = backfill?.last_temperature ?? null;
  const lastHumidity = backfill?.last_humidity ?? null;

  console.log('[runtimeTracker] Starting session:', {
    sessionId, mode, equipmentStatus, isFanTimerOn,
    startTempF, heatSetpoint, coolSetpoint
  });

  // Create runtime session
  await pool.query(`
    INSERT INTO runtime_sessions (
      device_key, session_id, mode, equipment_status,
      started_at, start_temperature, heat_setpoint, cool_setpoint,
      tick_count, last_tick_at, created_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$5,NOW())
  `, [deviceKey, sessionId, mode, equipmentStatus, now, startTempF, heatSetpoint, coolSetpoint]);

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
  `, [deviceKey, now, mode, equipmentStatus, heatSetpoint, coolSetpoint]);

  // Cache in memory
  activeDevices.set(deviceKey, {
    deviceKey,
    frontendId: userId,
    deviceName,
    sessionId,
    sessionStartedAt: now,
    currentMode: mode,
    currentEquipmentStatus: equipmentStatus,
    startTemperature: startTempF,
    isHeating: equipmentStatus === 'HEATING',
    isCooling: equipmentStatus === 'COOLING',
    isFanOnly: isFanTimerOn,
    heatSetpoint,
    coolSetpoint
  });

  // -------- Dual post (Bubble + Core) --------
  const corePayload = buildCorePayload({
    deviceKey,
    userId,
    deviceName,
    firmwareVersion,
    serialNumber,
    eventType: `${equipmentStatus}_ON`,
    equipmentStatus,
    previousStatus: 'OFF',         // best-effort on start
    isActive: true,
    mode,
    runtimeSeconds: null,
    temperatureF: startTempF,
    humidity: lastHumidity,
    heatSetpoint,
    coolSetpoint,
    observedAt: now,
    sourceEventId: sessionId,
    payloadRaw: eventData
  });

  const bubblePayload = {
    userId,
    thermostatId: deviceKey,
    deviceName,
    runtimeSeconds: 0,
    runtimeMinutes: 0,
    isRuntimeEvent: false,
    hvacMode: mode,
    isHvacActive: true,
    timestamp: now.toISOString()
  };

  console.log('[runtimeTracker] → Posting START to Core & Bubble');
  await Promise.allSettled([
    postToCoreIngestAsync(corePayload),
    postToBubbleAsync(bubblePayload)
  ]);

  console.log('[runtimeTracker] Session started OK.');
}

async function endRuntimeSession({
  deviceKey,
  userId,
  deviceName,
  finalEquipmentStatus,
  firmwareVersion,
  serialNumber,
  eventData
}) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) {
    console.log('[runtimeTracker] No active session found; cannot end.');
    return;
  }

  const now = new Date();
  const rawSeconds = Math.floor((now - deviceState.sessionStartedAt) / 1000);
  const runtimeSeconds = Math.max(0, rawSeconds); // clamp ≥ 0
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

  // Backfill the last known telemetry to include in the event
  const backfill = await getBackfillState(deviceKey);
  const lastTempF   = backfill?.last_temperature ?? deviceState.startTemperature ?? null;
  const lastHumidity= backfill?.last_humidity ?? null;

  // -------- Dual post (Bubble + Core) --------
  const corePayload = buildCorePayload({
    deviceKey,
    userId,
    deviceName,
    firmwareVersion,
    serialNumber,
    eventType: 'STATUS_CHANGE',
    equipmentStatus: 'OFF',
    previousStatus: deviceState.currentEquipmentStatus || 'UNKNOWN',
    isActive: false,
    mode: 'off',
    runtimeSeconds,
    temperatureF: lastTempF,
    humidity: lastHumidity,
    heatSetpoint: deviceState.heatSetpoint ?? backfill?.last_heat_setpoint ?? null,
    coolSetpoint: deviceState.coolSetpoint ?? backfill?.last_cool_setpoint ?? null,
    observedAt: now,
    sourceEventId: deviceState.sessionId,
    payloadRaw: eventData
  });

  const bubblePayload = {
    userId,
    thermostatId: deviceKey,
    deviceName,
    runtimeSeconds,
    runtimeMinutes: Math.round(runtimeSeconds / 60),
    isRuntimeEvent: true,
    hvacMode: deviceState.currentMode,
    isHvacActive: false,
    timestamp: now.toISOString()
  };

  console.log('[runtimeTracker] → Posting END to Core & Bubble', { runtimeSeconds });
  await Promise.allSettled([
    postToCoreIngestAsync(corePayload),
    postToBubbleAsync(bubblePayload)
  ]);

  console.log('[runtimeTracker] Session ended OK.');
}

async function updateRuntimeSession({
  deviceKey,
  equipmentStatus,
  isFanTimerOn,
  heatSetpoint,
  coolSetpoint
}) {
  const pool = getPool();
  const deviceState = activeDevices.get(deviceKey);
  if (!deviceState) return;

  const now = new Date();
  const elapsed = Math.floor((now - deviceState.sessionStartedAt) / 1000);
  console.log('[runtimeTracker] Updating session tick', { elapsed, equipmentStatus, isFanTimerOn });

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
    `, [deviceKey, equipmentStatus, heatSetpoint, coolSetpoint]);

    // Update in-memory state
    deviceState.currentEquipmentStatus = equipmentStatus;
    deviceState.isHeating = equipmentStatus === 'HEATING';
    deviceState.isCooling = equipmentStatus === 'COOLING';
    deviceState.isFanOnly = isFanTimerOn;
    if (heatSetpoint != null) deviceState.heatSetpoint = heatSetpoint;
    if (coolSetpoint != null) deviceState.coolSetpoint = coolSetpoint;

    console.log('[runtimeTracker] Session tick persisted.');
  } catch (error) {
    console.error('[runtimeTracker] Error updating runtime session:', error);
  }
}

// Lightweight optional audit. Keep disabled if you want to reduce duplicate rows.
// Keeping here for parity with your previous version.
async function logEquipmentEvent(deviceKey, equipmentStatus, isFanTimerOn, previousState) {
  const pool = getPool();
  try {
    await pool.query(`
      INSERT INTO equipment_events (
        device_key, event_type, equipment_status, previous_status,
        is_active, session_id, event_data, recorded_at, created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
    `, [
      deviceKey,
      'status_change',
      equipmentStatus,
      previousState?.currentEquipmentStatus || 'unknown',
      !!previousState,
      previousState?.sessionId || null,
      JSON.stringify({ isFanTimerOn })
    ]);
  } catch (error) {
    console.error('[runtimeTracker] Error logging equipment event:', error);
  }
}

async function handleTemperatureChange(deviceKey, tempF, tempC, userId) {
  const pool = getPool();
  console.log('[runtimeTracker] handleTemperatureChange', { deviceKey, tempF, tempC });

  try {
    await pool.query(`
      UPDATE device_status SET
        last_temperature = $2,
        last_seen_at = NOW(),
        updated_at = NOW()
      WHERE device_key = $1
    `, [deviceKey, tempF]);

    await pool.query(`
      INSERT INTO temp_readings (device_key, temperature, units, event_type, session_id, recorded_at, created_at)
      VALUES ($1, $2, 'F', 'temperature_update',
              (SELECT session_id FROM runtime_sessions WHERE device_key = $1 AND ended_at IS NULL LIMIT 1),
              NOW(), NOW())
    `, [deviceKey, tempF]);

    // Bubble temp telemetry — verbose but same shape you had
    const dev = await getBackfillState(deviceKey);
    const currentMode = dev?.current_mode || 'off';
    const isHvacActive = !!activeDevices.get(deviceKey);

    await postToBubbleAsync({
      userId,
      thermostatId: deviceKey,
      deviceName: null, // optional — Bubble side can look up if needed
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: currentMode,
      isHvacActive,
      thermostatMode: currentMode.toUpperCase(),
      isReachable: dev?.is_reachable ?? true,
      currentTempF: tempF,
      currentTempC: tempC,
      lastIsCooling: dev?.last_is_cooling || false,
      lastIsHeating: dev?.last_is_heating || false,
      lastIsFanOnly: dev?.last_is_fan_only || false,
      lastEquipmentStatus: (dev?.current_equipment_status || 'off').toLowerCase(),
      equipmentStatus: (dev?.current_equipment_status || 'off').toLowerCase(),
      isFanOnly: isHvacActive && !activeDevices.get(deviceKey)?.isHeating && !activeDevices.get(deviceKey)?.isCooling,
      timestamp: new Date().toISOString(),
      eventId: uuidv4(),
      eventTimestamp: Date.now()
    });

  } catch (error) {
    console.error('[runtimeTracker] Error handling temperature change:', error);
  }
}

module.exports = {
  handleDeviceEvent,
  recoverActiveSessions,
  activeDevices
};
