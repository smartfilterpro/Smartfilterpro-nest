'use strict';

/**
 * Nest Runtime Webhook — Fan-Truth Runtime Tracker
 * - Counts runtime ONLY when air is moving (fanRunning):
 *   fanRunning = HEATING || COOLING || FAN_ONLY || Fan.timerMode == ON
 * - Infers HEATING/COOLING when SDM doesn't send ThermostatHvac.status
 * - Sends heartbeat ticks every ~10 min during continuous runtime
 * - Watchdog closes hung sessions after RUNTIME_TIMEOUT_HOURS
 */

console.log('Starting Nest server...');

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

console.log('All modules loaded successfully');

const app = express();
const PORT = process.env.PORT || 8080;

/* ───────────── Config ───────────── */
const DATABASE_URL = process.env.DATABASE_URL;
const ENABLE_DATABASE = process.env.ENABLE_DATABASE !== '0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const STALENESS_CHECK_INTERVAL = 60 * 60 * 1000;   // 1h
const STALENESS_THRESHOLD = (parseInt(process.env.STALENESS_THRESHOLD_HOURS) || 12) * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000;       // (reserved)
const RUNTIME_TIMEOUT = (parseInt(process.env.RUNTIME_TIMEOUT_HOURS) || 4) * 60 * 60 * 1000;
const TICK_INTERVAL_MS = 10 * 60 * 1000;           // 10 min tick

/* ───────────── App setup ───────────── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json());

/* ───────────── In-memory state ───────────── */
const sessions = {};     // key -> { startTime, startStatus('cool'|'heat'|'fan'), startTemperature }
const deviceStates = {}; // key -> last known state snapshot

/* ───────────── DB pool ───────────── */
let pool = null;
if (ENABLE_DATABASE && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.DB_MAX_CONNECTIONS || '10'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => console.error('Database pool error:', err.message));
}

/* ───────────── Utilities ───────────── */
function toTimestamp(dateStr) { return new Date(dateStr).getTime(); }
function cToF(c) { if (c == null || !Number.isFinite(c)) return null; return Math.round((c * 9) / 5 + 32); }

function mapEquipmentStatus(hvacStatus, isFanTimerOn) {
  const s = (hvacStatus || '').toUpperCase();
  if (s === 'HEATING') return 'heat';
  if (s === 'COOLING') return 'cool';
  if (s === 'FAN_ONLY') return 'fan';
  if (isFanTimerOn) return 'fan';
  if (s === 'OFF' || !s) return 'off';
  return 'unknown';
}

function deriveFlags(hvacStatus, fanTimerOn) {
  const s = (hvacStatus || '').toUpperCase();
  const isHeating = s === 'HEATING';
  const isCooling = s === 'COOLING';
  const isFanOnly = s === 'FAN_ONLY' || (!!fanTimerOn && !isHeating && !isCooling);
  const equipmentStatus = mapEquipmentStatus(s, fanTimerOn);
  // fanRunning = true whenever air is moving through filter
  const fanRunning = isHeating || isCooling || isFanOnly;
  return { isHeating, isCooling, isFanOnly, equipmentStatus, fanRunning };
}

function inferActiveFromModeAndTemps(mode, ambientC, heatC, coolC) {
  const m = (mode || '').toUpperCase();
  if (!Number.isFinite(ambientC)) return { hvac: 'OFF', active: false };
  const DB = 0.3; // ~0.5°F
  if (m === 'HEAT' && Number.isFinite(heatC)) {
    if (ambientC < (heatC - DB)) return { hvac: 'HEATING', active: true };
    if (ambientC >= heatC)       return { hvac: 'OFF',     active: false };
  } else if (m === 'COOL' && Number.isFinite(coolC)) {
    if (ambientC > (coolC + DB)) return { hvac: 'COOLING', active: true };
    if (ambientC <= coolC)       return { hvac: 'OFF',     active: false };
  } else if (m === 'HEATCOOL' && Number.isFinite(heatC) && Number.isFinite(coolC)) {
    if (ambientC < (heatC - DB)) return { hvac: 'HEATING', active: true };
    if (ambientC > (coolC + DB)) return { hvac: 'COOLING', active: true };
    return { hvac: 'OFF', active: false };
  }
  return { hvac: 'OFF', active: false };
}

function extractRoomDisplayName(eventData) {
  const parentRelations = eventData.resourceUpdate?.parentRelations;
  if (!Array.isArray(parentRelations)) return null;
  const roomRelation = parentRelations.find(r => r.parent && r.parent.includes('/rooms/'));
  return roomRelation?.displayName || null;
}

