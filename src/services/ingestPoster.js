// src/services/ingestPoster.js
const axios = require('axios');

const CORE_INGEST_URL = process.env.CORE_INGEST_URL;
const MAX_RETRIES = parseInt(process.env.INGEST_MAX_RETRY_ATTEMPTS || '3', 10);
const RETRY_DELAY_MS = parseInt(process.env.INGEST_RETRY_DELAY_MS || '2000', 10);

/**
 * Posts a normalized event payload to the Core Ingest Service.
 * Safe no-op if CORE_INGEST_URL isn't set or if request fails.
 */
async function postToCoreIngestAsync(eventPayload) {
  if (!CORE_INGEST_URL) {
    console.warn('⚠ CORE_INGEST_URL not set — skipping Core Ingest post');
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await axios.post(`${CORE_INGEST_URL}/ingest/v1/events:batch`, { events: [eventPayload] }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      console.log('✓ Core Ingest post success');
      return;
    } catch (err) {
      lastError = err;
      console.error(`✗ Core Ingest attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  console.error('✗ Core Ingest failed after max retries:', lastError?.message);
}

module.exports = { postToCoreIngestAsync };
