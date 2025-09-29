'use strict';

/**
 * Nest SDM runtime tracker server
 * - Counts runtime whenever air is moving (heating, cooling, heatcool, or fan-only)
 * - Inference when ThermostatHvac.status is missing (mode + setpoints + temp trend, or explicit Fan trait)
 * - Posts to Bubble on each event; runtimeSeconds=null while running; non-zero on session end
 */

const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const {
  SessionManager,
  parseSdmPushMessage,
  extractEffectiveTraits,
} = require('./sessionTracker');

/* ---------------------------- Config & Setup ---------------------------- */

const app = express();
const PORT = Number(process.env.PORT || 8080);

// Bubble endpoint (required)
const BUBBLE_THERMOSTAT_UPDATES_URL = (process.env.BUBBLE_THERMOSTAT_UPDATES_URL || '').trim();

// Optional Postgres (enable with ENABLE_DATABASE=1 and set DATABASE_URL)
const ENABLE_DATABASE = process.env.ENABLE_DATABASE === '1';
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
let pool = null;
if (ENABLE_DATABASE && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 5,
  });
}

app.use(express.json({ limit: '2mb' }));

// Single in-memory session manager
const sessions = new SessionManager();

/* -------------------------- Helpers: Bubble Post ------------------------ */

async function postToBubble(payload) {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL) {
    console.warn('[WARN] BUBBLE_THERMOSTAT_UPDATES_URL not set; skipping post');
    return { skipped: true };
  }
  try {
    const { data, status } = await axios.post(BUBBLE_THERMOSTAT_UPDATES_URL, payload, {
      timeout: 10_000,
    });
    return { ok: true, status, data };
  } catch (e) {
    console.error('[ERROR] Post to Bubble failed:', e?.response?.status, e?.message);
    return { ok: false, error: e?.message, status: e?.response?.status };
  }
}

/* ------------------------------ Routes --------------------------------- */

/**
 * Health
 */
app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * Google SDM Pub/Sub push endpoint
 * - Google Pub/Sub pushes JSON: { message: { data: base64, messageId, attributes }, subscription }
 * - The base64 decodes to SDM event JSON containing resourceUpdate(s)
 */
app.post('/nest/events', async (req, res) => {
  try {
    const decoded = parseSdmPushMessage(req.body);
    if (!decoded) {
      console.warn('[WARN] Could not parse SDM push body; echoing 204');
      return res.status(204).end();
    }

    // Handle each resourceUpdate (most pushes have 1)
    for (const evt of decoded.events) {
      const traits = extractEffectiveTraits(evt);

      // Build a normalized input for the session layer
      const input = {
        userId: decoded.userId || null, // optional; set via env/project mapping if needed
        projectId: decoded.projectId || null,
        structureId: decoded.structureId || null,
        deviceId: traits.deviceId, // stable Nest SDM device id
        deviceName: traits.deviceName, // full resource path
        roomDisplayName: traits.roomDisplayName || '',
        when: traits.timestamp, // Date ISO
        // raw traits we use
        thermostatMode: traits.thermostatMode,           // HEAT/COOL/HEATCOOL/OFF
        hvacStatusRaw: traits.hvacStatusRaw,             // HEATING/COOLING/OFF (if provided)
        hasFanTrait: traits.hasFanTrait,
        fanTimerMode: traits.fanTimerMode,               // ON/OFF (if provided)
        fanTimerOn: traits.fanTimerOn,                   // boolean, if provided
        currentTempC: traits.currentTempC,
        coolSetpointC: traits.coolSetpointC,
        heatSetpointC: traits.heatSetpointC,
        connectivity: traits.connectivity,               // ONLINE/OFFLINE/UNKNOWN
      };

      // Process through the session manager (this decides active vs idle and session transitions)
      const result = sessions.process(input);

      // Persist (optional)
      if (ENABLE_DATABASE && pool) {
        try {
          await pool.query(
            `INSERT INTO nest_events (
               device_id, at, hvac_mode, is_active, hvac_status, fan_only, temp_c, cool_sp_c, heat_sp_c, reachable
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              input.deviceId,
              input.when,
              result.thermostatMode || null,
              result.isHvacActive,
              result.equipmentStatus,
              result.isFanOnly,
              result.currentTempC,
              result.coolSetpointC,
              result.heatSetpointC,
              result.isReachable,
            ]
          );
        } catch (dbErr) {
          console.warn('[WARN] DB insert failed (ok to ignore if no table):', dbErr.message);
        }
      }

      // Format Bubble payload, post
      const bubblePayload = sessions.toBubblePayload(result);
      const postResp = await postToBubble(bubblePayload);

      // Log concise summary
      console.log(
        `[POST] device=${short(input.deviceId)} active=${result.isHvacActive} ` +
        `mode=${result.thermostatMode} status=${result.equipmentStatus} ` +
        `fanOnly=${result.isFanOnly} runtime=${bubblePayload.runtimeSeconds ?? '—'}`
      );

      if (!postResp?.ok && !postResp?.skipped) {
        console.error('[ERROR] Bubble post failed for device:', input.deviceId);
      }
    }

    // ACK to Pub/Sub quickly
    return res.status(204).end();
  } catch (err) {
    console.error('[ERROR] /nest/events handler:', err?.message);
    return res.status(204).end(); // Pub/Sub expects 2xx to ack; avoid redelivery storms
  }
});

/* ------------------------------- Start ---------------------------------- */

app.listen(PORT, () => {
  console.log(`Nest runtime server listening on :${PORT}`);
});

/* ----------------------------- Utilities -------------------------------- */

function short(id = '') {
  if (typeof id !== 'string') return '';
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}
