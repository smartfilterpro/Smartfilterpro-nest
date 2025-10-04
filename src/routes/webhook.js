const express = require('express');
const { handleDeviceEvent } = require('../services/runtimeTracker');

const router = express.Router();

// Per-device processing locks to prevent race conditions
const processingLocks = new Map();

// Helper to extract device key from event
function extractDeviceKey(eventData) {
  const deviceName = eventData.resourceUpdate?.name || eventData.eventId;
  if (!deviceName) return null;
  const parts = deviceName.split('/');
  return parts[parts.length - 1];
}

// Google Nest webhook endpoint
router.post('/', async (req, res) => {
  try {
    console.log('\n========================================');
    console.log('🔔 WEBHOOK RECEIVED FROM GOOGLE');
    console.log('========================================');
    console.log('Raw body:', JSON.stringify(req.body, null, 2));
    
    // Acknowledge receipt immediately - BEFORE any processing
    res.status(200).json({ status: 'received' });
    res.end();
    
    // Process the event asynchronously with device-level locking
    process.nextTick(async () => {
      let eventData = req.body;
      let deviceKey = null;
      
      try {
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
        
        // Extract device key for locking
        deviceKey = extractDeviceKey(eventData);
        
        if (!deviceKey) {
          console.error('Cannot extract device key from event - processing without lock');
          await handleDeviceEvent(eventData);
          return;
        }
        
        // Wait for any in-flight processing for this device to complete
        if (processingLocks.has(deviceKey)) {
          console.log(`⏳ Waiting for previous event to finish processing for device: ${deviceKey}`);
          await processingLocks.get(deviceKey);
        }
        
        // Create a new lock for this device
        const processingPromise = (async () => {
          try {
            await handleDeviceEvent(eventData);
          } catch (error) {
            console.error(`Error processing event for device ${deviceKey}:`, error);
            throw error;
          }
        })();
        
        processingLocks.set(deviceKey, processingPromise);
        
        // Wait for processing to complete
        await processingPromise;
        
        // Release the lock
        processingLocks.delete(deviceKey);
        console.log(`✓ Event processed and lock released for device: ${deviceKey}`);
        
      } catch (error) {
        console.error('Error processing webhook event:', error);
        
        // Clean up lock on error
        if (deviceKey && processingLocks.get(deviceKey)) {
          processingLocks.delete(deviceKey);
          console.log(`🔓 Lock released due to error for device: ${deviceKey}`);
        }
      }
    });
    
  } catch (error) {
    console.error('Webhook handler error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// Debug endpoint to check lock status (optional)
router.get('/locks', (req, res) => {
  const { apiKey } = req.query;
  
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({
    activeLocksCount: processingLocks.size,
    lockedDevices: Array.from(processingLocks.keys())
  });
});

module.exports = router;