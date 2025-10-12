'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToCoreIngestAsync } = require('./ingestPoster');
const { postToBubbleAsync } = require('./bubblePoster');
const { buildCorePayload } = require('./buildCorePayload');

// ================================
// In-memory device state
// ================================
const deviceStateMemory = new Map();

const MIN_SEGMENT_SECONDS = 5; // Ignore tiny blips
const MAX_OUT_OF_ORDER_MS = 60000; // 1 minute tolerance
const DEBUG_RUNTIME = process.env.DEBUG_RUNTIME === '1';

// =========================================
// Core device update (temperature / idle)
// =========================================
async function handleDeviceUpdate(normalized) {
  const {
    deviceKey,
    userId,
    deviceName,
    manufacturer,
    model,
    serialNumber,
    tempF,
    humidity,
    isActive,
    equipmentStatus,
    heatSetpoint,
    coolSetpoint,
  } = normalized;

  const now = new Date();
  const nowMs = now.getTime();
  const prevState = deviceStateMemory.get(deviceKey) || {};

  const MIN_TEMP_DELTA = 0.5; // °F
  const MIN_TIME_DELTA_MS = 15 * 60 * 1000; // 15 min

  const tempChanged =
    typeof tempF === 'number' &&
    typeof prevState.lastTempF === 'number' &&
    Math.abs(tempF - prevState.lastTempF) >= MIN_TEMP_DELTA;

  const timeExceeded =
    !prevState.lastPostTempAt || nowMs - prevState.lastPostTempAt >= MIN_TIME_DELTA_MS;

  const shouldPostTempUpdate = tempChanged || timeExceeded;

  // --- post temperature update while idle
  if (shouldPostTempUpdate) {
    const payload = buildCorePayload({
      deviceKey,
      userId,
      deviceName,
      manufacturer,
      model,
      serialNumber,
      connectionSource: 'nest',
      source: 'nest',
      sourceVendor: 'nest',
      eventType: 'STATE_UPDATE',
      equipmentStatus: equipmentStatus || 'OFF',
      previousStatus: prevState.lastEquipStatus || 'UNKNOWN',
      isActive: false,
      mode: 'off',
      runtimeSeconds: null,
      temperatureF: tempF,
      humidity,
      heatSetpoint,
      coolSetpoint,
      observedAt: now,
      sourceEventId: uuidv4(),
      payloadRaw: normalized,
    });

    await postToCoreIngestAsync(payload, 'state-update');
  }

  // --- persist latest state
  deviceStateMemory.set(deviceKey, {
    ...prevState,
    lastTempF: tempF,
    lastHumidity: humidity,
    lastIsActive: isActive,
    lastEquipStatus: equipmentStatus,
    lastPostTempAt: shouldPostTempUpdate ? nowMs : prevState.lastPostTempAt,
  });
}

