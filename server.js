'use strict';

console.log('Starting Nest server...');

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

console.log('All modules loaded successfully');

const app = express();
const PORT = process.env.PORT || 8080;

// Database configuration
const DATABASE_URL = process.env.DATABASE_URL;
const ENABLE_DATABASE = process.env.ENABLE_DATABASE !== "0";
let pool = null;

if (ENABLE_DATABASE && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.DB_MAX_CONNECTIONS || '10'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on('error', (err) => {
    console.error('Database pool error:', err.message);
  });
}

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json());

// Session storage
const sessions = {};
const deviceStates = {};

// Environment check
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Monitoring, cleanup, runtime handling
const STALENESS_CHECK_INTERVAL = 60 * 60 * 1000;
const STALENESS_THRESHOLD = (parseInt(process.env.STALENESS_THRESHOLD_HOURS) || 12) * 60 * 60 * 1000;
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000;
const RUNTIME_TIMEOUT = (parseInt(process.env.RUNTIME_TIMEOUT_HOURS) || 4) * 60 * 60 * 1000;

// Post-run fan tail ms (default 2 min)
const POST_RUN_TAIL_MS = parseInt(process.env.POST_RUN_TAIL_MS || '120000');

/* ─────────────────────────── Utilities ─────────────────────────── */

function nowMs() { return Date.now(); }

function toTimestamp(dateStr) {
  return new Date(dateStr).getTime();
}

function celsiusToFahrenheit(celsius) {
  if (celsius == null || !Number.isFinite(celsius)) return null;
  return Math.round((celsius * 9) / 5 + 32);
}

function extractRoomDisplayName(eventData) {
  const parentRelations = eventData.resourceUpdate?.parentRelations;
  if (!parentRelations || !Array.isArray(parentRelations)) return null;
  const roomRelation = parentRelations.find(relation =>
    relation.parent && relation.parent.includes('/rooms/')
  );
  return roomRelation?.displayName || null;
}

function sanitizeForLogging(data) {
  if (!data) return data;
  const sanitized = { ...data };
  if (sanitized.userId) sanitized.userId = sanitized.userId.substring(0, 8) + '…';
  if (sanitized.deviceName) {
    const tail = sanitized.deviceName.split('/').pop() || '';
    sanitized.deviceName = 'device-' + tail.substring(0, 8) + '…';
  }
  if (sanitized.thermostatId) sanitized.thermostatId = sanitized.thermostatId.substring(0, 8) + '…';
  return sanitized;
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
      cleaned[key] = Boolean(value);
    }
  }
  return cleaned;
}

function requireAuth(req, res, next) {
  const authToken = req.headers.authorization?.replace('Bearer ', '');
  const expectedToken = process.env.ADMIN_API_KEY;
  if (!expectedToken) return res.status(500).json({ error: 'Admin API key not configured' });
  if (!authToken || authToken !== expectedToken) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Tail helper: is current time within stored fan tail
function withinFanTail(prev, eventTimeMs) {
  const until = prev?.lastFanTailUntil || 0;
  const t = eventTimeMs || nowMs();
  return until > 0 && t <= until;
}

// Map hvac/fan flags incl. synthetic tail
function deriveCurrentFlags(hvacStatus, fanTimerOn, prev, eventTimeMs) {
  const isHeating = hvacStatus === 'HEATING';
  const isCooling = hvacStatus === 'COOLING';

  let isFanOnly = Boolean(fanTimerOn) && !isHeating && !isCooling;

  // If neither heating nor cooling and fan trait absent/off, honor synthetic tail
  if (!isHeating && !isCooling && !isFanOnly && withinFanTail(prev, eventTimeMs)) {
    isFanOnly = true;
  }

  const isActive = Boolean(isHeating || isCooling || isFanOnly);

  let equipmentStatus = 'off';
  if (isHeating && isFanOnly) equipmentStatus = 'heat+fan';
  else if (isCooling && isFanOnly) equipmentStatus = 'cool+fan';
  else if (isHeating) equipmentStatus = 'heat';
  else if (isCooling) equipmentStatus = 'cool';
  else if (isFanOnly) equipmentStatus = 'fan';

  return { isHeating, isCooling, isFanOnly, isActive, equipmentStatus };
}

/* ─────────────────────────── Database ─────────────────────────── */

async function ensureDeviceExists(deviceKey) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO device_states (device_key) VALUES ($1) ON CONFLICT (device_key) DO NOTHING`,
      [deviceKey]
    );
  } catch (error) {
    console.error(`Failed to ensure device ${deviceKey} exists:`, error.message);
  }
}

async function getDeviceState(deviceKey) {
  if (!pool) return deviceStates[deviceKey] || null;

  try {
    const result = await pool.query(
      `SELECT * FROM device_states WHERE device_key = $1`,
      [deviceKey]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      isRunning: row.is_running || false,
      sessionStartedAt: row.session_started_at ? new Date(row.session_started_at).getTime() : null,
      currentMode: row.current_mode || 'idle',
      lastTemperature: row.last_temperature != null ? Number(row.last_temperature) : null,
      lastHeatSetpoint: row.last_heat_setpoint != null ? Number(row.last_heat_setpoint) : null,
      lastCoolSetpoint: row.last_cool_setpoint != null ? Number(row.last_cool_setpoint) : null,
      lastEquipmentStatus: row.last_equipment_status,
      isReachable: row.is_reachable !== false,
      lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).getTime() : Date.now(),
      lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at).getTime() : Date.now(),
      roomDisplayName: row.room_display_name,
      lastFanTailUntil: row.last_fan_tail_until ? new Date(row.last_fan_tail_until).getTime() : 0,
    };
  } catch (error) {
    console.error('Failed to get device state:', error.message);
    return deviceStates[deviceKey] || null;
  }
}

async function updateDeviceState(deviceKey, state) {
  deviceStates[deviceKey] = state;
  if (!pool) return;

  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `
      UPDATE device_states SET
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
        last_fan_tail_until = $13,
        updated_at = NOW()
      WHERE device_key = $1
      `,
      [
        deviceKey,
        Boolean(state.isRunning),
        state.sessionStartedAt ? new Date(state.sessionStartedAt) : null,
        state.currentMode || 'idle',
        state.lastTemperature,
        state.lastHeatSetpoint,
        state.lastCoolSetpoint,
        state.lastEquipmentStatus,
        state.isReachable !== false,
        state.lastSeenAt ? new Date(state.lastSeenAt) : new Date(),
        state.lastActivityAt ? new Date(state.lastActivityAt) : new Date(),
        state.roomDisplayName,
        state.lastFanTailUntil ? new Date(state.lastFanTailUntil) : null,
      ]
    );
  } catch (error) {
    console.error('Failed to update device state:', error.message);
  }
}

async function logRuntimeSession(deviceKey, sessionData) {
  if (!pool) return null;
  try {
    await ensureDeviceExists(deviceKey);
    const result = await pool.query(
      `
      INSERT INTO runtime_sessions 
        (device_key, mode, equipment_status, started_at, ended_at, duration_seconds, 
         start_temperature, end_temperature, heat_setpoint, cool_setpoint)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, session_id
      `,
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
    return result.rows[0];
  } catch (error) {
    console.error('Failed to log runtime session:', error.message);
    return null;
  }
}

async function logTemperatureReading(deviceKey, temperature, units = 'F', eventType = 'reading') {
  if (!pool) return;
  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `INSERT INTO temperature_readings (device_key, temperature, units, event_type) VALUES ($1, $2, $3, $4)`,
      [deviceKey, Number(temperature), String(units), String(eventType)]
    );
  } catch (error) {
    console.error('Failed to log temperature reading:', error.message);
  }
}

async function logEquipmentEvent(deviceKey, eventType, equipmentStatus, previousStatus, isActive, eventData = {}) {
  if (!pool) return;
  try {
    await ensureDeviceExists(deviceKey);
    await pool.query(
      `
      INSERT INTO equipment_events 
        (device_key, event_type, equipment_status, previous_status, is_active, event_data)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [deviceKey, eventType, equipmentStatus, previousStatus, Boolean(isActive), JSON.stringify(eventData)]
    );
  } catch (error) {
    console.error('Failed to log equipment event:', error.message);
  }
}

