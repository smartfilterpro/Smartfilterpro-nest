'use strict';

const { v4: uuidv4 } = require('uuid');
const { getPool } = require('../database/db');
const { postToBubbleAsync } = require('./bubblePoster');
const { postToCoreIngestAsync } = require('./ingestPoster');

// In-memory tracking of active devices
const activeDevices = new Map();

/**
 * Rehydrate sessions marked as active from DB on startup
 */
async function recoverActiveSessions() {
  const pool = getPool();
  try {
    const result = await pool.query(`
      SELECT 
        ds.device_key,
        ds.frontend_id,
        ds.device_name,
        ds.is_running,
        ds.session_start_at
      FROM device_status ds
      WHERE ds.is_running = TRUE;
    `);

    for (const row of result.rows) {
      activeDevices.set(row.device_key, {
        deviceKey: row.device_key,
        deviceName: row.device_name,
        startTime: new Date(row.session_start_at),
      });
    }
    console.log(`[runtimeTracker] Recovered ${activeDevices.size} active sessions from DB.`);
  } catch (err) {
    console.error('[runtimeTracker] Error recovering sessions:', err.message);
  }
}

/**
 * Handles normalized updates from webhook -> ingest
 */
async function handleNormalizedUpdate(event) {
  try {
    const {
      deviceKey,
      hvacStatus,
      fanTimerMode,
      currentTempC,
      humidityPercent,
      isTelemetryOnly,
      deviceName,
      userId,
      source = 'nest',
      eventId,
      observedAt
    } = event;

    // ✅ Skip telemetry-only updates
    if (isTelemetryOnly) {
      console.log(`[runtimeTracker] Skipping telemetry-only update for ${deviceKey}`);
      return;
    }

    const isActive =
      hvacStatus === 'HEATING' || hvacStatus === 'COOLING' || fanTimerMode === 'ON';

    const now = new Date(observedAt || Date.now());
    const prevSession = activeDevices.get(deviceKey);
    let runtimeSeconds = null;
    let eventType = null;
    let previousStatus = prevSession?.lastStatus || 'UNKNOWN';

    // 🆕 Stable source_event_id for deduplication
    const sourceEventId =
      eventId ||
      `${deviceKey}-${hvacStatus}-${now.toISOString().slice(0, 19)}`;

    // 🧭 Determine transitions
    if (isActive && !prevSession) {
      // 🟢 Start of new runtime session
      activeDevices.set(deviceKey, {
        startTime: now,
        lastStatus: hvacStatus,
      });
      eventType = `${hvacStatus}_ON`;
      console.log(`[runtimeTracker] Session started for ${deviceKey} (${hvacStatus})`);
    } else if (!isActive && prevSession) {
      // 🔴 End of session
      const durationMs = now - prevSession.startTime;
      runtimeSeconds = Math.round(durationMs / 1000);
      activeDevices.delete(deviceKey);
      eventType = 'STATUS_CHANGE';
      console.log(
        `[runtimeTracker] Session ended for ${deviceKey}. Runtime: ${runtimeSeconds}s`
      );
    } else {
      // 🟡 Steady state (no transition)
      eventType = 'STATUS_CHANGE';
    }

    // 🧩 Build payload for Core + Bubble
    const payload = {
      device_key: deviceKey,
      device_id: `nest:${deviceKey}`,
      workspace_id: userId || 'unknown',
      device_name: deviceName || 'Nest Thermostat',
      manufacturer: 'Google Nest',
      model: 'Nest Thermostat',
      source,
      connection_source: 'nest',
      event_type: eventType,
      is_active: isActive,
      equipment_status: hvacStatus || 'OFF',
      previous_status: previousStatus,
      temperature_c: currentTempC,
      humidity: humidityPercent,
      runtime_seconds: runtimeSeconds,
      timestamp: now.toISOString(),
      source_event_id: sourceEventId,
      payload_raw: event
    };

    console.log(
      `[runtimeTracker] → Forwarding to Core: ${payload.device_id} | ${payload.event_type} | ${payload.equipment_status} | active=${payload.is_active} | runtime=${payload.runtime_seconds ?? '—'}`
    );

    // ✅ Dual-post to Core and Bubble
    await Promise.allSettled([
      postToCoreIngestAsync(payload),
      postToBubbleAsync(payload)
    ]);

  } catch (err) {
    console.error('[runtimeTracker] ❌ Error handling normalized update:', err.message);
  }
}

module.exports = {
  handleNormalizedUpdate,
  recoverActiveSessions,
};
