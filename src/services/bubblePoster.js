const axios = require('axios');

const BUBBLE_URL = process.env.BUBBLE_WEBHOOK_URL;
const MAX_RETRIES = parseInt(process.env.MAX_RETRY_ATTEMPTS || '2', 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS || '1000', 10);

async function postToBubble(payload) {
  let lastError;
  
  console.log('📤 BUBBLE PAYLOAD:', JSON.stringify(payload, null, 2));
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`⏳ Attempt ${attempt}/${MAX_RETRIES} - Posting to Bubble...`);
      
      const response = await axios.post(BUBBLE_URL, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 5000  // Reduced from 10000ms to 5000ms
      });
      
      console.log(`✓ Bubble responded with status: ${response.status}`);
      console.log(`✓ Response data:`, JSON.stringify(response.data, null, 2));
      return response.data;
      
    } catch (error) {
      lastError = error;
      console.error(`✗ Attempt ${attempt} failed: ${error.message}`);
      if (error.response) {
        console.error(`✗ Response status: ${error.response.status}`);
        console.error(`✗ Response data:`, error.response.data);
      }
      
      if (attempt < MAX_RETRIES) {
        console.log(`⏳ Retrying in ${RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }
  
  console.error(`✗ Failed to post to Bubble after ${MAX_RETRIES} attempts`);
  throw lastError;
}

// Fire-and-forget version - does not block caller
function postToBubbleAsync(payload) {
  postToBubble(payload).catch(err => {
    console.error('Async Bubble post failed (non-blocking):', err.message);
  });
}

module.exports = { postToBubble, postToBubbleAsync };