function cleanPayloadForBubble(payload) {
  const cleaned = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== null && value !== undefined && value !== '') {
      if (typeof value === 'number' && !isFinite(value)) continue;
      cleaned[key] = value;
    } else if (key.includes('Temp') || key.includes('Setpoint')) {
      cleaned[key] = 0;
    } else if (key === 'runtimeSeconds' || key === 'runtimeMinutes') {
      cleaned[key] = 0;
    } else if (typeof payload[key] === 'boolean') {
      cleaned[key] = value || false;
    }
  }
  return cleaned;
}

function sanitizeForLogging(data) {
  if (!data) return data;
  const s = { ...data };
  if (s.userId) s.userId = s.userId.substring(0, 8) + '…';
  if (s.deviceName) {
    const tail = s.deviceName.split('/').pop() || '';
    s.deviceName = 'device-' + tail.substring(0, 8) + '…';
  }
  if (s.thermostatId) s.thermostatId = s.thermostatId.substring(0, 8) + '…';
  return s;
}

/* ───────────── DB helpers (optional) ───────────── */
async function ensureDeviceExists(deviceKey) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO device_states (device_key) VALUES ($1)
       ON CONFLICT (device_key) DO NOTHING`,
      [deviceKey]
    );
  } catch (e) { console.error('ensureDeviceExists:', e.message); }
}

async function getDeviceState(deviceKey) {
  if (!pool) return deviceStates[deviceKey] || null;
  try {
    const r = await pool.query(`SELECT * FROM device_states WHERE device_key = $1`, [deviceKey]);
    if (!r.rows.length) return null;
    const row = r.rows[0];
    return {
      isRunning: row.is_running || false,
      sessionStartedAt: row.session_started_at ? new Date(row.session_started_at).getTime() : null,
      currentMode: row.current_mode || 'off',
      lastTemperature: row.last_temperature != null ? Number(row.last_temperature) : null,
      lastHeatSetpoint: row.last_heat_setpoint != null ? Number(row.last_heat_setpoint) : null,
      lastCoolSetpoint: row.last_cool_setpoint != null ? Number(row.last_cool_setpoint) : null,
      lastEquipmentStatus: row.last_equipment_status,
      isReachable: row.is_reachable !== false,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).getTime() : Date.now(),
      lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).getTime() : Date.now(),
      roomDisplayName: row.room_display_name
    };
  } catch (e) {
    console.error('getDeviceState:', e.message);
    return deviceStates[deviceKey] || null;
  }
}

async function updateDeviceState(deviceKey, state) {
  deviceStates[deviceKey] = state;
  if (!pool) return;
  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `UPDATE device_states SET
        is_running = $2,
        session_started_at = $3,
        current_mode = $4,
        last_temperature = $5,
        last_heat_setpoint = $6,
        last_cool_setpoint = $7,
        last_equipment_status = $8,
        is_reachable = $9,
        last_seen_at = $10,
        last_activity_at = $11,
        room_display_name = $12,
        updated_at = NOW()
       WHERE device_key = $1`,
      [
        deviceKey,
        !!state.isRunning,
        state.sessionStartedAt ? new Date(state.sessionStartedAt) : null,
        state.currentMode || 'off',
        state.lastTemperature,
        state.lastHeatSetpoint,
        state.lastCoolSetpoint,
        state.lastEquipmentStatus,
        state.isReachable !== false,
        state.lastSeenAt ? new Date(state.lastSeenAt) : new Date(),
        state.lastActivityAt ? new Date(state.lastActivityAt) : new Date(),
        state.roomDisplayName
      ]
    );
  } catch (e) { console.error('updateDeviceState:', e.message); }
}

async function logRuntimeSession(deviceKey, sessionData) {
  if (!pool) return null;
  try {
    await ensureDeviceExists(deviceKey);
    const r = await pool.query(
      `INSERT INTO runtime_sessions
       (device_key, mode, equipment_status, started_at, ended_at, duration_seconds,
        start_temperature, end_temperature, heat_setpoint, cool_setpoint)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, session_id`,
      [
        deviceKey,
        sessionData.mode,
        sessionData.equipmentStatus,
        sessionData.startedAt ? new Date(sessionData.startedAt) : null,
        sessionData.endedAt ? new Date(sessionData.endedAt) : null,
        sessionData.durationSeconds,
        sessionData.startTemperature,
        sessionData.endTemperature,
        sessionData.heatSetpoint,
        sessionData.coolSetpoint
      ]
    );
    return r.rows[0];
  } catch (e) {
    console.error('logRuntimeSession:', e.message);
    return null;
  }
}

async function logTemperatureReading(deviceKey, temperatureF, units = 'F', eventType = 'reading') {
  if (!pool) return;
  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `INSERT INTO temperature_readings (device_key, temperature, units, event_type)
       VALUES ($1,$2,$3,$4)`,
      [deviceKey, Number(temperatureF), String(units), String(eventType)]
    );
  } catch (e) { console.error('logTemperatureReading:', e.message); }
}

async function logEquipmentEvent(deviceKey, eventType, equipmentStatus, previousStatus, isActive, eventData = {}) {
  if (!pool) return;
  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `INSERT INTO equipment_events
       (device_key, event_type, equipment_status, previous_status, is_active, event_data)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [deviceKey, eventType, equipmentStatus, previousStatus, !!isActive, JSON.stringify(eventData)]
    );
  } catch (e) { console.error('logEquipmentEvent:', e.message); }
}

