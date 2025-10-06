'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

// ------------ Config ------------
const LAST_FAN_TAIL_SECONDS = parseInt(process.env.LAST_FAN_TAIL_SECONDS || '120', 10);

// In-memory tracking of active devices
// Map<device_key, { sessionId, startedAt: Date, lastActiveAt: Date }>
const activeDevices = new Map();

// ------------ Helpers ------------
function isHvacActive(hvacStatus, fanTimerMode) {
  // Nest-normalized states:
  // hvacStatus: 'HEATING' | 'COOLING' | 'OFF' | 'UNKNOWN'
  // fanTimerMode: 'ON' | 'OFF' | 'UNKNOWN'
  const heatingOrCooling = hvacStatus === 'HEATING' || hvacStatus === 'COOLING';
  const fanOnly = fanTimerMode === 'ON';
  return heatingOrCooling || fanOnly;
}

function deriveLastFields({ hvacStatus, fanTimerMode, thermostatMode }) {
  // last_mode is UI-ish: 'HEAT'|'COOL'|'AUTO'|'OFF'|'FAN_ONLY'|'UNKNOWN'
  let last_mode = 'UNKNOWN';
  if (hvacStatus === 'HEATING') last_mode = 'HEAT';
  else if (hvacStatus === 'COOLING') last_mode = 'COOL';
  else if (fanTimerMode === 'ON') last_mode = 'FAN_ONLY';
  else if (hvacStatus === 'OFF') last_mode = 'OFF';

  // If thermostatMode exists (e.g., 'HEAT','COOL','AUTO','OFF'), prefer it when hvacStatus=OFF
  if (hvacStatus === 'OFF' && typeof thermostatMode === 'string' && thermostatMode.length) {
    // Normalize to the same case set
    const upper = thermostatMode.toUpperCase();
    if (['HEAT','COOL','AUTO','OFF','ECO'].includes(upper)) {
      last_mode = upper === 'ECO' ? 'AUTO' : upper; // ECO behaves like program; treat as AUTO
    }
  }

  const last_is_cooling = hvacStatus === 'COOLING';
  const last_is_heating = hvacStatus === 'HEATING';
  const last_is_fan_only = fanTimerMode === 'ON' && !last_is_heating && !last_is_cooling;

  let last_equipment_status = 'OFF';
  if (last_is_heating) last_equipment_status = 'HEATING';
  else if (last_is_cooling) last_equipment_status = 'COOLING';
  else if (last_is_fan_only) last_equipment_status = 'FAN_ONLY';

  return { last_mode, last_is_cooling, last_is_heating, last_is_fan_only, last_equipment_status };
}

function buildBubblePayload({ userId, thermostatId, currentTemperatureF, isActive, runtimeSeconds }) {
  // Bubble MUST always receive these 5 fields (per spec)
  return {
    userId,
    thermostatId,
    runtimeSeconds: isActive ? null : (runtimeSeconds ?? null),
    currentTemperature: currentTemperatureF,
    isActive
  };
}

function buildCorePayload(base, lastFields) {
  // Send normalized event + last_* to Core
  return {
    ...base, // userId, deviceKey, frontendId, deviceName, thermostatId, temperatures, timestamps...
    ...lastFields
  };
}

async function upsertDeviceStatus(pool, {
  device_key,
  frontend_id,
  device_name,
  is_running,
  current_temp_f,
  last_mode,
  last_is_cooling,
  last_is_heating,
  last_is_fan_only,
  last_equipment_status
}) {
  await pool.query(
    `
    INSERT INTO device_status (
      device_key, frontend_id, device_name, is_running, current_temp_f,
      last_mode, last_is_cooling, last_is_heating, last_is_fan_only, last_equipment_status, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
    ON CONFLICT (device_key) DO UPDATE SET
      frontend_id = EXCLUDED.frontend_id,
      device_name = EXCLUDED.device_name,
      is_running = EXCLUDED.is_running,
      current_temp_f = EXCLUDED.current_temp_f,
      last_mode = EXCLUDED.last_mode,
      last_is_cooling = EXCLUDED.last_is_cooling,
      last_is_heating = EXCLUDED.last_is_heating,
      last_is_fan_only = EXCLUDED.last_is_fan_only,
      last_equipment_status = EXCLUDED.last_equipment_status,
      updated_at = now();
    `,
    [
      device_key,
      frontend_id,
      device_name,
      !!is_running,
      current_temp_f,
      last_mode,
      last_is_cooling,
      last_is_heating,
      last_is_fan_only,
      last_equipment_status
    ]
  );
}

