-- Schema for SmartFilterPro Nest Runtime Tracker

CREATE TABLE IF NOT EXISTS device_status (
  device_key TEXT PRIMARY KEY,
  frontend_id TEXT,
  mac_id TEXT,
  device_name TEXT,
  units TEXT,
  location_id TEXT,
  workspace_id TEXT,
  is_running BOOLEAN DEFAULT FALSE,
  session_started_at TIMESTAMPTZ,
  current_mode TEXT, -- COOL/HEAT/OFF
  current_equipment_status TEXT, -- cool/heat/idle/unknown
  last_temperature DOUBLE PRECISION,
  last_heat_setpoint DOUBLE PRECISION,
  last_cool_setpoint DOUBLE PRECISION,
  last_fan_status TEXT, -- ON/OFF/UNKNOWN
  last_equipment_status TEXT,
  last_mode TEXT, -- COOL/HEAT/FAN/OFF
  last_was_cooling BOOLEAN DEFAULT FALSE,
  last_was_heating BOOLEAN DEFAULT FALSE,
  last_was_fan_only BOOLEAN DEFAULT FALSE,
  is_reachable BOOLEAN DEFAULT TRUE,
  last_seen_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  last_post_at TIMESTAMPTZ,
  last_staleness_notification TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  room_display_name TEXT,
  last_fan_tail_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS equipment_events (
  id BIGSERIAL PRIMARY KEY,
  device_key TEXT NOT NULL,
  event_type TEXT NOT NULL, -- equipment_status_change, connectivity, mode_change, fan_timer_change
  equipment_status TEXT, -- cool/heat/idle/unknown
  previous_status TEXT,
  is_active BOOLEAN,
  session_id UUID,
  event_data JSONB,
  recorded_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS runtime_session (
  id UUID PRIMARY KEY,
  device_key TEXT NOT NULL,
  mode TEXT NOT NULL, -- COOL/HEAT/FAN
  equipment_status TEXT, -- cool/heat/fan/unknown at start
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  start_temperature DOUBLE PRECISION,
  end_temperature DOUBLE PRECISION,
  heat_setpoint DOUBLE PRECISION,
  cool_setpoint DOUBLE PRECISION,
  tick_count INTEGER DEFAULT 0,
  last_tick_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS temp_readings (
  id BIGSERIAL PRIMARY KEY,
  device_key TEXT NOT NULL,
  temperature DOUBLE PRECISION,
  units TEXT,
  event_type TEXT, -- temperature_update
  session_id UUID,
  recorded_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_equipment_events_device_time ON equipment_events (device_key, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_session_device_time ON runtime_session (device_key, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_temp_readings_device_time ON temp_readings (device_key, recorded_at DESC);