/* ─────────────────────── Migration / Schema ─────────────────────── */

async function runDatabaseMigration() {
  if (!ENABLE_DATABASE || !pool) {
    console.log('Database disabled - skipping migration');
    return;
  }

  try {
    console.log('Checking database schema...');

    const schemaExists = await pool.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_name = 'device_states' AND table_schema = 'public'
    `);

    if (parseInt(schemaExists.rows[0].count) > 0) {
      // Add columns if missing
      const addColIfMissing = async (table, column, type) => {
        const r = await pool.query(`
          SELECT COUNT(*) as count
          FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2 AND table_schema = 'public'
        `, [table, column]);
        if (parseInt(r.rows[0].count) === 0) {
          console.log(`Adding ${column} to ${table}...`);
          await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
          console.log(`Added ${column}`);
        }
      };

      await addColIfMissing('device_states', 'room_display_name', 'VARCHAR(200)');
      await addColIfMissing('device_states', 'last_fan_tail_until', 'TIMESTAMPTZ');

      console.log('Database schema already exists - ensured new columns');
      return;
    }

    // Fresh create
    console.log('Creating database schema with proper field sizes...');
    console.log('- device_key: VARCHAR(300)');
    console.log('- device_name: VARCHAR(600)');
    console.log('- room_display_name: VARCHAR(200)');

    const migrationSQL = `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS device_states (
          device_key VARCHAR(300) PRIMARY KEY,
          frontend_id VARCHAR(300),
          mac_id VARCHAR(300),
          device_name VARCHAR(600),
          room_display_name VARCHAR(200),
          units CHAR(1) DEFAULT 'F' CHECK (units IN ('F', 'C')),
          location_id VARCHAR(300),
          workspace_id VARCHAR(300),
          
          is_running BOOLEAN DEFAULT FALSE,
          session_started_at TIMESTAMPTZ,
          current_mode VARCHAR(20) DEFAULT 'idle',
          current_equipment_status VARCHAR(50),
          
          last_temperature DECIMAL(5,2),
          last_heat_setpoint DECIMAL(5,2),
          last_cool_setpoint DECIMAL(5,2),
          last_fan_status VARCHAR(10),
          last_equipment_status VARCHAR(50),

          last_fan_tail_until TIMESTAMPTZ,
          
          last_mode VARCHAR(20),
          last_was_cooling BOOLEAN DEFAULT FALSE,
          last_was_heating BOOLEAN DEFAULT FALSE,
          last_was_fan_only BOOLEAN DEFAULT FALSE,
          
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
      BEGIN
          NEW.updated_at = NOW();
          RETURN NEW;
      END;
      $$ language 'plpgsql';

      DO $$
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_device_states_updated_at') THEN
              CREATE TRIGGER update_device_states_updated_at 
                  BEFORE UPDATE ON device_states 
                  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
          END IF;
          
          IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_runtime_sessions_updated_at') THEN
              CREATE TRIGGER update_runtime_sessions_updated_at 
                  BEFORE UPDATE ON runtime_sessions 
                  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
          END IF;
      END
      $$;
    `;

    await pool.query(migrationSQL);
    console.log('Database schema created successfully');
  } catch (error) {
    console.error('Database migration failed:', error.message);
    console.warn('Continuing with memory-only operation...');
  }
}

/* ─────────────────────── Notifications ─────────────────────── */

async function sendStalenessNotification(deviceKey, deviceState, currentTime) {
  const deviceId = deviceKey.split('-').pop();
  const lastActivityTime = deviceState.lastActivityAt || 0;
  const hoursSinceLastActivity = lastActivityTime > 0 ?
    Math.floor((currentTime - lastActivityTime) / (60 * 60 * 1000)) : 0;

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

    currentTempF: deviceState.lastTemperature ? celsiusToFahrenheit(deviceState.lastTemperature) : 0,
    coolSetpointF: 0,
    heatSetpointF: 0,
    startTempF: 0,
    endTempF: deviceState.lastTemperature ? celsiusToFahrenheit(deviceState.lastTemperature) : 0,
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

    hoursSinceLastActivity: hoursSinceLastActivity,
    lastActivityTime: lastActivityTime > 0 ? new Date(lastActivityTime).toISOString() : '',
    stalenessReason: hoursSinceLastActivity >= 24 ? 'extended_offline' : 'device_offline',

    timestamp: new Date(currentTime).toISOString(),
    eventId: `stale-${Date.now()}`,
    eventTimestamp: currentTime
  };

  if (process.env.BUBBLE_WEBHOOK_URL) {
    try {
      const cleanedPayload = cleanPayloadForBubble(payload);
      await axios.post(process.env.BUBBLE_WEBHOOK_URL, cleanedPayload, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Nest-Runtime-Tracker/1.2',
          'Content-Type': 'application/json'
        }
      });

      console.log('Sent staleness notification to Bubble:', sanitizeForLogging({
        deviceId: payload.thermostatId,
        roomDisplayName: payload.roomDisplayName,
        currentTempF: payload.currentTempF,
        isReachable: payload.isReachable,
        hoursSinceLastActivity: payload.hoursSinceLastActivity,
        lastActivity: payload.lastActivityTime
      }));
    } catch (err) {
      console.error('Failed to send staleness notification to Bubble:', err.response?.status || err.code || err.message);
    }
  }
}

/* ─────────────────────── Event Handling ─────────────────────── */

async function handleNestEvent(eventData) {
  console.log('DEBUG: Starting event processing');
  if (!IS_PRODUCTION) console.log('Processing Nest event…');

  const userId = eventData.userId;
  const deviceName = eventData.resourceUpdate?.name;
  const traits = eventData.resourceUpdate?.traits;
  const timestamp = eventData.timestamp;

  const roomDisplayName = extractRoomDisplayName(eventData);

  console.log('DEBUG - Basic field extraction:');
  console.log(`- userId: ${userId}`);
  console.log(`- deviceName: ${deviceName}`);
  console.log(`- timestamp: ${timestamp}`);
  console.log(`- roomDisplayName: ${roomDisplayName}`);

  const deviceId = deviceName?.split('/').pop();

  // Primary traits
  const hvacStatusRaw = traits?.['sdm.devices.traits.ThermostatHvac']?.status;
  const currentTemp = traits?.['sdm.devices.traits.Temperature']?.ambientTemperatureCelsius;
  const coolSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.coolCelsius;
  const heatSetpoint = traits?.['sdm.devices.traits.ThermostatTemperatureSetpoint']?.heatCelsius;
  const mode = traits?.['sdm.devices.traits.ThermostatMode']?.mode;

  // Fan trait
  const hasFanTrait = Object.prototype.hasOwnProperty.call(traits || {}, 'sdm.devices.traits.Fan');
  const fanTimerMode = traits?.['sdm.devices.traits.Fan']?.timerMode;
  const fanTimerOn = fanTimerMode === 'ON';

  // Connectivity trait
  const connectivityStatus = traits?.['sdm.devices.traits.Connectivity']?.status;
  const key = `${userId}-${deviceId}`;

  const prev = await getDeviceState(key) || {};

  const isReachable = (connectivityStatus === 'OFFLINE')
    ? false
    : (connectivityStatus === 'ONLINE')
      ? true
      : (prev.isReachable ?? true);

  console.log('DEBUG - Extracted trait values:');
  console.log(`- hvacStatusRaw: ${hvacStatusRaw}`);
  console.log(`- currentTemp: ${currentTemp}`);
  console.log(`- coolSetpoint: ${coolSetpoint}`);
  console.log(`- heatSetpoint: ${heatSetpoint}`);
  console.log(`- mode: ${mode}`);
  console.log(`- hasFanTrait: ${hasFanTrait}, fanTimerMode: ${fanTimerMode} (fanTimerOn: ${fanTimerOn})`);
  console.log(`- connectivityStatus: ${connectivityStatus} -> isReachable=${isReachable}`);

  // Basic validation
  if (!userId || !deviceId || !timestamp) {
    console.warn('Skipping incomplete Nest event');
    return;
  }

  const eventTime = toTimestamp(timestamp);

  const lastIsCooling = !!prev.lastEquipmentStatus?.includes('cool');
  const lastIsHeating = !!prev.lastEquipmentStatus?.includes('heat');
  const lastIsFanOnly = !!prev.lastEquipmentStatus?.includes('fan');
  const lastEquipmentStatus = prev.lastEquipmentStatus || 'unknown';

  // Resolve hvac status effective (do NOT infer from previous state)
  let hvacStatusEff = hvacStatusRaw ?? null;

  // If ThermostatHvac trait is absent, check if Mode explicitly says OFF
  const explicitMode = traits?.['sdm.devices.traits.ThermostatMode']?.mode;
  if (!hvacStatusEff && explicitMode === 'OFF') {
    hvacStatusEff = 'OFF';
  }

  // If still unknown, treat as UNKNOWN (idle unless fan/tail says otherwise)
  if (!hvacStatusEff) hvacStatusEff = 'UNKNOWN';

  console.log(`DEBUG - HVAC Status Resolution: hvacStatusRaw="${hvacStatusRaw}", prev.currentMode="${prev.currentMode}", hvacStatusEff="${hvacStatusEff}"`);

  // Effective temps/setpoints
  const effectiveCurrentTemp = currentTemp ?? prev.lastTemperature ?? 20;
  const effectiveCoolSetpoint = coolSetpoint ?? prev.lastCoolSetpoint ?? 22;
  const effectiveHeatSetpoint = heatSetpoint ?? prev.lastHeatSetpoint ?? 18;

  // Classification
  const isTemperatureOnlyEvent = !hvacStatusRaw && currentTemp != null;
  const isConnectivityOnly = !!connectivityStatus && !hvacStatusRaw && currentTemp == null;

  console.log(`DEBUG - Event Classification: isTemperatureOnlyEvent=${isTemperatureOnlyEvent}, isConnectivityOnly=${isConnectivityOnly}`);

  // Skip events with no useful signal at all
  const noUsefulSignal =
    !hvacStatusRaw &&
    currentTemp == null &&
    coolSetpoint == null &&
    heatSetpoint == null &&
    !connectivityStatus &&
    !hasFanTrait;

  if (noUsefulSignal) {
    console.log('No-op Nest event (no HVAC/temperature/connectivity/fan changes). Skipping.');
    return;
  }

  /* ───────────── Temperature-only event ───────────── */
  if (isTemperatureOnlyEvent) {
    console.log('Temperature-only event detected');

    await logTemperatureReading(key, celsiusToFahrenheit(currentTemp), 'F', 'ThermostatIndoorTemperatureEvent');

    // Only live session or tail can mark it active (avoid stale prev.isRunning)
    const isCurrentlyRunning = Boolean(sessions[key]) || withinFanTail(prev, eventTime);

    let effectiveHvacMode = 'OFF';
    if (isCurrentlyRunning) {
      if (withinFanTail(prev, eventTime)) {
        effectiveHvacMode = 'FAN_ONLY';
      } else if (prev.currentMode === 'cool' || prev.currentMode === 'cool+fan') {
        effectiveHvacMode = 'COOLING';
      } else if (prev.currentMode === 'heat' || prev.currentMode === 'heat+fan') {
        effectiveHvacMode = 'HEATING';
      } else if (prev.currentMode === 'fan') {
        effectiveHvacMode = 'FAN_ONLY';
      }
    }

    const currentEquipmentStatus = isCurrentlyRunning
      ? (withinFanTail(prev, eventTime) ? 'fan' : (prev.currentMode || 'unknown'))
      : 'off';

    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      roomDisplayName: roomDisplayName || '',
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: effectiveHvacMode,
      isHvacActive: Boolean(isCurrentlyRunning),
      thermostatMode: mode || prev.currentMode || 'OFF',
      isReachable,

      currentTempF: celsiusToFahrenheit(effectiveCurrentTemp),
      coolSetpointF: celsiusToFahrenheit(effectiveCoolSetpoint),
      heatSetpointF: celsiusToFahrenheit(effectiveHeatSetpoint),
      startTempF: 0,
      endTempF: celsiusToFahrenheit(effectiveCurrentTemp),
      currentTempC: effectiveCurrentTemp,
      coolSetpointC: effectiveCoolSetpoint,
      heatSetpointC: effectiveHeatSetpoint,
      startTempC: 0,
      endTempC: effectiveCurrentTemp,

      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,
      equipmentStatus: currentEquipmentStatus,
      isFanOnly: Boolean(currentEquipmentStatus === 'fan'),

      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };

    if (process.env.BUBBLE_WEBHOOK_URL) {
      try {
        const cleanedPayload = cleanPayloadForBubble(payload);
        console.log('DEBUG - Sending temperature update payload to Bubble:');
        console.log(JSON.stringify(cleanedPayload, null, 2));

        await axios.post(process.env.BUBBLE_WEBHOOK_URL, cleanedPayload, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Nest-Runtime-Tracker/1.2',
            'Content-Type': 'application/json'
          }
        });
        console.log('Sent temperature update to Bubble:', sanitizeForLogging({
          runtimeSeconds: payload.runtimeSeconds,
          isRuntimeEvent: payload.isRuntimeEvent,
          hvacMode: payload.hvacMode,
          isHvacActive: payload.isHvacActive,
          currentTempF: payload.currentTempF,
          isReachable: payload.isReachable,
          equipmentStatus: payload.equipmentStatus,
          roomDisplayName: payload.roomDisplayName
        }));
      } catch (err) {
        console.error('Failed to send temperature update to Bubble:', err.response?.status || err.code || err.message);
        if (err.response?.data) console.error('Bubble error response:', err.response.data);
      }
    }

    await updateDeviceState(key, {
      ...prev,
      lastTemperature: currentTemp,
      lastSeenAt: eventTime,
      lastActivityAt: eventTime,
      isReachable,
      roomDisplayName: roomDisplayName || prev.roomDisplayName,
      lastFanTailUntil: withinFanTail(prev, eventTime) ? prev.lastFanTailUntil : 0,
    });

    console.log('DEBUG: Temperature-only event processing complete');
    return;
  }

  /* ───────────── Connectivity-only event ───────────── */
  if (isConnectivityOnly) {
    console.log('Connectivity-only event detected');

    const payload = {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      roomDisplayName: roomDisplayName || '',
      runtimeSeconds: 0,
      runtimeMinutes: 0,
      isRuntimeEvent: false,
      hvacMode: hvacStatusEff,
      isHvacActive: Boolean(hvacStatusEff === 'HEATING' || hvacStatusEff === 'COOLING' || prev.currentMode === 'fan' || withinFanTail(prev, eventTime)),
      thermostatMode: prev.currentMode || mode || 'OFF',
      isReachable,

      currentTempF: celsiusToFahrenheit(prev.lastTemperature) || 0,
      coolSetpointF: celsiusToFahrenheit(effectiveCoolSetpoint),
      heatSetpointF: celsiusToFahrenheit(effectiveHeatSetpoint),
      startTempF: 0,
      endTempF: celsiusToFahrenheit(prev.lastTemperature) || 0,
      currentTempC: prev.lastTemperature || 0,
      coolSetpointC: effectiveCoolSetpoint,
      heatSetpointC: effectiveHeatSetpoint,
      startTempC: 0,
      endTempC: prev.lastTemperature || 0,

      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,
      equipmentStatus: prev.lastEquipmentStatus || 'off',
      isFanOnly: Boolean(prev.lastEquipmentStatus === 'fan' || withinFanTail(prev, eventTime)),

      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };

    if (process.env.BUBBLE_WEBHOOK_URL) {
      try {
        const cleanedPayload = cleanPayloadForBubble(payload);
        console.log('DEBUG - Sending connectivity update payload to Bubble:');
        console.log(JSON.stringify(cleanedPayload, null, 2));

        await axios.post(process.env.BUBBLE_WEBHOOK_URL, cleanedPayload, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Nest-Runtime-Tracker/1.2',
            'Content-Type': 'application/json'
          }
        });
        console.log('Sent connectivity update to Bubble:', sanitizeForLogging({
          isReachable: payload.isReachable,
          roomDisplayName: payload.roomDisplayName
        }));
      } catch (err) {
        console.error('Failed to send connectivity update to Bubble:', err.response?.status || err.code || err.message);
        if (err.response?.data) console.error('Bubble error response:', err.response.data);
      }
    }

    await updateDeviceState(key, {
      ...prev,
      isReachable,
      lastSeenAt: eventTime,
      lastActivityAt: eventTime,
      roomDisplayName: roomDisplayName || prev.roomDisplayName,
      lastFanTailUntil: withinFanTail(prev, eventTime) ? prev.lastFanTailUntil : 0,
    });

    console.log('DEBUG: Connectivity-only event processing complete');
    return;
  }

  console.log('DEBUG: Validation passed, proceeding with full HVAC event processing');

  // Flags (tail-aware)
  const { isHeating, isCooling, isFanOnly, isActive, equipmentStatus } =
    deriveCurrentFlags(hvacStatusEff, fanTimerOn, prev, eventTime);

  const wasActive = Boolean(prev.isRunning);

  console.log(`DEBUG - State Analysis: isActive=${isActive} (heating:${isHeating}, cooling:${isCooling}, fanOnly:${isFanOnly}), wasActive=${wasActive}, equipmentStatus="${equipmentStatus}", prev.isRunning=${prev.isRunning}`);
  console.log(`DEBUG - Session Check: sessions[key]=${!!sessions[key]}, sessionStartTime=${sessions[key]?.startTime}`);

  // Log equipment status change
  if (equipmentStatus !== prev.lastEquipmentStatus) {
    await logEquipmentEvent(
      key,
      'EquipmentStateChanged',
      equipmentStatus,
      prev.lastEquipmentStatus,
      Boolean(isActive),
      {
        temperature: currentTemp,
        fanTimerOn: Boolean(fanTimerOn),
        isHeating: Boolean(isHeating),
        isCooling: Boolean(isCooling),
        isFanOnly: Boolean(isFanOnly),
        timestamp: eventTime
      }
    );
  }

  // Tail arming logic (tolerate UNKNOWN when no fan & no tail)
  const hvacWentToOff = (hvacStatusEff === 'OFF') ||
    (hvacStatusEff === 'UNKNOWN' && !fanTimerOn && !withinFanTail(prev, eventTime));

  const prevWasHeatOrCool = ['heat','heat+fan','cool','cool+fan'].includes(prev.currentMode);
  let nextLastFanTailUntil = prev.lastFanTailUntil || 0;

  if (hvacWentToOff && prevWasHeatOrCool && !withinFanTail(prev, eventTime)) {
    nextLastFanTailUntil = Math.max(nextLastFanTailUntil, eventTime + POST_RUN_TAIL_MS);
  }
  // If Fan trait explicitly present and OFF, kill any tail immediately
  if (hvacWentToOff && hasFanTrait && !fanTimerOn) {
    nextLastFanTailUntil = 0;
  }

  function createBubblePayload(runtimeSeconds = 0, isRuntimeEvent = false, sessionData = null) {
    return {
      userId,
      thermostatId: deviceId,
      deviceName: deviceName,
      roomDisplayName: roomDisplayName || '',
      runtimeSeconds,
      runtimeMinutes: Math.round(runtimeSeconds / 60),
      isRuntimeEvent,
      hvacMode: hvacStatusEff,
      isHvacActive: Boolean(isActive),
      thermostatMode: mode || 'OFF',
      isReachable,

      currentTempF: celsiusToFahrenheit(effectiveCurrentTemp),
      coolSetpointF: celsiusToFahrenheit(effectiveCoolSetpoint),
      heatSetpointF: celsiusToFahrenheit(effectiveHeatSetpoint),
      startTempF: sessionData?.startTemperature ? celsiusToFahrenheit(sessionData.startTemperature) : 0,
      endTempF: celsiusToFahrenheit(effectiveCurrentTemp),
      currentTempC: effectiveCurrentTemp,
      coolSetpointC: effectiveCoolSetpoint,
      heatSetpointC: effectiveHeatSetpoint,
      startTempC: sessionData?.startTemperature || 0,
      endTempC: effectiveCurrentTemp,

      lastIsCooling,
      lastIsHeating,
      lastIsFanOnly,
      lastEquipmentStatus,

      equipmentStatus,
      isFanOnly: Boolean(isFanOnly),

      timestamp,
      eventId: eventData.eventId,
      eventTimestamp: eventTime
    };
  }

  let payload;

  // Runtime calc (incl. fan-only)
  if (isActive && !wasActive) {
    console.log(`🟢 HVAC/Fan turning ON: ${equipmentStatus} for ${key.substring(0, 16)}`);
    if (sessions[key] || prev.isRunning) {
      console.warn('Warning: Starting new session while previous session still active - closing previous session');
      if (sessions[key]?.startTime) {
        const prevRuntimeSeconds = Math.floor((eventTime - sessions[key].startTime) / 1000);
        if (prevRuntimeSeconds > 0 && prevRuntimeSeconds < 24 * 3600) {
          await logRuntimeSession(key, {
            mode: sessions[key].startStatus || 'unknown',
            equipmentStatus: 'interrupted',
            startedAt: sessions[key].startTime,
            endedAt: eventTime,
            durationSeconds: prevRuntimeSeconds,
            startTemperature: sessions[key].startTemperature,
            endTemperature: effectiveCurrentTemp,
            heatSetpoint: effectiveHeatSetpoint,
            coolSetpoint: effectiveCoolSetpoint
          });
        }
      }
    }
    const sessionData = {
      startTime: eventTime,
      startStatus: equipmentStatus,
      startTemperature: effectiveCurrentTemp
    };
    sessions[key] = sessionData;
    payload = createBubblePayload(0, false);
    console.log(`✅ Started ${equipmentStatus} session at ${new Date(eventTime).toLocaleTimeString()}`);

  } else if (!isActive && wasActive && !withinFanTail(prev, eventTime)) {
    // Only end the session if NOT in a synthetic tail
    console.log(`🔴 HVAC/Fan turning OFF for ${key.substring(0, 16)}`);

    let session = sessions[key];
    if (!session && prev.sessionStartedAt) {
      session = {
        startTime: prev.sessionStartedAt,
        startStatus: prev.currentMode || 'unknown',
        startTemperature: prev.lastTemperature || effectiveCurrentTemp
      };
      console.log('Using database session data for runtime calculation');
    }

    if (session?.startTime) {
      const runtimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
      const runtimeMinutes = Math.round(runtimeSeconds / 60);
      console.log(`⏱️  Runtime calculation: ${runtimeSeconds}s (${runtimeMinutes}m) from ${new Date(session.startTime).toLocaleTimeString()} to ${new Date(eventTime).toLocaleTimeString()}`);

      if (runtimeSeconds > 0 && runtimeSeconds < 24 * 3600) {
        await logRuntimeSession(key, {
          mode: session.startStatus,
          equipmentStatus: equipmentStatus,
          startedAt: session.startTime,
          endedAt: eventTime,
          durationSeconds: runtimeSeconds,
          startTemperature: session.startTemperature,
          endTemperature: effectiveCurrentTemp,
          heatSetpoint: effectiveHeatSetpoint,
          coolSetpoint: effectiveCoolSetpoint
        });
        payload = createBubblePayload(runtimeSeconds, true, session);
        console.log(`✅ Ended session: ${runtimeSeconds}s runtime (${session.startStatus})`);
      } else {
        console.warn(`❌ Invalid runtime ${runtimeSeconds}s (${runtimeMinutes}m), sending zero runtime`);
        payload = createBubblePayload(0, false);
      }
    } else {
      console.warn('❌ No session data found for runtime calculation');
      payload = createBubblePayload(0, false);
    }
    delete sessions[key];

  } else if (isActive && !sessions[key] && !prev.isRunning) {
    console.log(`🟡 HVAC/Fan is active but no session tracked for ${key.substring(0, 16)} - starting recovery session`);
    const sessionData = {
      startTime: eventTime,
      startStatus: equipmentStatus,
      startTemperature: effectiveCurrentTemp
    };
    sessions[key] = sessionData;
    payload = createBubblePayload(0, false);
    console.log(`✅ Recovery session started for ${equipmentStatus}`);

  } else if (isActive && sessions[key]) {
    const session = sessions[key];
    const currentRuntimeSeconds = Math.floor((eventTime - session.startTime) / 1000);
    const runtimeMinutes = Math.round(currentRuntimeSeconds / 60);
    const lastUpdate = prev.lastActivityAt || 0;
    const timeSinceLastUpdate = eventTime - lastUpdate;
    const shouldSendRuntimeUpdate = timeSinceLastUpdate > (10 * 60 * 1000);
    if (shouldSendRuntimeUpdate && currentRuntimeSeconds > 60) {
      console.log(`🔄 Runtime update: ${currentRuntimeSeconds}s (${runtimeMinutes}m) - ${equipmentStatus}`);
      payload = createBubblePayload(currentRuntimeSeconds, false, session);
    } else {
      payload = createBubblePayload(0, false);
    }

  } else {
    payload = createBubblePayload(0, false);
    if (effectiveCurrentTemp && !IS_PRODUCTION) {
      console.log(`🌡️  State update: ${effectiveCurrentTemp}°C (${celsiusToFahrenheit(effectiveCurrentTemp)}°F)`);
    }
  }

  // Persist tail correctly: if we set a newer tail, use it; if current time beyond tail, clear it
  const carryTail =
    nextLastFanTailUntil && nextLastFanTailUntil > eventTime
      ? nextLastFanTailUntil
      : (withinFanTail(prev, eventTime) ? prev.lastFanTailUntil : 0);

  const newState = {
    ...prev,
    isRunning: Boolean(isActive),
    sessionStartedAt: isActive ? (sessions[key]?.startTime || prev.sessionStartedAt) : null,
    currentMode: equipmentStatus,
    lastTemperature: currentTemp ?? prev.lastTemperature,
    lastHeatSetpoint: heatSetpoint !== undefined ? heatSetpoint : prev.lastHeatSetpoint,
    lastCoolSetpoint: coolSetpoint !== undefined ? coolSetpoint : prev.lastCoolSetpoint,
    lastEquipmentStatus: equipmentStatus,
    isReachable,
    lastSeenAt: eventTime,
    lastActivityAt: eventTime,
    roomDisplayName: roomDisplayName || prev.roomDisplayName,
    lastFanTailUntil: carryTail,
  };

  await updateDeviceState(key, newState);

  if (process.env.BUBBLE_WEBHOOK_URL) {
    try {
      const cleanedPayload = cleanPayloadForBubble(payload);
      console.log('DEBUG - Sending full HVAC payload to Bubble:');
      console.log(JSON.stringify(cleanedPayload, null, 2));

      await axios.post(process.env.BUBBLE_WEBHOOK_URL, cleanedPayload, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Nest-Runtime-Tracker/1.2',
          'Content-Type': 'application/json'
        }
      });

      const logData = sanitizeForLogging({
        runtimeSeconds: payload.runtimeSeconds,
        isRuntimeEvent: payload.isRuntimeEvent,
        hvacMode: payload.hvacMode,
        isHvacActive: payload.isHvacActive,
        currentTempF: payload.currentTempF,
        isReachable: payload.isReachable,
        roomDisplayName: payload.roomDisplayName,
        equipmentStatus: payload.equipmentStatus
      });
      console.log('Sent to Bubble:', logData);
    } catch (err) {
      console.error('Failed to send to Bubble:', err.response?.status || err.code || err.message);
      if (err.response?.data) console.error('Bubble error response:', err.response.data);
      const retryDelay = 5000;
      setTimeout(async () => {
        try {
          const cleanedPayload = cleanPayloadForBubble(payload);
          await axios.post(process.env.BUBBLE_WEBHOOK_URL, cleanedPayload, {
            timeout: 10000,
            headers: {
              'User-Agent': 'Nest-Runtime-Tracker/1.2',
              'Content-Type': 'application/json'
            }
          });
          console.log('Retry successful');
        } catch (retryErr) {
          console.error('Retry failed:', retryErr.response?.status || retryErr.code || retryErr.message);
        }
      }, retryDelay);
    }
  } else if (!IS_PRODUCTION) {
    const logData = sanitizeForLogging({
      runtimeSeconds: payload.runtimeSeconds,
      isRuntimeEvent: payload.isRuntimeEvent,
      hvacMode: payload.hvacMode,
      isHvacActive: payload.isHvacActive,
      currentTempF: payload.currentTempF,
      isReachable: payload.isReachable,
      roomDisplayName: payload.roomDisplayName,
      equipmentStatus: payload.equipmentStatus
    });
    console.log('Would send to Bubble (no URL configured):', logData);
  }

  console.log('DEBUG: Event processing complete');
}

/* ─────────────────────── Staleness Monitor ─────────────────────── */

setInterval(async () => {
  const now = Date.now();
  const staleThreshold = now - STALENESS_THRESHOLD;

  console.log('Checking for stale devices...');

  // Memory states
  for (const [key, state] of Object.entries(deviceStates)) {
    const lastActivity = state.lastActivityAt || 0;
    const lastStalenessNotification = state.lastStalenessNotification || 0;

    if (lastActivity > 0 && lastActivity < staleThreshold) {
      const timeSinceLastNotification = now - lastStalenessNotification;
      if (lastStalenessNotification === 0 || timeSinceLastNotification >= STALENESS_THRESHOLD) {
        const hoursSinceLastActivity = Math.floor((now - lastActivity) / (60 * 60 * 1000));
        console.log(`Device ${key} is stale (${hoursSinceLastActivity} hours since last activity), sending staleness notification`);

        await sendStalenessNotification(key, state, now);

        state.lastStalenessNotification = now;
        deviceStates[key] = state;
      }
    } else if (lastActivity >= staleThreshold && state.lastStalenessNotification) {
      delete state.lastStalenessNotification;
      deviceStates[key] = state;
    }
  }

  // DB states
  if (pool) {
    try {
      const staleDevices = await pool.query(`
        SELECT device_key, last_activity_at, last_temperature, last_equipment_status, 
               is_reachable, last_staleness_notification, room_display_name
        FROM device_states 
        WHERE last_activity_at < $1 
          AND last_activity_at > $2
      `, [new Date(staleThreshold), new Date(now - (7 * 24 * 60 * 60 * 1000))]);

      for (const device of staleDevices.rows) {
        const lastStalenessNotification = device.last_staleness_notification ?
          new Date(device.last_staleness_notification).getTime() : 0;
        const timeSinceLastNotification = now - lastStalenessNotification;

        if (lastStalenessNotification === 0 || timeSinceLastNotification >= STALENESS_THRESHOLD) {
          const hoursSinceLastActivity = Math.floor((now - new Date(device.last_activity_at).getTime()) / (60 * 60 * 1000));
          console.log(`Database device ${device.device_key} is stale (${hoursSinceLastActivity} hours), sending staleness notification`);

          await sendStalenessNotification(device.device_key, {
            lastTemperature: device.last_temperature,
            lastEquipmentStatus: device.last_equipment_status,
            lastActivityAt: new Date(device.last_activity_at).getTime(),
            roomDisplayName: device.room_display_name
          }, now);

          try {
            await pool.query(`
              UPDATE device_states 
              SET last_staleness_notification = NOW() 
              WHERE device_key = $1
            `, [device.device_key]);
          } catch (updateError) {
            console.error('Failed to update staleness notification time:', updateError.message);
          }
        }
      }
    } catch (error) {
      console.error('Error checking database for stale devices:', error.message);
    }
  }
}, STALENESS_CHECK_INTERVAL);

/* ─────────────────────── Dead-man Timeout ─────────────────────── */
// Force-close sessions if we haven't seen activity for RUNTIME_TIMEOUT
setInterval(async () => {
  const now = Date.now();
  for (const [key, session] of Object.entries(sessions)) {
    try {
      const prev = await getDeviceState(key) || {};
      const last = prev.lastActivityAt || session.startTime || now;
      if (now - last > RUNTIME_TIMEOUT) {
        const runtimeSeconds = Math.max(0, Math.floor((last - session.startTime) / 1000));
        if (runtimeSeconds > 0 && runtimeSeconds < 24 * 3600) {
          await logRuntimeSession(key, {
            mode: session.startStatus || 'unknown',
            equipmentStatus: 'timeout',
            startedAt: session.startTime,
            endedAt: last,
            durationSeconds: runtimeSeconds,
            startTemperature: session.startTemperature,
            endTemperature: prev.lastTemperature,
            heatSetpoint: prev.lastHeatSetpoint,
            coolSetpoint: prev.lastCoolSetpoint
          });

          if (process.env.BUBBLE_WEBHOOK_URL) {
            const [userId, deviceId] = key.split('-');
            const payload = cleanPayloadForBubble({
              userId,
              thermostatId: deviceId,
              deviceName: prev.device_name || '',
              roomDisplayName: prev.roomDisplayName || '',
              runtimeSeconds,
              runtimeMinutes: Math.round(runtimeSeconds / 60),
              isRuntimeEvent: true,
              hvacMode: 'UNKNOWN',
              isHvacActive: false,
              thermostatMode: 'UNKNOWN',
              isReachable: prev.isReachable !== false,

              currentTempF: celsiusToFahrenheit(prev.lastTemperature),
              coolSetpointF: celsiusToFahrenheit(prev.lastCoolSetpoint),
              heatSetpointF: celsiusToFahrenheit(prev.lastHeatSetpoint),
              startTempF: celsiusToFahrenheit(session.startTemperature),
              endTempF: celsiusToFahrenheit(prev.lastTemperature),

              currentTempC: prev.lastTemperature,
              coolSetpointC: prev.lastCoolSetpoint,
              heatSetpointC: prev.lastHeatSetpoint,
              startTempC: session.startTemperature,
              endTempC: prev.lastTemperature,

              lastIsCooling: !!prev.lastEquipmentStatus?.includes('cool'),
              lastIsHeating: !!prev.lastEquipmentStatus?.includes('heat'),
              lastIsFanOnly: !!prev.lastEquipmentStatus?.includes('fan'),
              lastEquipmentStatus: prev.lastEquipmentStatus || 'unknown',
              equipmentStatus: 'timeout',
              isFanOnly: false,

              timestamp: new Date(now).toISOString(),
              eventId: `timeout-${now}`,
              eventTimestamp: now
            });

            try {
              await axios.post(process.env.BUBBLE_WEBHOOK_URL, payload, {
                timeout: 10000,
                headers: {
                  'User-Agent': 'Nest-Runtime-Tracker/1.2',
                  'Content-Type': 'application/json'
                }
              });
              console.log(`Posted timeout payload for ${key.substring(0,16)}`);
            } catch (e) {
              console.error('Bubble timeout post failed:', e.response?.status || e.code || e.message);
            }
          }
        }

        delete sessions[key];
        await updateDeviceState(key, { ...prev, isRunning: false, sessionStartedAt: null });
        console.log(`⏹️  Session force-closed by timeout for ${key.substring(0,16)}`);
      }
    } catch (err) {
      console.error('Dead-man timeout error:', err.message);
    }
  }
}, 5 * 60 * 1000); // check every 5 minutes

/* ─────────────────────── Startup / Routes ─────────────────────── */

async function initializeDatabase() {
  if (!ENABLE_DATABASE || !pool) {
    console.log('Database disabled - using memory-only state');
    return;
  }
  try {
    const result = await pool.query('SELECT NOW() as now');
    console.log('Database connection established:', result.rows[0].now);
    await runDatabaseMigration();
    const stateResult = await pool.query('SELECT device_key FROM device_states');
    console.log(`Loaded ${stateResult.rows.length} existing device states from database`);
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    console.warn('Falling back to memory-only state management');
  }
}

// Admin endpoints
app.get('/admin/health', requireAuth, async (req, res) => {
  let dbStatus = 'disabled';
  let dbInfo = {};

  if (pool) {
    try {
      const dbResult = await pool.query(`
        SELECT 
          COUNT(*) as device_count,
          COUNT(CASE WHEN is_running = true THEN 1 END) as running_sessions,
          COUNT(CASE WHEN is_reachable = false THEN 1 END) as unreachable_devices
        FROM device_states
      `);

      const sessionResult = await pool.query(`
        SELECT COUNT(*) as total_sessions
        FROM runtime_sessions 
        WHERE started_at > NOW() - INTERVAL '24 hours'
      `);

      dbStatus = 'connected';
      dbInfo = {
        devices: parseInt(dbResult.rows[0].device_count),
        runningSessions: parseInt(dbResult.rows[0].running_sessions),
        unreachableDevices: parseInt(dbResult.rows[0].unreachable_devices),
        sessionsLast24h: parseInt(sessionResult.rows[0].total_sessions)
      };
    } catch (error) {
      dbStatus = 'error';
      dbInfo = { error: error.message };
    }
  }

  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memorySessions: Object.keys(sessions).length,
    memoryStates: Object.keys(deviceStates).length,
    database: {
      status: dbStatus,
      ...dbInfo
    },
    config: {
      stalenessThresholdHours: STALENESS_THRESHOLD / (60 * 60 * 1000),
      runtimeTimeoutHours: RUNTIME_TIMEOUT / (60 * 60 * 1000),
      postRunTailMs: POST_RUN_TAIL_MS,
      databaseEnabled: ENABLE_DATABASE,
      bubbleConfigured: !!process.env.BUBBLE_WEBHOOK_URL
    },
    memoryUsage: process.memoryUsage()
  });
});

// Health check
app.get('/health', async (req, res) => {
  let dbStatus = 'disabled';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      dbStatus = 'connected';
    } catch (error) {
      dbStatus = 'error';
    }
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

app.get('/', (req, res) => {
  res.send('Nest Runtime Webhook server is running!');
});

app.post('/webhook', async (req, res) => {
  try {
    const pubsubMessage = req.body.message;
    if (!pubsubMessage || !pubsubMessage.data) {
      console.error('Invalid Pub/Sub message structure');
      return res.status(400).send('Invalid Pub/Sub message');
    }
    let eventData;
    try {
      eventData = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
    } catch (decodeError) {
      console.error('Failed to decode Pub/Sub message:', decodeError.message);
      return res.status(400).send('Invalid message format');
    }

    console.log('Processing Nest event:', eventData.eventId || 'unknown-event');
    await handleNestEvent(eventData);
    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(500).send('Internal Server Error');
  }
});

// Not found / errors
app.use('*', (req, res) => {
  res.status(404).send('Not Found');
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error.message);
  res.status(500).send('Internal Server Error');
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  if (pool) await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  if (pool) await pool.end();
  process.exit(0);
});

// Start server
async function startServer() {
  await initializeDatabase();
  app.listen(PORT, () => {
    console.log(`Server started successfully`);
    console.log(`Configuration:`);
    console.log(`- Port: ${PORT}`);
    console.log(`- Environment: ${IS_PRODUCTION ? 'Production' : 'Development'}`);
    console.log(`- Bubble webhook: ${process.env.BUBBLE_WEBHOOK_URL ? 'Configured' : 'Not configured'}`);
    console.log(`- Database: ${ENABLE_DATABASE && DATABASE_URL ? 'Enabled' : 'Disabled (memory-only)'}`);
    console.log(`- Staleness threshold: ${STALENESS_THRESHOLD / (60 * 60 * 1000)} hours`);
    console.log(`- Runtime timeout: ${RUNTIME_TIMEOUT / (60 * 60 * 1000)} hours`);
    console.log(`- Post-run tail: ${POST_RUN_TAIL_MS} ms`);
    console.log(`Ready to receive Nest events at /webhook`);
  });
}

startServer().catch(error => {
  console.error('Failed to start server:', error.message);
  process.exit(1);
});