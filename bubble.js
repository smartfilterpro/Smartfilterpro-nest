'use strict';
const axios = require('axios');

/**
 * Posts a payload to Bubble and logs both the outgoing payload and the response.
 */
async function postToBubble(payload) {
  const url = process.env.BUBBLE_POST_URL;
  if (!url) {
    console.warn('[BUBBLE] ⚠️ No BUBBLE_POST_URL set; skipping POST');
    return { skipped: true };
  }

  // Log outgoing
  console.log('[BUBBLE ➡️ OUTGOING]', JSON.stringify(payload));

  try {
    const res = await axios.post(url, payload, { timeout: 10000 });

    // Log successful response
    console.log('[BUBBLE ✅ RESPONSE]', {
      status: res.status,
      data: res.data
    });

    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    // Log failure
    console.error('[BUBBLE ❌ ERROR]', {
      message: err.message,
      code: err.code,
      response: err.response?.data
    });
    return { ok: false, error: err.message };
  }
}

module.exports = { postToBubble };