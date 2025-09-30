'use strict';
const axios = require('axios');

async function postToBubble(payload) {
  const url = process.env.BUBBLE_POST_URL;
  if (!url) {
    console.warn('BUBBLE_POST_URL not set; skipping POST:', payload);
    return { skipped: true };
  }
  try {
    const res = await axios.post(url, payload, { timeout: 10000 });
    return { ok: true, status: res.status, data: res.data };
  } catch (err) {
    console.error('Error posting to Bubble:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { postToBubble };
