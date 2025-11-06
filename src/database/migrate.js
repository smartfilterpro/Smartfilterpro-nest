const { getPool } = require('./db');

async function runMigrations() {
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    console.log('Running migrations...');
    
    // Device Status Table - CREATE IF NOT EXISTS
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_status (
        device_key TEXT PRIMARY KEY,
        frontend_id TEXT,
        mac_id TEXT,
        device_name TEXT NOT NULL,
        units TEXT DEFAULT 'F',
        location_id TEXT,
        workspace_id TEXT,
        is_running BOOLEAN DEFAULT false,
        session_started_at TIMESTAMPTZ,
        current_mode TEXT,
        current_equipment_status TEXT,
        last_temperature DECIMAL(5,2),
        last_heat_setpoint DECIMAL(5,2),
        last_cool_setpoint DECIMAL(5,2),
        last_fan_status TEXT DEFAULT 'OFF',
        last_equipment_status TEXT,
        last_mode TEXT,
        last_was_cooling BOOLEAN DEFAULT false,
        last_was_heating BOOLEAN DEFAULT false,
        last_was_fan_only BOOLEAN DEFAULT false,
        is_reachable BOOLEAN DEFAULT true,
        last_seen_at TIMESTAMPTZ,
        last_activity_at TIMESTAMPTZ,
        last_post_at TIMESTAMPTZ,
        last_staleness_notification TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        room_display_name TEXT,
        last_fan_tail_until TIMESTAMPTZ
      )
    `);

    // Add missing columns for device metadata (safe if columns already exist)
    console.log('Adding missing device metadata columns...');

    // Helper to add column if it doesn't exist
    const addColumnIfNotExists = async (tableName, columnName, columnType) => {
      try {
        await client.query(`
          ALTER TABLE ${tableName}
          ADD COLUMN IF NOT EXISTS ${columnName} ${columnType}
        `);
      } catch (err) {
        // Ignore if column already exists
        if (!err.message.includes('already exists')) {
          console.error(`Error adding column ${columnName}:`, err.message);
        }
      }
    };

    await addColumnIfNotExists('device_status', 'custom_name', 'TEXT');
    await addColumnIfNotExists('device_status', 'parent_resource', 'TEXT');
    await addColumnIfNotExists('device_status', 'temperature_scale', 'TEXT');
    await addColumnIfNotExists('device_status', 'eco_mode', 'TEXT DEFAULT \'OFF\'');
    await addColumnIfNotExists('device_status', 'eco_heat_celsius', 'DECIMAL(5,2)');
    await addColumnIfNotExists('device_status', 'eco_cool_celsius', 'DECIMAL(5,2)');
    await addColumnIfNotExists('device_status', 'firmware_version', 'TEXT');
    await addColumnIfNotExists('device_status', 'serial_number', 'TEXT');
    await addColumnIfNotExists('device_status', 'last_humidity', 'DECIMAL(5,2)');
    
    // OAuth Tokens Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    // Equipment Events Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS equipment_events (
        id SERIAL PRIMARY KEY,
        device_key TEXT NOT NULL REFERENCES device_status(device_key) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        equipment_status TEXT,
        previous_status TEXT,
        is_active BOOLEAN DEFAULT false,
        session_id UUID,
        event_data JSONB,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_equipment_events_device_key 
      ON equipment_events(device_key)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_equipment_events_session_id 
      ON equipment_events(session_id)
    `);
    
    // Runtime Sessions Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS runtime_sessions (
        id SERIAL PRIMARY KEY,
        device_key TEXT NOT NULL REFERENCES device_status(device_key) ON DELETE CASCADE,
        session_id UUID NOT NULL UNIQUE,
        mode TEXT NOT NULL,
        equipment_status TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        duration_seconds INTEGER DEFAULT 0,
        start_temperature DECIMAL(5,2),
        end_temperature DECIMAL(5,2),
        heat_setpoint DECIMAL(5,2),
        cool_setpoint DECIMAL(5,2),
        tick_count INTEGER DEFAULT 0,
        last_tick_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_device_key 
      ON runtime_sessions(device_key)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_runtime_sessions_session_id 
      ON runtime_sessions(session_id)
    `);
    
    // Temperature Readings Table
    await client.query(`
      CREATE TABLE IF NOT EXISTS temp_readings (
        id SERIAL PRIMARY KEY,
        device_key TEXT NOT NULL REFERENCES device_status(device_key) ON DELETE CASCADE,
        temperature DECIMAL(5,2) NOT NULL,
        units TEXT DEFAULT 'F',
        event_type TEXT,
        session_id UUID,
        recorded_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_temp_readings_device_key 
      ON temp_readings(device_key)
    `);
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_temp_readings_session_id 
      ON temp_readings(session_id)
    `);
    
    await client.query('COMMIT');
    console.log('✓ All migrations completed successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runMigrations };