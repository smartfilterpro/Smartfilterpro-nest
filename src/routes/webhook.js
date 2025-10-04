const express = require('express');
const { handleDeviceEvent } = require('../services/runtimeTracker');

const router = express.Router();

// Google Nest webhook endpoint
router.post('/', async (req, res) => {
  try {
    console.log('Received webhook:', JSON.stringify(req.body, null, 2));
    
    // Acknowledge receipt immediately - NO processing before this
    res.status(200).json({ status: 'received' });
    
    // Explicitly end the response to close connection immediately
    res.end();
    
    // Process asynchronously in next tick - completely detached from HTTP response
    process.nextTick(async () => {
      try {
        let eventData = req.body;
        
        // Check if this is a Pub/Sub message format
        if (req.body.message && req.body.message.data) {
          // Decode base64 data
          const decodedData = Buffer.from(req.body.message.data, 'base64').toString('utf-8');
          console.log('Decoded Pub/Sub data:', decodedData);
          
          // Parse JSON
          eventData = JSON.parse(decodedData);
          console.log('Parsed event data:', JSON.stringify(eventData, null, 2));
        }
        
        await handleDeviceEvent(eventData);
      } catch (error) {
        console.error('Error processing webhook event:', error);
      }
    });
    
  } catch (error) {
    console.error('Webhook error:', error);
    // Even on error, respond immediately
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

module.exports = router;