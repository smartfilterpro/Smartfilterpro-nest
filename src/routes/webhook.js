const express = require('express');
const { handleDeviceEvent } = require('../services/runtimeTracker');

const router = express.Router();

// Google Nest webhook endpoint
router.post('/', async (req, res) => {
  try {
    console.log('Received webhook:', JSON.stringify(req.body, null, 2));
    
    // Acknowledge receipt immediately
    res.status(200).json({ status: 'received' });
    
    // Process the event asynchronously
    setImmediate(async () => {
      try {
        await handleDeviceEvent(req.body);
      } catch (error) {
        console.error('Error processing webhook event:', error);
      }
    });
    
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