/* ───────────── Bubble posting ───────────── */
async function postToBubble(payload) {
  if (!process.env.BUBBLE_WEBHOOK_URL) return;
  const cleaned = cleanPayloadForBubble(payload);
  await axios.post(process.env.BUBBLE_WEBHOOK_URL, cleaned, {
    timeout: 10000,
    headers: { 'User-Agent': 'Nest-Runtime-Tracker/1.3', 'Content-Type': 'application/json' }
  });
}

/* ───────────── Event handler ───────────── */
async function handleNestEvent(eventData) {
  if (!IS_PRODUCTION) console.log('Processing Nest event…');

  const userId = eventData.userId;
  const deviceName = eventData.resourceUpdate?.name;
  const traits = eventData.resourceUpdate?.traits || {};
  const timestamp = eventData.timestamp;
  const deviceId = deviceName?.split('/').pop();
  const roomDisplayName = extractRoomDisplayName(eventData);

  if (!userId || !deviceId || !timestamp) {
    console.warn('Skipping incomplete Nest event');
    return;
  }

  const eventTime = toTimestamp(timestamp);
  const key = `${userId}-${deviceId}`;
  const prev = (await getDeviceState(key)) || {};

  // Traits
  const hvacStatusRaw = traits['sdm.devices.traits.ThermostatHvac']?.status;  // HEATING|COOLING|OFF (FAN_ONLY possible in some firmwares)
  const currentTemp = traits['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
  const coolSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;
  const heatSetpoint = traits['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
  const mode = traits['sdm.devices.traits.ThermostatMode']?.mode;
  const fanTimerMode = traits['sdm.devices.traits.Fan']?.timerMode;           // ON|OFF
  const fanTimerOn = fanTimerMode === 'ON';
  const connectivityStatus = traits['sdm.devices.traits.Connectivity']?.status;
  const isReachable = (connectivityStatus === 'OFFLINE') ? false :
                      (connectivityStatus === 'ONLINE')  ? true  :
                      (prev.isReachable ?? true);

  // Resolve hvacStatus (with inference fallback)
  let hvacStatusEff = hvacStatusRaw || 'OFF';
  if (!hvacStatusRaw) {
    const effAmbient = currentTemp ?? prev.lastTemperature ?? null;
    const effCool = coolSetpoint ?? prev.lastCoolSetpoint ?? null;
    const effHeat = heatSetpoint ?? prev.lastHeatSetpoint ?? null;
    const inferred = inferActiveFromModeAndTemps(mode, effAmbient, effHeat, effCool);
    if (inferred.active) hvacStatusEff = inferred.hvac; // 'HEATING' or 'COOLING'
  }

  // Derive flags and fan truth
  const { isHeating, isCooling, isFanOnly, equipmentStatus, fanRunning } = deriveFlags(hvacStatusEff, fanTimerOn);

  // Event classifications
  const isTemperatureOnlyEvent = !hvacStatusRaw && currentTemp != null && !connectivityStatus;
  const isConnectivityOnly = !!connectivityStatus && !hvacStatusRaw && currentTemp == null;

  // Helper to build Bubble payloads (isHvacActive == fanRunning)
  function createBubblePayload(runtimeSeconds = 0, isRuntimeEvent = false, sessionData = null) {
    const effAmbient = currentTemp ?? prev.lastTemperature ?? null;
    const effCool = coolSetpoint ?? prev.lastCoolSetpoint ?? null;
    const effHeat = heatSetpoint ?? prev.lastHeatSetpoint ?? null;

    return {
      userId,
      thermostatId: deviceId,
      deviceName,
      roomDisplayName: roomDisplayName || '',
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      isRuntimeEvent,

      hvacMode: hvacStatusEff,                 // 'HEATING'|'COOLING'|'OFF'|('FAN_ONLY' if seen)
      isHvacActive: !!fanRunning,              // air moving?
      thermostatMode: mode || prev.currentMode || 'OFF',
      isReachable,

      currentTempF: cToF(effAmbient),
      coolSetpointF: cToF(effCool),
      heatSetpointF: cToF(effHeat),
      startTempF: sessionData?.startTemperature != null ? cToF(sessionData.startTemperature) : 0,
      endTempF: cToF(effAmbient),

      currentTempC: effAmbient ?? 0,
      coolSetpointC: effCool ?? 0,
      heatSetpointC: effHeat ?? 0,
      startTempC: sessionData?.startTemperature ?? 0,
      endTempC: effAmbient ?? 0,

      lastIsCooling: !!prev.lastEquipmentStatus?.includes('cool'),
      lastIsHeating: !!prev.lastEquipmentStatus?.includes('heat'),
      lastIsFanOnly: !!prev.lastEquipmentStatus?.includes('fan'),
      lastEquipmentStatus: prev.lastEquipmentStatus || 'unknown',

      equipmentStatus,            // 'cool'|'heat'|'fan'|'off'|'unknown'
      isFanOnly,                  // explicit fan-only flag

      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime,
    };
  }

  /* ───────── Temperature-only events ───────── */
  if (isTemperatureOnlyEvent) {
    await logTemperatureReading(key, cToF(currentTemp), 'F', 'ThermostatIndoorTemperatureEvent');

    // Use *fan truth* for activity (sessions only matter when air moves)
    const currentlyRunning = !!(sessions[key]) || !!prev.isRunning;
    const nowFanRunning = currentlyRunning; // if we were running, assume still running unless inference says off

    // Heartbeat tick during long runs
    if (currentlyRunning && sessions[key]?.startTime) {
      const runSec = Math.floor((eventTime - sessions[key].startTime) / 1000);
      const lastUpdate = prev.lastActivityAt || 0;
      const shouldTick = (eventTime - lastUpdate) > TICK_INTERVAL_MS;
      if (shouldTick && runSec > 60) {
        const tickPayload = createBubblePayload(runSec, false, { startTemperature: sessions[key].startTemperature });
        try { await postToBubble(tickPayload); } catch (e) { console.error('Tick post failed:', e.response?.status || e.code || e.message); }
        if (!IS_PRODUCTION) console.log('Tick posted:', sanitizeForLogging({ runSec, isFanOnly: sessions[key]?.startStatus === 'fan' }));
      }
    }

    // If inference indicates OFF, close any open session
    const effAmbient = currentTemp ?? prev.lastTemperature ?? null;
    const effCool = coolSetpoint ?? prev.lastCoolSetpoint ?? null;
    const effHeat = heatSetpoint ?? prev.lastHeatSetpoint ?? null;
    const inferred = inferActiveFromModeAndTemps(mode, effAmbient, effHeat, effCool);

    if (!inferred.active && (sessions[key] || prev.isRunning)) {
      let session = sessions[key] || (prev.sessionStartedAt ? {
        startTime: prev.sessionStartedAt,
        startStatus: prev.currentMode || 'unknown',
        startTemperature: prev.lastTemperature ?? effAmbient
      } : null);

      if (session?.startTime) {
        const runtimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
        if (runtimeSeconds > 0 && runtimeSeconds < 24 * 3600) {
          await logRuntimeSession(key, {
            mode: session.startStatus,
            equipmentStatus: 'off',
            startedAt: session.startTime,
            endedAt: eventTime,
            durationSeconds: runtimeSeconds,
            startTemperature: session.startTemperature,
            endTemperature: effAmbient,
            heatSetpoint: effHeat,
            coolSetpoint: effCool
          });

          const endPayload = createBubblePayload(runtimeSeconds, true, session);
          try { await postToBubble(endPayload); } catch (e) { console.error('End post failed:', e.response?.status || e.code || e.message); }
          if (!IS_PRODUCTION) console.log('Session closed by inference:', sanitizeForLogging({ runtimeSeconds }));
        }
      }
      delete sessions[key];

      await updateDeviceState(key, {
        ...prev,
        isRunning: false,
        sessionStartedAt: null,
        currentMode: 'off',
        lastTemperature: currentTemp ?? prev.lastTemperature,
        lastHeatSetpoint: heatSetpoint ?? prev.lastHeatSetpoint,
        lastCoolSetpoint: coolSetpoint ?? prev.lastCoolSetpoint,
        lastEquipmentStatus: 'off',
        isReachable,
        lastSeenAt: eventTime,
        lastActivityAt: eventTime,
        roomDisplayName: roomDisplayName || prev.roomDisplayName
      });
      return;
    }

    // Update state (don’t change currentMode unless we’re running)
    await updateDeviceState(key, {
      ...prev,
      lastTemperature: currentTemp ?? prev.lastTemperature,
      lastHeatSetpoint: heatSetpoint ?? prev.lastHeatSetpoint,
      lastCoolSetpoint: coolSetpoint ?? prev.lastCoolSetpoint,
      lastSeenAt: eventTime,
      lastActivityAt: eventTime,
      isReachable,
      roomDisplayName: roomDisplayName || prev.roomDisplayName,
      currentMode: currentlyRunning ? (prev.currentMode || 'unknown') : (prev.currentMode || 'off'),
      isRunning: !!currentlyRunning
    });
    return;
  }

  /* ───────── Connectivity-only events ───────── */
  if (isConnectivityOnly) {
    const payload = createBubblePayload(0, false);
    try { await postToBubble(payload); } catch (e) { console.error('Connectivity post failed:', e.response?.status || e.code || e.message); }
    await updateDeviceState(key, {
      ...prev,
      isReachable,
      lastSeenAt: eventTime,
      lastActivityAt: eventTime,
      roomDisplayName: roomDisplayName || prev.roomDisplayName
    });
    return;
  }

  /* ───────── Full HVAC / fan-truth processing ───────── */
  const wasRunning = !!prev.isRunning;
  const nowRunning = !!(deriveFlags(hvacStatusEff, fanTimerOn).fanRunning); // air moving?

  // Watch for equipment state change (for auditing)
  if (equipmentStatus !== prev.lastEquipmentStatus) {
    await logEquipmentEvent(
      key,
      'EquipmentStateChanged',
      equipmentStatus,
      prev.lastEquipmentStatus,
      nowRunning,
      { temperature: currentTemp, fanTimerOn, timestamp: eventTime }
    );
  }

  let payload;

  // 🟢 Turned ON (air started moving)
  if (nowRunning && !wasRunning) {
    // Close any stray session
    if (sessions[key]?.startTime) {
      const prevRun = Math.floor((eventTime - sessions[key].startTime) / 1000);
      if (prevRun > 0 && prevRun < 24 * 3600) {
        await logRuntimeSession(key, {
          mode: sessions[key].startStatus || 'unknown',
          equipmentStatus: 'interrupted',
          startedAt: sessions[key].startTime,
          endedAt: eventTime,
          durationSeconds: prevRun,
          startTemperature: sessions[key].startTemperature,
          endTemperature: currentTemp ?? prev.lastTemperature ?? null,
          heatSetpoint: heatSetpoint ?? prev.lastHeatSetpoint ?? null,
          coolSetpoint: coolSetpoint ?? prev.lastCoolSetpoint ?? null
        });
      }
    }

    const startStatus =
      equipmentStatus === 'cool' ? 'cool' :
      equipmentStatus === 'heat' ? 'heat' :
      'fan';

    sessions[key] = {
      startTime: eventTime,
      startStatus,
      startTemperature: currentTemp ?? prev.lastTemperature ?? null
    };

    payload = createBubblePayload(0, false);
    if (!IS_PRODUCTION) console.log(`✅ Session started (${startStatus})`);

  // 🔴 Turned OFF (air stopped)
  } else if (!nowRunning && wasRunning) {
    let session = sessions[key] || (prev.sessionStartedAt ? {
      startTime: prev.sessionStartedAt,
      startStatus: prev.currentMode || 'unknown',
      startTemperature: prev.lastTemperature ?? currentTemp ?? null
    } : null);

    if (session?.startTime) {
      const runtimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
      if (runtimeSeconds > 0 && runtimeSeconds < 24 * 3600) {
        await logRuntimeSession(key, {
          mode: session.startStatus,
          equipmentStatus, // likely 'off'|'cool'|'heat'|'fan'
          startedAt: session.startTime,
          endedAt: eventTime,
          durationSeconds: runtimeSeconds,
          startTemperature: session.startTemperature,
          endTemperature: currentTemp ?? prev.lastTemperature ?? null,
          heatSetpoint: heatSetpoint ?? prev.lastHeatSetpoint ?? null,
          coolSetpoint: coolSetpoint ?? prev.lastCoolSetpoint ?? null
        });
        payload = createBubblePayload(runtimeSeconds, true, session);
        if (!IS_PRODUCTION) console.log(`✅ Session ended (${session.startStatus}) — ${runtimeSeconds}s`);
      } else {
        payload = createBubblePayload(0, false);
        console.warn('Invalid runtime, sending 0');
      }
    } else {
      console.warn('No session data for OFF edge; sending 0');
      payload = createBubblePayload(0, false);
    }
    delete sessions[key];

  // 🟡 Still ON — heartbeat tick every TICK_INTERVAL_MS
  } else if (nowRunning && sessions[key]) {
    const runSec = Math.floor((eventTime - sessions[key].startTime) / 1000);
    const lastUpdate = prev.lastActivityAt || 0;
    const shouldTick = (eventTime - lastUpdate) > TICK_INTERVAL_MS;
    payload = (shouldTick && runSec > 60)
      ? createBubblePayload(runSec, false, sessions[key])
      : createBubblePayload(0, false);

  // No state change
  } else {
    payload = createBubblePayload(0, false);
    if (!IS_PRODUCTION) console.log('No state change; posting telemetry only');
  }

  // Watchdog: close a stuck session if it exceeds timeout
  const sess = sessions[key];
  if (sess?.startTime && (eventTime - (prev.lastActivityAt || sess.startTime)) > RUNTIME_TIMEOUT) {
    const runtimeSeconds = Math.floor((eventTime - sess.startTime) / 1000);
    if (runtimeSeconds > 0) {
      await logRuntimeSession(key, {
        mode: sess.startStatus || 'unknown',
        equipmentStatus: 'timeout',
        startedAt: sess.startTime,
        endedAt: eventTime,
        durationSeconds: runtimeSeconds,
        startTemperature: sess.startTemperature,
        endTemperature: currentTemp ?? prev.lastTemperature ?? null,
        heatSetpoint: heatSetpoint ?? prev.lastHeatSetpoint ?? null,
        coolSetpoint: coolSetpoint ?? prev.lastCoolSetpoint ?? null
      });
      const wdPayload = createBubblePayload(runtimeSeconds, true, sess);
      try { await postToBubble(wdPayload); } catch (e) { console.error('Watchdog post failed:', e.response?.status || e.code || e.message); }
      delete sessions[key];
      if (!IS_PRODUCTION) console.log('Watchdog closed session');
    }
  }

  // Persist state
  await updateDeviceState(key, {
    ...prev,
    isRunning: nowRunning,
    sessionStartedAt: nowRunning ? (sessions[key]?.startTime || prev.sessionStartedAt) : null,
    currentMode: nowRunning ? (equipmentStatus || prev.currentMode || 'unknown') : (equipmentStatus || 'off'),
    lastTemperature: currentTemp ?? prev.lastTemperature,
    lastHeatSetpoint: heatSetpoint ?? prev.lastHeatSetpoint,
    lastCoolSetpoint: coolSetpoint ?? prev.lastCoolSetpoint,
    lastEquipmentStatus: equipmentStatus,
    isReachable,
    lastSeenAt: eventTime,
    lastActivityAt: eventTime,
    roomDisplayName: roomDisplayName || prev.roomDisplayName
  });

  // Post to Bubble
  try { await postToBubble(payload); }
  catch (err) {
    console.error('Bubble post failed:', err.response?.status || err.code || err.message);
    if (err.response?.data) console.error('Bubble error response:', err.response.data);
    setTimeout(async () => { try { await postToBubble(payload); console.log('Retry successful'); } catch (_) {} }, 5000);
  }
}

/* ───────────── Staleness monitor ───────────── */
async function sendStalenessNotification(deviceKey, deviceState, currentTime) {
  const deviceId = deviceKey.split('-').pop();
  const lastActivityTime = deviceState.lastActivityAt || 0;
  const hoursSinceLastActivity = lastActivityTime > 0 ? Math.floor((currentTime - lastActivityTime) / (60 * 60 * 1000)) : 0;

  const payload = {
    thermostatId: deviceId,
    deviceName: `Device ${deviceId}`,
    roomDisplayName: deviceState.roomDisplayName || '',
    runtimeSeconds: 0,
    runtimeMinutes: 0,
    isRuntimeEvent: false,
    hvacMode: 'UNKNOWN',
    isHvacActive: false,
    thermostatMode: 'UNKNOWN',
    isReachable: false,

    currentTempF: deviceState.lastTemperature ? cToF(deviceState.lastTemperature) : 0,
    coolSetpointF: 0,
    heatSetpointF: 0,
    startTempF: 0,
    endTempF: deviceState.lastTemperature ? cToF(deviceState.lastTemperature) : 0,
    currentTempC: deviceState.lastTemperature || 0,
    coolSetpointC: 0,
    heatSetpointC: 0,
    startTempC: 0,
    endTempC: deviceState.lastTemperature || 0,

    lastIsCooling: false,
    lastIsHeating: false,
    lastIsFanOnly: false,
    lastEquipmentStatus: deviceState.lastEquipmentStatus || 'unknown',
    equipmentStatus: 'stale',
    isFanOnly: false,

    hoursSinceLastActivity,
    lastActivityTime: lastActivityTime > 0 ? new Date(lastActivityTime).toISOString() : '',
    stalenessReason: hoursSinceLastActivity >= 24 ? 'extended_offline' : 'device_offline',

    timestamp: new Date(currentTime).toISOString(),
    eventId: `stale-${Date.now()}`,
    eventTimestamp: currentTime
  };

  try { await postToBubble(payload); }
  catch (e) { console.error('Failed to send staleness notification:', e.response?.status || e.code || e.message); }
}

setInterval(async () => {
  const now = Date.now();
  const staleThreshold = now - STALENESS_THRESHOLD;

  for (const [key, state] of Object.entries(deviceStates)) {
    const lastActivity = state.lastActivityAt || 0;
    const lastNotified = state.lastStalenessNotification || 0;
    if (lastActivity > 0 && lastActivity < staleThreshold) {
      if (!lastNotified || (now - lastNotified) >= STALENESS_THRESHOLD) {
        await sendStalenessNotification(key, state, now);
        state.lastStalenessNotification = now;
        deviceStates[key] = state;
      }
    } else if (lastActivity >= staleThreshold && state.lastStalenessNotification) {
      delete state.lastStalenessNotification;
      deviceStates[key] = state;
    }
  }

  if (pool) {
    try {
      const r = await pool.query(
        `SELECT device_key, last_activity_at, last_temperature, last_equipment_status, is_reachable, last_staleness_notification, room_display_name
         FROM device_states
         WHERE last_activity_at < $1 AND last_activity_at > $2`,
        [new Date(staleThreshold), new Date(now - (7 * 24 * 60 * 60 * 1000))]
      );
      for (const d of r.rows) {
        const lastNotified = d.last_staleness_notification ? new Date(d.last_staleness_notification).getTime() : 0;
        if (!lastNotified || (now - lastNotified) >= STALENESS_THRESHOLD) {
          await sendStalenessNotification(d.device_key, {
            lastTemperature: d.last_temperature,
            lastEquipmentStatus: d.last_equipment_status,
            lastActivityAt: new Date(d.last_activity_at).getTime(),
            roomDisplayName: d.room_display_name
          }, now);
          try {
            await pool.query(`UPDATE device_states SET last_staleness_notification = NOW() WHERE device_key = $1`, [d.device_key]);
          } catch (e) {}
        }
      }
    } catch (e) { console.error('DB stale scan error:', e.message); }
  }
}, STALENESS_CHECK_INTERVAL);

/* ───────────── Admin + Health ───────────── */
function requireAuth(req, res, next) {
  const authToken = req.headers.authorization?.replace('Bearer ', '');
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return res.status(500).json({ error: 'Admin API key not configured' });
  if (!authToken || authToken !== expected) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/admin/health', requireAuth, async (req, res) => {
  let dbStatus = 'disabled', dbInfo = {};
  if (pool) {
    try {
      const a = await pool.query(
        `SELECT COUNT(*) devices,
                COUNT(*) FILTER (WHERE is_running=true) running_sessions,
                COUNT(*) FILTER (WHERE is_reachable=false) unreachable_devices
         FROM device_states`
      );
      const b = await pool.query(
        `SELECT COUNT(*) total_sessions
           FROM runtime_sessions
          WHERE started_at > NOW() - INTERVAL '24 hours'`
      );
      dbStatus = 'connected';
      dbInfo = {
        devices: parseInt(a.rows[0].devices),
        runningSessions: parseInt(a.rows[0].running_sessions),
        unreachableDevices: parseInt(a.rows[0].unreachable_devices),
        sessionsLast24h: parseInt(b.rows[0].total_sessions)
      };
    } catch (e) { dbStatus = 'error'; dbInfo = { error: e.message }; }
  }
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memorySessions: Object.keys(sessions).length,
    memoryStates: Object.keys(deviceStates).length,
    database: { status: dbStatus, ...dbInfo },
    config: {
      stalenessThresholdHours: STALENESS_THRESHOLD / 3600000,
      runtimeTimeoutHours: RUNTIME_TIMEOUT / 3600000,
      databaseEnabled: ENABLE_DATABASE,
      bubbleConfigured: !!process.env.BUBBLE_WEBHOOK_URL
    },
    memoryUsage: process.memoryUsage()
  });
});