// ------------ Core flow ------------
/**
 * Handle a normalized Nest update.
 * expected shape (already parsed from Pub/Sub):
 * {
 *   userId, frontendId, deviceKey, deviceName, thermostatId,
 *   hvacStatus: 'HEATING'|'COOLING'|'OFF'|'UNKNOWN',
 *   fanTimerMode: 'ON'|'OFF'|'UNKNOWN',
 *   thermostatMode: 'HEAT'|'COOL'|'AUTO'|'OFF'|'ECO' (optional),
 *   currentTemperatureF: number,
 *   observedAt: ISO string
 * }
 */
async function handleNormalizedUpdate(evt) {
  const pool = getPool();
  const now = evt.observedAt ? new Date(evt.observedAt) : new Date();

  const active = isHvacActive(evt.hvacStatus, evt.fanTimerMode);
  const last = deriveLastFields({
    hvacStatus: evt.hvacStatus,
    fanTimerMode: evt.fanTimerMode,
    thermostatMode: evt.thermostatMode
  });

  // session handling
  const entry = activeDevices.get(evt.deviceKey);
  let endedRuntimeSeconds = null;

  if (active) {
    if (!entry) {
      activeDevices.set(evt.deviceKey, {
        sessionId: uuidv4(),
        startedAt: now,
        lastActiveAt: now
      });
    } else {
      entry.lastActiveAt = now;
    }
  } else {
    if (entry) {
      const tailMs = LAST_FAN_TAIL_SECONDS * 1000;
      const endTs = new Date(Math.max(now.getTime(), entry.lastActiveAt.getTime() + tailMs));
      const runtimeMs = Math.max(0, endTs.getTime() - entry.startedAt.getTime());
      endedRuntimeSeconds = Math.round(runtimeMs / 1000);
      activeDevices.delete(evt.deviceKey);
    }
  }

  // UPSERT device_status with last_* and is_running
  await upsertDeviceStatus(pool, {
    device_key: evt.deviceKey,
    frontend_id: evt.frontendId,
    device_name: evt.deviceName,
    is_running: active,
    current_temp_f: evt.currentTemperatureF,
    ...last
  });

  // Dual post
  const bubblePayload = buildBubblePayload({
    userId: evt.userId,
    thermostatId: evt.thermostatId,
    currentTemperatureF: evt.currentTemperatureF,
    isActive: active,
    runtimeSeconds: endedRuntimeSeconds
  });

  const corePayloadBase = {
    userId: evt.userId,
    frontendId: evt.frontendId,
    deviceKey: evt.deviceKey,
    deviceName: evt.deviceName,
    thermostatId: evt.thermostatId,
    currentTemperatureF: evt.currentTemperatureF,
    hvacStatus: evt.hvacStatus,
    fanTimerMode: evt.fanTimerMode,
    thermostatMode: evt.thermostatMode || null,
    isActive: active,
    observedAt: now.toISOString(),
    runtimeSeconds: endedRuntimeSeconds // may be null
  };

  // Important: fire-and-forget both; do not let one block the other
  // but we still log failures for parity checks.
  const [bubbleRes, coreRes] = await Promise.allSettled([
    postToBubbleAsync(bubblePayload),
    postToCoreIngestAsync(buildCorePayload(corePayloadBase, last))
  ]);

  if (bubbleRes.status === 'rejected') {
    console.warn('[dual-post] Bubble failed:', bubbleRes.reason?.message || bubbleRes.reason);
  }
  if (coreRes.status === 'rejected') {
    console.warn('[dual-post] Core failed:', coreRes.reason?.message || coreRes.reason);
  }

  return {
    ok: true,
    active,
    endedRuntimeSeconds,
    last
  };
}

// Optional: recover open sessions after process restarts (based on DB flags)
async function recoverActiveSessions() {
  const pool = getPool();
  const { rows } = await pool.query(
    `
    SELECT device_key, device_name
    FROM device_status
    WHERE is_running = true
    `
  );
  // We do not know exact session start time after restart; seed "startedAt = now"
  // Sessions will be conservative (will not overcount from before restart).
  const now = new Date();
  for (const r of rows) {
    activeDevices.set(r.device_key, {
      sessionId: uuidv4(),
      startedAt: now,
      lastActiveAt: now
    });
  }
  console.log(`[recovery] seeded ${rows.length} active sessions at ${now.toISOString()}`);
}

module.exports = {
  handleNormalizedUpdate,
  recoverActiveSessions,
  // exported for tests/diagnostics
  _activeDevices: activeDevices,
  _helpers: { isHvacActive, deriveLastFields }
};
