'use strict';

console.log('Starting Nest runtime tracker server...');

const express = require('express');
const axios = require('axios');
const { createPool } = require('./db');
const { handleEvent } = require('./runtime');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '1mb' }));

const pool = createPool();

app.get('/health', async (req, res) => {
  res.json({ ok: true, tailSeconds: parseInt(process.env.LAST_FAN_TAIL_SECONDS || '30', 10) });
});

// Ingest Nest-normalized events
app.post('/nest/event', async (req, res) => {
  try {
    if (!pool) throw new Error('Database not configured');
    await handleEvent(pool, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    console.error('Error /nest/event:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Hard delete a user and all their devices
app.delete('/users/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    if (!pool) throw new Error('Database not configured');

    // Find devices by workspace/user if you link them; for now assume device_key prefix contains userId or you pass a list
    // For a strict mapping, you may add a user_id column to device_status.
    // The following performs a broad delete by workspace_id or location_id if you pass those in query.
    const workspace = req.query.workspace_id || null;
    const location = req.query.location_id || null;

    // If you track userId explicitly, uncomment and use:
    // await pool.query(`DELETE FROM temp_readings WHERE device_key IN (SELECT device_key FROM device_status WHERE user_id=$1)`, [userId]);
    // await pool.query(`DELETE FROM equipment_events WHERE device_key IN (SELECT device_key FROM device_status WHERE user_id=$1)`, [userId]);
    // await pool.query(`DELETE FROM runtime_session WHERE device_key IN (SELECT device_key FROM device_status WHERE user_id=$1)`, [userId]);
    // await pool.query(`DELETE FROM device_status WHERE user_id=$1`, [userId]);

    // Generic hard delete by optional filters
    if (workspace || location) {
      await pool.query(`DELETE FROM temp_readings WHERE device_key IN (SELECT device_key FROM device_status WHERE workspace_id = COALESCE($1, workspace_id) AND location_id = COALESCE($2, location_id))`, [workspace, location]);
      await pool.query(`DELETE FROM equipment_events WHERE device_key IN (SELECT device_key FROM device_status WHERE workspace_id = COALESCE($1, workspace_id) AND location_id = COALESCE($2, location_id))`, [workspace, location]);
      await pool.query(`DELETE FROM runtime_session WHERE device_key IN (SELECT device_key FROM device_status WHERE workspace_id = COALESCE($1, workspace_id) AND location_id = COALESCE($2, location_id))`, [workspace, location]);
      await pool.query(`DELETE FROM device_status WHERE workspace_id = COALESCE($1, workspace_id) AND location_id = COALESCE($2, location_id)`, [workspace, location]);
    } else {
      // If no filters, delete nothing to avoid accidents.
      return res.status(400).json({ ok: false, error: "Provide workspace_id or location_id as query params to scope deletion." });
    }

    res.json({ ok: true, deleted: true, userId, workspace_id: workspace, location_id: location });
  } catch (e) {
    console.error('Error deleting user/devices:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log('Server listening on port', PORT);
});
