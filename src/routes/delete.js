const express = require('express');
const { getPool } = require('../database/db');

const router = express.Router();

// Middleware to verify API key
function verifyApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey || req.body.apiKey;
  
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    console.error('Unauthorized deletion attempt - invalid API key');
    return res.status(401).json({ 
      success: false,
      error: 'Unauthorized - Invalid API key' 
    });
  }
  
  next();
}

// Delete user and all associated data
router.delete('/user/:userId', verifyApiKey, async (req, res) => {
  const { userId } = req.params;
  const pool = getPool();
  
  try {
    console.log(`Deleting all data for user: ${userId}`);
    
    // Get count of what will be deleted
    const deviceCount = await pool.query(
      'SELECT COUNT(*) FROM device_status WHERE frontend_id = $1',
      [userId]
    );
    
    const sessionCount = await pool.query(
      `SELECT COUNT(*) FROM runtime_sessions rs 
       JOIN device_status ds ON rs.device_key = ds.device_key 
       WHERE ds.frontend_id = $1`,
      [userId]
    );
    
    const tempCount = await pool.query(
      `SELECT COUNT(*) FROM temp_readings tr 
       JOIN device_status ds ON tr.device_key = ds.device_key 
       WHERE ds.frontend_id = $1`,
      [userId]
    );
    
    const eventCount = await pool.query(
      `SELECT COUNT(*) FROM equipment_events ee 
       JOIN device_status ds ON ee.device_key = ds.device_key 
       WHERE ds.frontend_id = $1`,
      [userId]
    );
    
    // Delete OAuth tokens
    await pool.query('DELETE FROM oauth_tokens WHERE user_id = $1', [userId]);
    console.log(`Deleted OAuth tokens for user ${userId}`);
    
    // Get device keys before deletion (to clear from memory)
    const devicesResult = await pool.query(
      'SELECT device_key FROM device_status WHERE frontend_id = $1',
      [userId]
    );
    
    // Delete all devices (cascades to runtime_sessions, temp_readings, equipment_events)
    const deleteResult = await pool.query(
      'DELETE FROM device_status WHERE frontend_id = $1 RETURNING device_key',
      [userId]
    );
    
    // Clear from in-memory cache
    const { activeDevices } = require('../services/runtimeTracker');
    for (const row of devicesResult.rows) {
      if (activeDevices && activeDevices.has(row.device_key)) {
        activeDevices.delete(row.device_key);
        console.log(`Cleared ${row.device_key} from active sessions cache`);
      }
    }
    
    console.log(`Successfully deleted all data for user ${userId}`);
    
    res.json({
      success: true,
      message: `All data deleted for user ${userId}`,
      deleted: {
        devices: parseInt(deviceCount.rows[0].count),
        runtimeSessions: parseInt(sessionCount.rows[0].count),
        temperatureReadings: parseInt(tempCount.rows[0].count),
        equipmentEvents: parseInt(eventCount.rows[0].count),
        oauthTokens: 1
      }
    });
  } catch (error) {
    console.error('Error deleting user data:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Delete specific thermostat
router.delete('/device/:deviceKey', verifyApiKey, async (req, res) => {
  const { deviceKey } = req.params;
  const pool = getPool();
  
  try {
    const result = await pool.query(
      'DELETE FROM device_status WHERE device_key = $1 RETURNING device_name',
      [deviceKey]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({
        success: false,
        error: 'Device not found'
      });
    }
    
    // Clear from in-memory cache
    const { activeDevices } = require('../services/runtimeTracker');
    if (activeDevices && activeDevices.has(deviceKey)) {
      activeDevices.delete(deviceKey);
      console.log(`Cleared ${deviceKey} from active sessions cache`);
    }
    
    console.log(`Deleted device ${deviceKey}`);
    
    res.json({
      success: true,
      message: `Deleted device ${deviceKey}`
    });
  } catch (error) {
    console.error('Error deleting device:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
