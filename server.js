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
    return { ok: true, status, data };
  } catch (e) {
    console.error('[ERROR] Post to Bubble failed:', e?.response?.status, e?.message);
    return { ok: false, error: e?.message, status: e?.response?.status };
  }
}

/* ================================ ROUTES =============================== */

app.get('/health', (_req, res) => res.json({ ok: true }));

// Accept both historical and new endpoints to avoid Pub/Sub misconfig issues
app.post(['/webhook', '/nest/events'], async (req, res) => {
  // Clear ingress log so you can confirm pushes are arriving
  try {
    console.log(
      '[INGRESS]',
      req.get('x-cloud-trace-context') || req.get('x-forwarded-for') || 'push',
      '→',
      req.originalUrl
    );

    const decoded = parseSdmPushMessage(req.body);
    if (!decoded) {
      console.warn('[WARN] Could not parse SDM push body; 204');
      return res.status(204).end();
    }

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
        thermostatMode: traits.thermostatMode,   // OFF/HEAT/COOL/HEATCOOL
        hvacStatusRaw: traits.hvacStatusRaw,     // HEATING/COOLING/OFF (optional)
        hasFanTrait: traits.hasFanTrait,
        fanTimerMode: traits.fanTimerMode,
        fanTimerOn: traits.fanTimerOn,
        currentTempC: traits.currentTempC,
        coolSetpointC: traits.coolSetpointC,
        heatSetpointC: traits.heatSetpointC,
        connectivity: traits.connectivity,       // ONLINE/OFFLINE/UNKNOWN
      };

      const result = sessions.process(input);

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

      const bubblePayload = sessions.toBubblePayload(result);
      const postResp = await postToBubble(bubblePayload);

      console.log('[BUBBLE]', {
      isHvacActive: bubblePayload.isHvacActive,
      hvacMode: bubblePayload.hvacMode,
      runtimeSeconds: bubblePayload.runtimeSeconds
      });


      console.log(
        `[POST] device=${short(input.deviceId)} active=${result.isHvacActive} ` +
        `mode=${result.thermostatMode} status=${result.equipmentStatus} ` +
        `fanOnly=${result.isFanOnly} runtime=${bubblePayload.runtimeSeconds ?? '—'}`
      );

      if (!postResp?.ok && !postResp?.skipped) {
        console.error('[ERROR] Bubble post failed for device:', input.deviceId);
      }
    }

    return res.status(204).end();
  } catch (err) {
    console.error('[ERROR] /webhook|/nest/events:', err?.message);
    return res.status(204).end(); // ack to avoid redelivery storms
  }
});

/* ================================ START ================================ */

app.listen(PORT, () => {
  console.log(`Nest runtime server listening on :${PORT}`);
  console.log('Ready to receive Nest SDM pushes at /webhook and /nest/events');
});
