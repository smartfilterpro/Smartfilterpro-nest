'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

// ------------ Config ------------
const LAST_FAN_TAIL_SECONDS = parseInt(process.env.LAST_FAN_TAIL_SECONDS || '180', 10);

// In-memory tracking of active devices
// Map<device_key, { sessionId, startedAt, lastActiveAt, mode }>
const activeDevices = new Map();

// ------------ Helper Functions ------------

function isHvacActive(hvacStatus, fanTimerMode) {
  const heatingOrCooling = hvacStatus === 'HEATING' || hvacStatus === 'COOLING';
  const fanOnly = fanTimerMode === 'ON';
  return heatingOrCooling || fanOnly;
}

function deriveMode(hvacStatus, fanTimerMode, thermostatMode) {
  if (hvacStatus === 'HEATING') return 'HEAT';
  if (hvacStatus === 'COOLING') return 'COOL';
  if (fanTimerMode === 'ON') return 'FAN_ONLY';
  if (thermostatMode && ['HEAT', 'COOL', 'AUTO', 'OFF'].includes(thermostatMode.toUpperCase())) {
    return thermostatMode.toUpperCase();
  }
  return 'OFF';
}

function deriveEquipmentStatus(hvacStatus, fanTimerMode) {
  if (hvacStatus === 'HEATING') return 'HEATING';
  if (hvacStatus === 'COOLING') return 'COOLING';
  if (fanTimerMode === 'ON') return 'FAN';
  return 'OFF';
}

function deriveEventType(hvacStatus, fanTimerMode, isStart) {
  if (hvacStatus === 'HEATING') return isStart ? 'HEAT_ON' : 'HEAT_OFF';
  if (hvacStatus === 'COOLING') return isStart ? 'COOL_ON' : 'COOL_OFF';
  if (fanTimerMode === 'ON') return isStart ? 'FAN_ON' : 'FAN_OFF';
  return 'STATUS_CHANGE';
}

function celsiusToFahrenheit(celsius) {
  if (celsius == null) return null;
  return Math.round((celsius * 9 / 5 + 32) * 100) / 100;
}

// ------------ Core Payload Builder ------------

/**
 * Builds payload for Core Ingest matching the fixed schema
 * @param {Object} evt - Normalized event from Nest
 * @param {Object} sessionInfo - Session tracking info
 * @returns {Object} Core Ingest compatible payload
 */
function buildCoreIngestPayload(evt, sessionInfo) {
  const mode = deriveMode(evt.hvacStatus, evt.fanTimerMode, evt.thermostatMode);
  const equipmentStatus = deriveEquipmentStatus(evt.hvacStatus, evt.fanTimerMode);
  const eventType = deriveEventType(evt.hvacStatus, evt.fanTimerMode, sessionInfo.isStart);

  return {
    // Required Core Ingest fields
    device_key: evt.deviceKey,                          // UUID
    device_id: `nest:${evt.deviceKey}`,                 // Vendor-specific ID
    workspace_id: evt.userId || 'default',              // User workspace
    device_name: evt.deviceName,
    manufacturer: 'Google Nest',
    model: evt.modelName || 'Nest Thermostat',
    source: 'nest',
    connection_source: 'nest',
    
    // Event data
    event_type: eventType,
    is_active: sessionInfo.isActive,
    equipment_status: equipmentStatus,
    previous_status: sessionInfo.previousStatus || 'UNKNOWN',
    
    // Temperature data
    temperature_f: evt.currentTemperatureF,
    temperature_c: evt.currentTemperatureC,
    humidity: evt.humidity || null,
    heat_setpoint_f: evt.heatSetpointF || null,
    cool_setpoint_f: evt.coolSetpointF || null,
    outdoor_temp_f: evt.outdoorTempF || null,
    
    // Session tracking
    session_id: sessionInfo.sessionId || null,
    runtime_seconds: sessionInfo.runtimeSeconds || null,
    
    // Metadata
    timestamp: evt.observedAt || new Date().toISOString(),
    source_event_id: evt.eventId || uuidv4(),
    
    // Additional context
    payload_raw: {
      hvacStatus: evt.hvacStatus,
      fanTimerMode: evt.fanTimerMode,
      thermostatMode: evt.thermostatMode,
      lastFanTailSeconds: LAST_FAN_TAIL_SECONDS
    }
  };
}

