'use strict';

console.log('Starting Nest runtime tracker server...');

const express = require('express');
const fs = require('fs');
const path = require('path');
const { createPool } = require('./db');
const { handleEvent } = require('./runtime');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '1mb' }));

const pool = createPool();

// --- Ensure schema at startup ---
if (pool) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  try {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    pool.query(schema)
      .then(() => console.log('✅ Schema ensured at startup'))
      .catch((err) => console.error('❌ Schema init failed', err));
  } catch (err) {
    console.error('❌ Could not read schema.sql', err);
  }
}

// --- Handlers ---
async function nestHandler(req, res) {
  try {
    if (!pool) throw new Error('Database not configured');
    await handleEvent(pool, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    console.error('Error handling Nest event:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

// --- Routes ---
app.get('/health', async (req, res) => {
  res.json({ ok: true, tailSeconds: parseInt(process.env.LAST_FAN_TAIL_SECONDS || '30', 10) });
});

// Ingest events
app.post('/nest/event', nestHandler);   // singular
app.post('/nest/events', nestHandler);  // plural
app.post('/webhook', nestHandler);      // generic webhook

// Hard delete a user and all their devices
app.delete('/users/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    if (!pool) throw new Error('Database not configured');

    const workspace = req.query.workspace_id || null;
    const location = req.query.location_id || null;

    if (workspace || location) {
      await pool.query(`DELETE FROM temp_readings WHERE device_key IN (SELECT device_key FROM device_status WHERE workspace_id = COALESCE($1, workspace_id) AND location_id = COALESCE($2, location_id))`, [workspace, location]);
      await pool.query(`DELETE FROM equipment_events WHERE device_key IN (SELECT device_key FROM device_status WHERE workspace_id = COALESCE($1, workspace_id) AND location_id = COALESCE($2, location_id))`, [workspace, location]);
      await pool.query(`DELETE FROM runtime_session WHERE device_key IN (SELECT device_key FROM device_status WHERE workspace_id = COALESCE($1, workspace_id) AND location_id = COALESCE($2, location_id))`, [workspace, location]);
      await pool.query(`DELETE FROM device_status WHERE workspace_id = COALESCE($1, workspace_id) AND location_id = COALESCE($2, location_id)`, [workspace, location]);
    } else {
      return res.status(400).json({ ok: false, error: "Provide workspace_id or location_id as query params to scope deletion." });
    }

    res.json({ ok: true, deleted: true, userId, workspace_id: workspace, location_id: location });
  } catch (e) {
    console.error('Error deleting user/devices:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log('✅ Server listening on port', PORT);
  console.log('   Routes ready:');
  console.log('   - POST /nest/event');
  console.log('   - POST /nest/events');
  console.log('   - POST /webhook');
  console.log('   - GET  /health');
  console.log('   - DELETE /users/:userId');
});