// =========================================
// Runtime session tracking (start/stop)
// =========================================
async function handleRuntimeEvent(event) {
  const pool = getPool();
  const client = await pool.connect();
  const nowMs = Date.now();

  try {
    const deviceKey = event.deviceKey;
    const isActive = event.isActive;
    const equipmentStatus = event.equipmentStatus || 'OFF';
    const eventType = event.eventType || (isActive ? 'HVAC_ON' : 'HVAC_OFF');
    const temperatureF = event.temperatureF ?? null;
    const userId = event.userId || 'unknown';
    const deviceName = event.deviceName || 'Nest Thermostat';

    let rec = deviceStateMemory.get(deviceKey) || {
      lastIsActive: null,
      lastActiveStart: null,
      lastEventTime: null,
      lastEquipStatus: 'UNKNOWN',
    };

    if (rec.lastEventTime && nowMs < rec.lastEventTime) {
      const diff = rec.lastEventTime - nowMs;
      if (diff < MAX_OUT_OF_ORDER_MS) {
        if (DEBUG_RUNTIME)
          console.log(`⚠️ Out-of-order event for ${deviceKey} (${diff}ms) - adjusting timestamp`);
        nowMs = rec.lastEventTime + 1;
      } else {
        console.warn(`⚠️ Skipping too-old event for ${deviceKey}`);
        return;
      }
    }

    let runtimeSeconds = null;

    // Transition from active → inactive
    if (!isActive && rec.lastIsActive && rec.lastActiveStart) {
      const durationMs = nowMs - rec.lastActiveStart;
      const durationSec = Math.round(durationMs / 1000);
      if (durationSec >= MIN_SEGMENT_SECONDS) {
        runtimeSeconds = durationSec;

        const payload = buildCorePayload({
          deviceKey,
          userId,
          deviceName,
          manufacturer: 'Google Nest',
          model: 'Nest Thermostat',
          connectionSource: 'nest',
          source: 'nest',
          sourceVendor: 'nest',
          eventType,
          equipmentStatus,
          previousStatus: rec.lastEquipStatus || 'UNKNOWN',
          isActive: false,
          runtimeSeconds,
          temperatureF,
          observedAt: new Date(),
          sourceEventId: uuidv4(),
          payloadRaw: event,
        });

        await postToCoreIngestAsync(payload, 'runtime-end');
        await postToBubbleAsync(payload);

        console.log(
          `✅ [runtimeTracker] Closed session for ${deviceKey} (${durationSec}s, ${equipmentStatus})`
        );
      } else {
        if (DEBUG_RUNTIME)
          console.log(`[runtimeTracker] Short runtime ignored (${durationSec}s < ${MIN_SEGMENT_SECONDS}s)`);
      }

      rec.lastActiveStart = null;
    }

    // Transition from inactive → active
    if (isActive && !rec.lastIsActive) {
      rec.lastActiveStart = nowMs;
      if (DEBUG_RUNTIME)
        console.log(`[runtimeTracker] Started runtime for ${deviceKey} (${equipmentStatus})`);
    }

    // Update state tracking
    rec.lastIsActive = isActive;
    rec.lastEventTime = nowMs;
    rec.lastEquipStatus = equipmentStatus;
    deviceStateMemory.set(deviceKey, rec);

    // Persist runtime state in DB
    await client.query(
      `
      INSERT INTO device_runtime_state 
      (device_id, last_is_active, last_active_start, last_event_time, last_state, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (device_id) DO UPDATE SET
        last_is_active = EXCLUDED.last_is_active,
        last_active_start = EXCLUDED.last_active_start,
        last_event_time = EXCLUDED.last_event_time,
        last_state = EXCLUDED.last_state,
        updated_at = NOW()
    `,
      [
        deviceKey,
        rec.lastIsActive,
        rec.lastActiveStart ? new Date(rec.lastActiveStart).toISOString() : null,
        new Date(rec.lastEventTime).toISOString(),
        equipmentStatus,
      ]
    );
  } catch (err) {
    console.error('[runtimeTracker] ❌ Runtime error:', err);
  } finally {
    client.release();
  }
}

// =========================================
// Startup recovery
// =========================================
async function recoverActiveSessions() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT device_id, last_is_active, last_active_start, last_event_time, last_state FROM device_runtime_state'
    );
    console.log(`[runtimeTracker] Recovered ${result.rows.length} devices from DB`);
    for (const row of result.rows) {
      deviceStateMemory.set(row.device_id, {
        lastIsActive: row.last_is_active,
        lastActiveStart: row.last_active_start ? new Date(row.last_active_start).getTime() : null,
        lastEventTime: row.last_event_time ? new Date(row.last_event_time).getTime() : null,
        lastEquipStatus: row.last_state || 'UNKNOWN',
      });
    }
  } catch (err) {
    console.error('[runtimeTracker] ❌ Error recovering sessions:', err);
  } finally {
    client.release();
  }
}

// =========================================
// Unified webhook entrypoint (for routes/webhook.js)
// =========================================
async function handleDeviceEvent(eventData) {
  try {
    const resource = eventData?.resourceUpdate || {};
    const traits = resource.traits || {};
    const hvac = traits['sdm.devices.traits.ThermostatHvac'] || {};
    const temp = traits['sdm.devices.traits.Temperature'] || {};
    const humidity = traits['sdm.devices.traits.Humidity'] || {};
    const deviceKey = eventData.deviceKey || resource.name?.split('/').pop();

    if (!deviceKey) {
      console.warn('[handleDeviceEvent] ⚠️ Missing deviceKey — skipping event');
      return;
    }

    const status = hvac.status || 'OFF';
    const isActive = status !== 'OFF' && status !== 'IDLE';
    const equipmentStatus = status.toUpperCase();

    const normalized = {
      deviceKey,
      userId: eventData.userId || 'unknown',
      deviceName: eventData.deviceName || 'Nest Thermostat',
      manufacturer: 'Google Nest',
      model: 'Nest Thermostat',
      serialNumber: null,
      tempF: temp.ambientTemperatureFahrenheit ?? null,
      humidity: humidity.ambientHumidityPercent ?? null,
      isActive,
      equipmentStatus,
      heatSetpoint:
        traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius ?? null,
      coolSetpoint:
        traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius ?? null,
    };

    // Update state + runtime tracking
    await handleDeviceUpdate(normalized);
    await handleRuntimeEvent({
      ...normalized,
      eventType: isActive ? 'HVAC_ON' : 'HVAC_OFF',
    });
  } catch (err) {
    console.error('[handleDeviceEvent] ❌ Error:', err);
  }
}

// =========================================
// Unified export
// =========================================
module.exports = {
  handleDeviceEvent,
  handleDeviceUpdate,
  handleRuntimeEvent,
  recoverActiveSessions,
};
