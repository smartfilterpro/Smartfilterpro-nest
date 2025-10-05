const axios = require('axios');
const CORE_INGEST_URL = process.env.CORE_INGEST_URL;

async function postToCoreIngestAsync(event) {
  if (!CORE_INGEST_URL) {
    console.warn('⚠ CORE_INGEST_URL not set — skipping Core Ingest post');
    return;
  }

  try {
    const payload = { events: [event] };
    await axios.post(`${CORE_INGEST_URL}/ingest/v1/events:batch`, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log('✓ Core Ingest post success');
  } catch (err) {
    console.error('✗ Core Ingest post failed:', err.message);
  }
}

module.exports = { postToCoreIngestAsync };
