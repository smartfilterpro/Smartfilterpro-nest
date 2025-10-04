const axios = require('axios');

const BUBBLE_URL = process.env.BUBBLE_WEBHOOK_URL;
const MAX_RETRIES = parseInt(process.env.MAX_RETRY_ATTEMPTS || '3', 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS || '2000', 10);

async function postToBubble(payload) {
  let lastError;
  
  // Log only key fields
  console.log('📤 BUBBLE POST:', {
    isHvacActive: payload.isHvacActive,
    hvacMode: payload.hvacMode,
    runtimeMinutes: payload.runtimeMinutes,
    isRuntimeEvent: payload.isRuntimeEvent
  });
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(BUBBLE_URL, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      
      console.log(`✓ Bubble: ${response.status}`);
      return response.data;
      
    } catch (error) {
      lastError = error;
      console.error(`✗ Bubble attempt ${attempt} failed: ${error.message}`);
      
      if (attempt < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }
  
  console.error(`✗ Bubble failed after ${MAX_RETRIES} attempts`);
  throw lastError;
}

// Fire-and-forget version
function postToBubbleAsync(payload) {
  postToBubble(payload).catch(err => {
    console.error('Async Bubble post failed:', err.message);
  });
}

module.exports = { postToBubble, postToBubbleAsync };