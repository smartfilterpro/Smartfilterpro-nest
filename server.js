'use strict';

/**
 * Nest SDM runtime tracker (server/controller)
 * - Accepts Google SDM Pub/Sub pushes at /webhook and /nest/events
 * - Uses SessionManager for state/inference and posts normalized payloads to Bubble
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

/* ============================== CONFIG ================================= */

const app = express();
const PORT = Number(process.env.PORT || 8080);

const BUBBLE_THERMOSTAT_UPDATES_URL = (process.env.BUBBLE_THERMOSTAT_UPDATES_URL || '').trim();

const ENABLE_DATABASE = process.env.ENABLE_DATABASE === '1';
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();
let pool = null;
if (ENABLE_DATABASE && DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 5,
  });
  console.log('[CONFIG] Database enabled');
}

app.use(express.json({ limit: '2mb' }));

// Single in-memory session manager
const sessions = new SessionManager();

/* ============================== HELPERS ================================ */

function short(id = '') {
  if (typeof id !== 'string') return '';
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

async function postToBubble(payload) {
  if (!BUBBLE_THERMOSTAT_UPDATES_URL) {
    console.warn('[WARN] BUBBLE_THERMOSTAT_UPDATES_URL not set; skipping post');
    return { skipped: true };
  }
  try {
    const { data, status } = await axios.post(BUBBLE_THERMOSTAT_UPDATES_URL, payload, {
      timeout: 10_000,
    });
    console.log(`[BUBBLE] ✓ Posted (${status}): active=${payload.isHvacActive} mode=${payload.hvacMode} runtime=${payload.runtimeSeconds ?? '—'}`);
    return { ok: true, status, data };
  } catch (e) {
    console.error('[ERROR] Post to Bubble failed:', e?.response?.status, e?.message);
    if (e?.response?.data) {
      console.error('[ERROR] Bubble response:', e.response.data);
    }
    return { ok: false, error: e?.message, status: e?.response?.status };
  }
}

/* ================================ ROUTES =============================== */

app.get('/health', (_req, res) => res.json({ ok: true, timestamp: new Date().toISOString() }));

// Accept both historical and new endpoints to avoid Pub/Sub misconfig issues
app.post(['/webhook', '/nest/events'], async (req, res) => {
  const startTime = Date.now();
  try {
    const source = req.get('x-cloud-trace-context') || req.get('x-forwarded-for') || 'unknown';
    console.log(`\n[INGRESS] ${new Date().toISOString()} | ${source} → ${req.originalUrl}`);

    const decoded = parseSdmPushMessage(req.body);
    if (!decoded) {
      console.warn('[WARN] Could not parse SDM push body; returning 204');
      return res.status(204).end();
    }

    console.log(`[PARSED] ${decoded.events.length} event(s) in message`);

    for (const evt of decoded.events) {
      const traits = extractEffectiveTraits(evt);

      const input = {
        userId: decoded.userId || null,
        projectId: decoded.projectId || null,
        structureId: decoded.structureId || null,
        deviceId: traits.deviceId,
        deviceName: traits.deviceName,
        roomDisplayName: traits.roomDisplayName || '',
        when: traits.timestamp,
        thermostatMode: traits.thermostatMode,
        hvacStatusRaw: traits.hvacStatusRaw,
        hasFanTrait: traits.hasFanTrait,
        fanTimerMode: traits.fanTimerMode,
        fanTimerOn: traits.fanTimerOn,
        currentTempC: traits.currentTempC,
        coolSetpointC: traits.coolSetpointC,
        heatSetpointC: traits.heatSetpointC,
        connectivity: traits.connectivity,
      };

      const result = sessions.process(input);

      // Database insert
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
          console.warn('[WARN] DB insert failed:', dbErr.message);
        }
      }

      // Post to Bubble
      const bubblePayload = sessions.toBubblePayload(result);
      const postResp = await postToBubble(bubblePayload);

      // Summary log
      console.log(
        `[SUMMARY] device=${short(input.deviceId)} room="${input.roomDisplayName}" ` +
        `active=${result.isHvacActive} mode=${result.thermostatMode} ` +
        `equipment=${result.equipmentStatus} fanOnly=${result.isFanOnly} ` +
        `temp=${result.currentTempC}°C ` +
        `runtime=${bubblePayload.runtimeSeconds ?? '—'}s`
      );

      if (!postResp?.ok && !postResp?.skipped) {
        console.error('[ERROR] ✗ Bubble post failed for device:', input.deviceId);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[DONE] Processed in ${elapsed}ms\n`);

    return res.status(204).end();
  } catch (err) {
    console.error('[ERROR] Webhook handler exception:', err?.message);
    console.error(err?.stack);
    return res.status(204).end(); // ack to avoid redelivery storms
  }
});

/* ================================ START ================================ */

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('Nest SDM Runtime Tracker Server');
  console.log(`${'='.repeat(60)}`);
  console.log(`Port: ${PORT}`);
  console.log(`Endpoints: /webhook, /nest/events, /health`);
  console.log(`Bubble URL: ${BUBBLE_THERMOSTAT_UPDATES_URL ? '✓ configured' : '✗ not set'}`);
  console.log(`Database: ${ENABLE_DATABASE ? '✓ enabled' : '✗ disabled'}`);
  console.log(`Debug logging: ${process.env.DEBUG === 'true' ? '✓ ON' : '○ off'}`);
  console.log(`Fan tail: ${process.env.NEST_FAN_TAIL_MS || '30000'}ms`);
  console.log(`${'='.repeat(60)}\n`);
  console.log('Ready to receive Google SDM events...\n');
});
