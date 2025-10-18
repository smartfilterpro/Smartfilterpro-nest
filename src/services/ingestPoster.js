'use strict';
const axios = require('axios');

const CORE_INGEST_URL = process.env.CORE_INGEST_URL;
const CORE_API_KEY = process.env.CORE_API_KEY;
const MAX_RETRIES = parseInt(process.env.INGEST_MAX_RETRY_ATTEMPTS || '3', 10);
const RETRY_DELAY_MS = parseInt(process.env.INGEST_RETRY_DELAY_MS || '2000', 10);

/**
 * Posts normalized event payloads to the Core Ingest Service securely.
 * - Retries up to 3 times
 * - Adds Authorization header (Bearer CORE_API_KEY)
 * - Sends as array (Core format)
 */
async function postToCoreIngestAsync(eventPayload, label = 'event') {
  if (!CORE_INGEST_URL) {
    console.warn('⚠ CORE_INGEST_URL not set — skipping Core Ingest post');
    return;
  }
  if (!CORE_API_KEY) {
    console.warn('⚠ CORE_API_KEY not set — posting insecurely (NOT RECOMMENDED)');
  }

  // ✅ CHANGE: Send as array directly, not wrapped in { events: [...] }
  const payload = Array.isArray(eventPayload) ? eventPayload : [eventPayload];

  const headers = {
    'Content-Type': 'application/json',
    ...(CORE_API_KEY ? { Authorization: `Bearer ${CORE_API_KEY}` } : {})
  };

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `${CORE_INGEST_URL}/ingest/v1/events:batch`;
      await axios.post(url, payload, { headers, timeout: 10000 });
      
      // ✅ IMPROVED: Better logging
      const firstEvent = Array.isArray(payload) ? payload[0] : payload;
      console.log(
        `✅ [CoreIngest] Posted ${label} (${firstEvent?.source || 'nest'}) → ${firstEvent?.device_id || firstEvent?.device_key}`
      );
      return;
    } catch (err) {
      lastError = err;
      const status = err.response?.status || 'unknown';
      const msg = err.response?.data?.error || err.message;
      console.error(`❌ Core Ingest attempt ${attempt}/${MAX_RETRIES} failed [${status}]: ${msg}`);
      
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // exponential backoff
        console.log(`   Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  
  console.error('💥 Core Ingest failed after all retries:', lastError?.message);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { postToCoreIngestAsync };
