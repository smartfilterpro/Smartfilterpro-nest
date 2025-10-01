const express = require('express');
const { getPool } = require('../database/db');

const router = express.Router();

// Delete user and all associated data
router.delete('/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const pool = getPool();
  
  try {
    // Delete all devices for this user (cascades to all related tables)
    const result = await pool.query(
      'DELETE FROM device_status WHERE frontend_id = $1 RETURNING device_key',
      [userId]
    );
    
    console.log(`Deleted user ${userId} and ${result.rowCount} device(s)`);
    
    res.json({
      success: true,
      message: `Deleted user ${userId}`,
      devicesDeleted: result.rowCount
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete specific thermostat
router.delete('/device/:deviceKey', async (req, res) => {
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
