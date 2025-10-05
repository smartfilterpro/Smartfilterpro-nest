'use strict';

const axios = require('axios');

const CORE_INGEST_URL = process.env.CORE_INGEST_URL;
const MAX_RETRIES = parseInt(process.env.INGEST_MAX_RETRY_ATTEMPTS || '3', 10);
const RETRY_DELAY_MS = parseInt(process.env.INGEST_RETRY_DELAY_MS || '2000', 10);

/**
 * Posts normalized event payloads to the Core Ingest Service.
 * - Retries up to 3 times by default
 * - Skips automatically if CORE_INGEST_URL isn't defined
 * - Safe for production (non-blocking)
 */
async function postToCoreIngestAsync(eventPayload) {
  if (!CORE_INGEST_URL) {
    console.warn('⚠ CORE_INGEST_URL not set — skipping Core Ingest post');
    return;
  }

  const payload = { events: [eventPayload] }; // Core Ingest expects a batch wrapper

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `${CORE_INGEST_URL}/ingest/v1/events:batch`;
      await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      console.log(`✓ Posted event to Core Ingest (source=${eventPayload.source}, device=${eventPayload.device_id})`);
      return;
    } catch (err) {
      lastError = err;
      console.error(`✗ Core Ingest attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await delay(RETRY_DELAY_MS);
    }
  }

  console.error('✗ Core Ingest failed after all retries:', lastError?.message);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { postToCoreIngestAsync };
