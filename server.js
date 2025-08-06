console.log('Starting Nest server...');

const express = require('express');
console.log('Express loaded');

const axios = require('axios');
console.log('Axios loaded');

require('dotenv').config();
console.log('Dotenv loaded');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
console.log('Express middleware configured');

app.get('/', (req, res) => {
  res.send('✅ Nest Runtime Webhook server is running!');
});

app.post('/webhook', async (req, res) => {
  try {
    console.log("🔵 Incoming Pub/Sub message:", JSON.stringify(req.body, null, 2));

    // Extract Pub/Sub message
    const pubsubMessage = req.body.message;
    if (!pubsubMessage || !pubsubMessage.data) {
      console.error('❌ Invalid Pub/Sub message structure');
      return res.status(400).send('Invalid Pub/Sub message');
    }

    // Decode base64 Nest event data
    const eventData = JSON.parse(Buffer.from(pubsubMessage.data, 'base64').toString());
    console.log("🔵 Decoded Nest event:", JSON.stringify(eventData, null, 2));

    // For now, just log the event (we'll add sessionTracker back later)
    console.log('✅ Event processed successfully');

    res.status(200).send('OK');
  } catch (error) {
    console.error('🔥 Webhook error:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Nest server is running on port ${PORT}`);
});