// ------------ Bubble Payload Builder ------------

function buildBubblePayload(evt, sessionInfo) {
  return {
    userId: evt.userId,
    thermostatId: evt.frontendId || evt.deviceKey,
    deviceName: evt.deviceName,
    runtimeSeconds: sessionInfo.runtimeSeconds || 0,
    isRuntimeEvent: !sessionInfo.isActive && sessionInfo.runtimeSeconds > 0,
    hvacMode: deriveMode(evt.hvacStatus, evt.fanTimerMode, evt.thermostatMode),
    isHvacActive: sessionInfo.isActive,
    currentTemperature: evt.currentTemperatureF,
    timestamp: evt.observedAt || new Date().toISOString(),
    eventId: evt.eventId || uuidv4()
  };
}

// ------------ Database Operations ------------

async function upsertDeviceStatus(pool, evt, sessionInfo) {
  const mode = deriveMode(evt.hvacStatus, evt.fanTimerMode, evt.thermostatMode);
  const equipmentStatus = deriveEquipmentStatus(evt.hvacStatus, evt.fanTimerMode);

  await pool.query(
    `
    INSERT INTO device_status (
      device_key,
      frontend_id,
      device_name,
      is_running,
      current_equipment_status,
      last_mode,
      last_is_cooling,
      last_is_heating,
      last_is_fan_only,
      last_equipment_status,
      session_started_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    ON CONFLICT (device_key) DO UPDATE SET
      frontend_id = EXCLUDED.frontend_id,
      device_name = EXCLUDED.device_name,
      is_running = EXCLUDED.is_running,
      current_equipment_status = EXCLUDED.current_equipment_status,
      last_mode = EXCLUDED.last_mode,
      last_is_cooling = EXCLUDED.last_is_cooling,
      last_is_heating = EXCLUDED.last_is_heating,
      last_is_fan_only = EXCLUDED.last_is_fan_only,
      last_equipment_status = EXCLUDED.last_equipment_status,
      session_started_at = EXCLUDED.session_started_at,
      updated_at = NOW()
    `,
    [
      evt.deviceKey,
      evt.frontendId || evt.userId,
      evt.deviceName,
      sessionInfo.isActive,
      equipmentStatus,
      mode,
      evt.hvacStatus === 'COOLING',
      evt.hvacStatus === 'HEATING',
      evt.fanTimerMode === 'ON' && evt.hvacStatus !== 'HEATING' && evt.hvacStatus !== 'COOLING',
      equipmentStatus,
      sessionInfo.isActive ? (sessionInfo.startedAt || new Date()) : null
    ]
  );
}

// ------------ Main Event Handler ------------

/**
 * Handle a normalized Nest device update
 * Expected format:
 * {
 *   userId: string,
 *   frontendId: string,
 *   deviceKey: string (UUID),
 *   deviceName: string,
 *   thermostatId: string,
 *   hvacStatus: 'HEATING'|'COOLING'|'OFF'|'UNKNOWN',
 *   fanTimerMode: 'ON'|'OFF'|'UNKNOWN',
 *   thermostatMode: 'HEAT'|'COOL'|'AUTO'|'OFF'|'ECO',
 *   currentTemperatureF: number,
 *   currentTemperatureC: number,
 *   humidity: number (optional),
 *   heatSetpointF: number (optional),
 *   coolSetpointF: number (optional),
 *   outdoorTempF: number (optional),
 *   observedAt: ISO timestamp,
 *   eventId: string (optional)
 * }
 */