app.get('/health', async (req, res) => {
  let dbStatus = 'disabled';
  if (pool) {
    try { await pool.query('SELECT 1'); dbStatus = 'connected'; }
    catch (_) { dbStatus = 'error'; }
  }
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    sessions: Object.keys(sessions).length,
    uptime: process.uptime(),
    database: dbStatus,
    memoryUsage: process.memoryUsage()
  });
});

app.get('/', (req, res) => res.send('Nest Runtime Webhook server is running!'));

app.post('/webhook', async (req, res) => {
  try {
    const pubsubMessage = req.body.message;
    if (!pubsubMessage || !pubsubMessage.data) return res.status(400).send('Invalid Pub/Sub message');

    let eventData;
    try { eventData = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString()); }
    catch { return res.status(400).send('Invalid message format'); }

    await handleNestEvent(eventData);
    res.status(200).send('OK');
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.status(500).send('Internal Server Error');
  }
});

/* ───────────── DB migration/init ───────────── */
async function runDatabaseMigration() {
  if (!ENABLE_DATABASE || !pool) { console.log('Database disabled - skipping migration'); return; }
  try {
    // Create tables (same layout as your previous version; trimmed for brevity where safe)
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS device_states (
        device_key VARCHAR(300) PRIMARY KEY,
        device_name VARCHAR(600),
        room_display_name VARCHAR(200),
        units CHAR(1) DEFAULT 'F' CHECK (units IN ('F','C')),
        location_id VARCHAR(300),
        workspace_id VARCHAR(300),

        is_running BOOLEAN DEFAULT FALSE,
        session_started_at TIMESTAMPTZ,
        current_mode VARCHAR(20) DEFAULT 'off',
        current_equipment_status VARCHAR(50),

        last_temperature DECIMAL(5,2),
        last_heat_setpoint DECIMAL(5,2),
        last_cool_setpoint DECIMAL(5,2),
        last_equipment_status VARCHAR(50),

        is_reachable BOOLEAN DEFAULT TRUE,
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        last_activity_at TIMESTAMPTZ DEFAULT NOW(),
        last_post_at TIMESTAMPTZ DEFAULT NOW(),
        last_staleness_notification TIMESTAMPTZ,

        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id BIGSERIAL PRIMARY KEY,
        device_key VARCHAR(300) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
        session_id UUID DEFAULT gen_random_uuid(),
        mode VARCHAR(20) NOT NULL,
        equipment_status VARCHAR(50),
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        start_temperature DECIMAL(5,2),
        end_temperature DECIMAL(5,2),
        heat_setpoint DECIMAL(5,2),
        cool_setpoint DECIMAL(5,2),
        tick_count INTEGER DEFAULT 0,
        last_tick_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS equipment_events (
        id BIGSERIAL PRIMARY KEY,
        device_key VARCHAR(300) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        equipment_status VARCHAR(50),
        previous_status VARCHAR(50),
        is_active BOOLEAN,
        session_id UUID,
        event_data JSONB,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS temperature_readings (
        id BIGSERIAL PRIMARY KEY,
        device_key VARCHAR(300) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
        temperature DECIMAL(5,2) NOT NULL,
        units CHAR(1) NOT NULL,
        event_type VARCHAR(50),
        session_id UUID,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_device_states_last_seen ON device_states(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_device_states_running ON device_states(is_running) WHERE is_running = TRUE;
      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_device_time ON runtime_sessions(device_key, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_active ON runtime_sessions(device_key, ended_at) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_temperature_readings_device_time ON temperature_readings(device_key, recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_equipment_events_device_time ON equipment_events(device_key, recorded_at DESC);

      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ language 'plpgsql';

      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='update_device_states_updated_at') THEN
          CREATE TRIGGER update_device_states_updated_at BEFORE UPDATE ON device_states
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='update_runtime_sessions_updated_at') THEN
          CREATE TRIGGER update_runtime_sessions_updated_at BEFORE UPDATE ON runtime_sessions
          FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END $$;
    `);
    console.log('Database schema ensured');
  } catch (e) {
    console.error('Database migration failed:', e.message);
    console.warn('Continuing with memory-only operation…');
  }
}

async function initializeDatabase() {
  if (!ENABLE_DATABASE || !pool) { console.log('Database disabled - using memory-only state'); return; }
  try {
    const result = await pool.query('SELECT NOW() as now');
    console.log('Database connection established:', result.rows[0].now);
    await runDatabaseMigration();
    const stateResult = await pool.query('SELECT device_key FROM device_states');
    console.log(`Loaded ${stateResult.rows.length} device states`);
  } catch (e) {
    console.error('Database initialization failed:', e.message);
    console.warn('Falling back to memory-only state management');
  }
}

/* ───────────── Startup / Shutdown ───────────── */
app.use('*', (req, res) => res.status(404).send('Not Found'));
app.use((err, req, res, next) => { console.error('Unhandled error:', err.message); res.status(500).send('Internal Server Error'); });

process.on('SIGINT', async () => { console.log('SIGINT'); if (pool) await pool.end(); process.exit(0); });
process.on('SIGTERM', async () => { console.log('SIGTERM'); if (pool) await pool.end(); process.exit(0); });

async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server started on ${PORT} (${IS_PRODUCTION ? 'Production' : 'Development'})`);
    console.log(`Bubble webhook: ${process.env.BUBBLE_WEBHOOK_URL ? 'Configured' : 'Not configured'}`);
    console.log(`Database: ${ENABLE_DATABASE && DATABASE_URL ? 'Enabled' : 'Disabled (memory-only)'}`);
    console.log(`Staleness threshold: ${STALENESS_THRESHOLD / 3600000}h  |  Runtime timeout: ${RUNTIME_TIMEOUT / 3600000}h`);
    console.log('Ready to receive Nest events at POST /webhook');
  });
}

startServer().catch(e => { console.error('Failed to start server:', e.message); process.exit(1); });
