const axios = require('axios');

const BUBBLE_URL = process.env.BUBBLE_WEBHOOK_URL;
const MAX_RETRIES = parseInt(process.env.MAX_RETRY_ATTEMPTS || '3', 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY_MS || '2000', 10);

async function postToBubble(payload) {
  let lastError;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Posting to Bubble (attempt ${attempt}/${MAX_RETRIES}):`, JSON.stringify(payload, null, 2));
      
      const response = await axios.post(BUBBLE_URL, payload, {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      
      console.log(`✓ Successfully posted to Bubble: ${response.status}`);
      return response.data;
      
    } catch (error) {
      lastError = error;
      console.error(`✗ Bubble post attempt ${attempt} failed:`, error.message);
      
      if (attempt < MAX_RETRIES) {
        console.log(`Retrying in ${RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      }
    }
  }
  
  console.error(`Failed to post to Bubble after ${MAX_RETRIES} attempts`);
  throw lastError;
}

module.exports = { postToBubble };
