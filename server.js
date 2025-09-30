'use strict';

/**
 * Nest SDM runtime tracker (server/controller)
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

const app = express();
const PORT = Number(process.env.PORT || 8080);

// Bubble endpoint: accept either env var name
const BUBBLE_URL = (
  process.env.BUBBLE_URL ||
  process.env.BUBBLE_THERMOSTAT_UPDATES_URL ||
  ''
).trim();

// Optional default user id (if SDM msg lacks one)
const DEFAULT_USER_ID = (process.env.DEFAULT_USER_ID || '').trim() || null;

// Optional DB
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

const sessions = new SessionManager();

/* ---------------- Helpers ---------------- */

function short(id = '') {
  if (typeof id !== 'string') return '';
  return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

async function postToBubble(payload) {
  if (!BUBBLE_URL) {
    console.warn('[WARN] BUBBLE_URL not set; skipping post');
    return { skipped: true };
  }
  try {
    const { data, status } = await axios.post(BUBBLE_URL, payload, { timeout: 10_000 });
    console.log('[BUBBLE-RESP]', status, JSON.stringify(data).slice(0, 500));
    return { ok: true, status, data };
  } catch (e) {
    console.error('[ERROR] Post to Bubble failed:',
      e?.response?.status,
      e?.message,
      e?.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : ''
    );
    return { ok: false, error: e?.message, status: e?.response?.status };
  }
}

/* ---------------- Routes ---------------- */

app.get('/health', (_req, res) => res.json({ ok: true }));

// catch-all POST logger (debug)
app.post('*', (req, res, next) => {
  console.log('[ANY-POST]', req.originalUrl, req.get('x-forwarded-for') || req.ip || '');
  next();
});

app.post(['/webhook', '/nest/events'], async (req, res) => {
  console.log('[INGRESS]', req.get('x-forwarded-for') || 'push', '→', req.originalUrl);
  try {
    // show exactly what Google sent (truncated)
    try { console.log('[RAW-EVENT]', JSON.stringify(req.body).slice(0, 800)); } catch {}

    const decoded = parseSdmPushMessage(req.body);
    if (!decoded) return res.status(204).end();

    for (const evt of decoded.events) {
      const traits = extractEffectiveTraits(evt);

      const input = {
        userId: decoded.userId || DEFAULT_USER_ID,       // ensure userId always filled if desired
        projectId: decoded.projectId || null,
        structureId: decoded.structureId || null,
        deviceId: traits.deviceId,
        deviceName: traits.deviceName,
        roomDisplayName: traits.roomDisplayName || '',
        when: traits.timestamp,
        thermostatMode: traits.thermostatMode,           // OFF/HEAT/COOL/HEATCOOL
        hvacStatusRaw: traits.hvacStatusRaw,             // HEATING/COOLING/OFF (maybe absent)
        hasFanTrait: traits.hasFanTrait,
        fanTimerMode: traits.fanTimerMode,
        fanTimerOn: traits.fanTimerOn,
        currentTempC: traits.currentTempC,
        coolSetpointC: traits.coolSetpointC,
        heatSetpointC: traits.heatSetpointC,
        connectivity: traits.connectivity,
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
          console.warn('[WARN] DB insert failed (ok if table missing):', dbErr.message);
        }
      }

      const bubblePayload = sessions.toBubblePayload(result);

      // log exactly what we send to Bubble (truncated)
      console.log('[BUBBLE-PAYLOAD]', JSON.stringify(bubblePayload, null, 2).slice(0, 1000));

      const postResp = await postToBubble(bubblePayload);

      console.log(
        `[POST] user=${bubblePayload.userId} thermo=${short(bubblePayload.thermostatId)} ` +
        `active=${bubblePayload.isHvacActive} hvacMode=${bubblePayload.hvacMode} ` +
        `status=${bubblePayload.equipmentStatus} runtime=${bubblePayload.runtimeSeconds ?? '—'}`
      );

      if (!postResp?.ok && !postResp?.skipped) {
        console.error('[ERROR] Bubble post failed for device:', input.deviceId);
      }
    }

    return res.status(204).end();
  } catch (err) {
    console.error('[ERROR] /webhook|/nest/events:', err?.message);
    return res.status(204).end();
  }
});

app.listen(PORT, () => {
  console.log(`Nest runtime server listening on :${PORT}`);
  console.log('Ready to receive Nest SDM pushes at /webhook and /nest/events');
});