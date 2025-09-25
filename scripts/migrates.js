#!/usr/bin/env node

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function runMigration() {
  try {
    console.log('Starting database migration...');

    // Check if schema already exists
    const schemaExists = await checkSchemaExists();
    
    if (schemaExists) {
      console.log('Database schema already exists - skipping migration');
    } else {
      console.log('Creating initial schema...');
      await createInitialSchema();
      console.log('Initial schema created successfully');
    }
    
    console.log('Migration completed successfully!');
    
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function checkSchemaExists() {
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.tables 
      WHERE table_name = 'device_states' AND table_schema = 'public'
    `);
    
    return parseInt(result.rows[0].count) > 0;
  } catch (error) {
    console.log('Error checking schema, assuming it does not exist');
    return false;
  }
}

async function createInitialSchema() {
  const sql = `
    -- Device state tracking table for Nest devices
    CREATE TABLE IF NOT EXISTS device_states (
        device_key VARCHAR(100) PRIMARY KEY,
        frontend_id VARCHAR(100),
        mac_id VARCHAR(100),
        device_name VARCHAR(255),
        units CHAR(1) DEFAULT 'F' CHECK (units IN ('F', 'C')),
        location_id VARCHAR(100),
        workspace_id VARCHAR(100),
        
        -- Current runtime session
        is_running BOOLEAN DEFAULT FALSE,
        session_started_at TIMESTAMPTZ,
        current_mode VARCHAR(20) DEFAULT 'idle',
        current_equipment_status VARCHAR(50),
        
        -- Last known values
        last_temperature DECIMAL(5,2),
        last_heat_setpoint DECIMAL(5,2),
        last_cool_setpoint DECIMAL(5,2),
        last_fan_status VARCHAR(10),
        last_equipment_status VARCHAR(50),
        
        -- Session tracking
        last_mode VARCHAR(20),
        last_was_cooling BOOLEAN DEFAULT FALSE,
        last_was_heating BOOLEAN DEFAULT FALSE,
        last_was_fan_only BOOLEAN DEFAULT FALSE,
        
        -- Connectivity
        is_reachable BOOLEAN DEFAULT TRUE,
        last_seen_at TIMESTAMPTZ DEFAULT NOW(),
        last_activity_at TIMESTAMPTZ DEFAULT NOW(),
        last_post_at TIMESTAMPTZ DEFAULT NOW(),
        
        -- Metadata
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Runtime sessions history
    CREATE TABLE IF NOT EXISTS runtime_sessions (
        id BIGSERIAL PRIMARY KEY,
        device_key VARCHAR(100) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
        session_id UUID DEFAULT gen_random_uuid(),
        
        -- Session details
        mode VARCHAR(20) NOT NULL,
        equipment_status VARCHAR(50),
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER,
        
        -- Environmental data
        start_temperature DECIMAL(5,2),
        end_temperature DECIMAL(5,2),
        heat_setpoint DECIMAL(5,2),
        cool_setpoint DECIMAL(5,2),
        
        -- Session stats
        tick_count INTEGER DEFAULT 0,
        last_tick_at TIMESTAMPTZ,
        
        -- Metadata
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Equipment status changes log
    CREATE TABLE IF NOT EXISTS equipment_events (
        id BIGSERIAL PRIMARY KEY,
        device_key VARCHAR(100) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
        event_type VARCHAR(50) NOT NULL,
        equipment_status VARCHAR(50),
        previous_status VARCHAR(50),
        is_active BOOLEAN,
        session_id UUID,
        event_data JSONB,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Temperature readings log
    CREATE TABLE IF NOT EXISTS temperature_readings (
        id BIGSERIAL PRIMARY KEY,
        device_key VARCHAR(100) NOT NULL REFERENCES device_states(device_key) ON DELETE CASCADE,
        temperature DECIMAL(5,2) NOT NULL,
        units CHAR(1) NOT NULL,
        event_type VARCHAR(50),
        session_id UUID,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_device_states_last_seen ON device_states(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_device_states_running ON device_states(is_running) WHERE is_running = TRUE;
    CREATE INDEX IF NOT EXISTS idx_runtime_sessions_device_time ON runtime_sessions(device_key, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_runtime_sessions_active ON runtime_sessions(device_key, ended_at) WHERE ended_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_temperature_readings_device_time ON temperature_readings(device_key, recorded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_equipment_events_device_time ON equipment_events(device_key, recorded_at DESC);

    -- Create trigger function if it doesn't exist
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
    END;
    $$ language 'plpgsql';

    -- Create triggers only if they don't exist
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

  await pool.query(sql);
}

// Run migration if this script is called directly
if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
