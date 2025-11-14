const express = require('express');
const { getPool } = require('../database/db');

const router = express.Router();

/**
 * Endpoint for Bubble to register which devices belong to which user
 * This links device_status.bubble_user_id to oauth_tokens.user_id
 */
router.post('/register', async (req, res) => {
  const { bubble_user_id, device_name, apiKey } = req.body;

  // Verify API key
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    console.error('Invalid API key provided');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Validate required fields
  if (!bubble_user_id || !device_name) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['bubble_user_id', 'device_name'],
      received: { bubble_user_id, device_name }
    });
  }

  try {
    const pool = getPool();

    // Verify that the user has OAuth tokens
    const userCheck = await pool.query(
      'SELECT user_id FROM oauth_tokens WHERE user_id = $1',
      [bubble_user_id]
    );

    if (userCheck.rows.length === 0) {
      return res.status(404).json({
        error: 'User not found',
        message: 'No OAuth tokens found for this user. Please authenticate first.'
      });
    }

    // Extract device_key from device_name (last part of path)
    // Example: enterprises/project-id/devices/abc123 -> abc123
    const deviceKey = device_name.split('/').pop();

    // Update or insert the device with bubble_user_id
    const result = await pool.query(`
      INSERT INTO device_status (device_key, device_name, bubble_user_id, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (device_key) DO UPDATE SET
        bubble_user_id = EXCLUDED.bubble_user_id,
        device_name = EXCLUDED.device_name,
        updated_at = NOW()
      RETURNING device_key, device_name, bubble_user_id
    `, [deviceKey, device_name, bubble_user_id]);

    console.log(`✅ Device registered successfully:`);
    console.log(`   - Device key: ${deviceKey}`);
    console.log(`   - Device name: ${device_name}`);
    console.log(`   - Bubble user ID: ${bubble_user_id}`);

    res.json({
      success: true,
      message: 'Device registered successfully',
      device: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Error registering device:', error);
    res.status(500).json({
      error: 'Failed to register device',
      message: error.message
    });
  }
});

/**
 * Endpoint to list all devices for a Bubble user
 */
router.get('/list/:bubble_user_id', async (req, res) => {
  const { bubble_user_id } = req.params;
  const { apiKey } = req.query;

  // Verify API key
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT
        device_key,
        device_name,
        bubble_user_id,
        frontend_id,
        custom_name,
        room_display_name,
        is_reachable,
        last_seen_at,
        last_activity_at
      FROM device_status
      WHERE bubble_user_id = $1
      ORDER BY device_name`,
      [bubble_user_id]
    );

    res.json({
      success: true,
      count: result.rows.length,
      devices: result.rows
    });
  } catch (error) {
    console.error('Error listing devices:', error);
    res.status(500).json({
      error: 'Failed to list devices',
      message: error.message
    });
  }
});

/**
 * Endpoint to unregister a device from a user
 */
router.post('/unregister', async (req, res) => {
  const { bubble_user_id, device_name, apiKey } = req.body;

  // Verify API key
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!bubble_user_id || !device_name) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['bubble_user_id', 'device_name']
    });
  }

  try {
    const pool = getPool();
    const deviceKey = device_name.split('/').pop();

    const result = await pool.query(
      `UPDATE device_status
       SET bubble_user_id = NULL, updated_at = NOW()
       WHERE device_key = $1 AND bubble_user_id = $2
       RETURNING device_key`,
      [deviceKey, bubble_user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Device not found or not owned by this user'
      });
    }

    console.log(`✅ Device unregistered: ${deviceKey} from user ${bubble_user_id}`);

    res.json({
      success: true,
      message: 'Device unregistered successfully',
      device_key: deviceKey
    });
  } catch (error) {
    console.error('Error unregistering device:', error);
    res.status(500).json({
      error: 'Failed to unregister device',
      message: error.message
    });
  }
});

module.exports = router;
