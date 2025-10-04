const express = require('express');
const { handleDeviceEvent } = require('../services/runtimeTracker');

const router = express.Router();

// Google Nest webhook endpoint
router.post('/', async (req, res) => {
  try {
    console.log('\n========================================');
    console.log('🔔 WEBHOOK RECEIVED FROM GOOGLE');
    console.log('========================================');
    console.log('Raw body:', JSON.stringify(req.body, null, 2));
    
    // Acknowledge receipt immediately
    res.status(200).json({ status: 'received' });
    res.end();
    
    // Process the event asynchronously
    process.nextTick(async () => {
      try {
        let eventData = req.body;
        
        // Check if this is a Pub/Sub message format
        if (req.body.message && req.body.message.data) {
          // Decode base64 data
          const decodedData = Buffer.from(req.body.message.data, 'base64').toString('utf-8');
          console.log('📦 Decoded data:', decodedData);
          
          // Parse JSON
          eventData = JSON.parse(decodedData);
          console.log('📋 Parsed event:', JSON.stringify(eventData, null, 2));
        }
        
        console.log('========================================\n');
        
        await handleDeviceEvent(eventData);
      } catch (error) {
        console.error('Error processing webhook event:', error);
      }
    });
    
  } catch (error) {
    console.error('Webhook error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

module.exports = router;