async function handleNormalizedUpdate(evt) {
  const pool = getPool();
  const now = evt.observedAt ? new Date(evt.observedAt) : new Date();
  
  const isActive = isHvacActive(evt.hvacStatus, evt.fanTimerMode);
  const currentSession = activeDevices.get(evt.deviceKey);
  const wasActive = !!currentSession;
  
  let sessionInfo = {
    isActive,
    isStart: false,
    sessionId: null,
    startedAt: null,
    runtimeSeconds: null,
    previousStatus: currentSession?.equipmentStatus || 'UNKNOWN'
  };

  // State machine: OFF -> ON (start session)
  if (isActive && !wasActive) {
    const newSessionId = uuidv4();
    activeDevices.set(evt.deviceKey, {
      sessionId: newSessionId,
      startedAt: now,
      lastActiveAt: now,
      equipmentStatus: deriveEquipmentStatus(evt.hvacStatus, evt.fanTimerMode),
      mode: deriveMode(evt.hvacStatus, evt.fanTimerMode, evt.thermostatMode)
    });
    
    sessionInfo.isStart = true;
    sessionInfo.sessionId = newSessionId;
    sessionInfo.startedAt = now;
    
    console.log(`[Session Start] ${evt.deviceKey} - ${evt.hvacStatus} - Session ${newSessionId}`);
  }
  
  // State machine: ON -> OFF (end session with tail)
  else if (!isActive && wasActive) {
    const tailMs = LAST_FAN_TAIL_SECONDS * 1000;
    const endTime = new Date(Math.max(now.getTime(), currentSession.lastActiveAt.getTime() + tailMs));
    const runtimeMs = Math.max(0, endTime.getTime() - currentSession.startedAt.getTime());
    const runtimeSeconds = Math.round(runtimeMs / 1000);
    
    sessionInfo.sessionId = currentSession.sessionId;
    sessionInfo.runtimeSeconds = runtimeSeconds;
    sessionInfo.isStart = false;
    
    activeDevices.delete(evt.deviceKey);
    
    console.log(`[Session End] ${evt.deviceKey} - Runtime: ${runtimeSeconds}s`);
  }
  
  // State machine: ON -> ON (update session)
  else if (isActive && wasActive) {
    currentSession.lastActiveAt = now;
    currentSession.equipmentStatus = deriveEquipmentStatus(evt.hvacStatus, evt.fanTimerMode);
    sessionInfo.sessionId = currentSession.sessionId;
  }

  // Update database
  try {
    await upsertDeviceStatus(pool, evt, sessionInfo);
  } catch (err) {
    console.error('[DB Error] Failed to update device_status:', err.message);
  }

  // Build payloads
  const bubblePayload = buildBubblePayload(evt, sessionInfo);
  const corePayload = buildCoreIngestPayload(evt, sessionInfo);

  // Dual post (fire-and-forget with error logging)
  const [bubbleResult, coreResult] = await Promise.allSettled([
    postToBubbleAsync(bubblePayload),
    postToCoreIngestAsync(corePayload)
  ]);

  if (bubbleResult.status === 'rejected') {
    console.warn('[Bubble Post Failed]', bubbleResult.reason?.message || bubbleResult.reason);
  } else {
    console.log('[Bubble Post Success]', evt.deviceKey);
  }

  if (coreResult.status === 'rejected') {
    console.warn('[Core Post Failed]', coreResult.reason?.message || coreResult.reason);
  } else {
    console.log('[Core Post Success]', evt.deviceKey);
  }

  return {
    ok: true,
    isActive,
    wasActive,
    runtimeSeconds: sessionInfo.runtimeSeconds,
    sessionId: sessionInfo.sessionId
  };
}

// ------------ Recovery Logic ------------

/**
 * Recover active sessions after process restart
 * Seeds in-memory state from database
 */
async function recoverActiveSessions() {
  const pool = getPool();
  const now = new Date();
  
  try {
    const { rows } = await pool.query(
      `
      SELECT 
        device_key,
        device_name,
        last_equipment_status,
        last_mode,
        session_started_at
      FROM device_status
      WHERE is_running = true
      `
    );

    for (const row of rows) {
      const startedAt = row.session_started_at ? new Date(row.session_started_at) : now;
      activeDevices.set(row.device_key, {
        sessionId: uuidv4(), // Generate new session ID for recovery
        startedAt: startedAt,
        lastActiveAt: now,
        equipmentStatus: row.last_equipment_status || 'UNKNOWN',
        mode: row.last_mode || 'UNKNOWN'
      });
    }

    console.log(`[Recovery] Recovered ${rows.length} active session(s) at ${now.toISOString()}`);
  } catch (err) {
    console.error('[Recovery Error]', err.message);
  }
}

// ------------ Exports ------------

module.exports = {
  handleNormalizedUpdate,
  recoverActiveSessions,
  
  // Exported for testing/diagnostics
  _activeDevices: activeDevices,
  _helpers: {
    isHvacActive,
    deriveMode,
    deriveEquipmentStatus,
    deriveEventType,
    celsiusToFahrenheit,
    buildCoreIngestPayload,
    buildBubblePayload
  }
};
