'use strict';

const express = require('express');
const { handleDeviceEvent } = require('../services/runtimeTracker'); // ✅ updated import
const router = express.Router();

// Per-device locks to prevent race conditions
const processingLocks = new Map();

/**
 * Extract a unique device key from event data
 */
function extractDeviceKey(eventData) {
  const deviceName = eventData?.resourceUpdate?.name || eventData?.eventId || null;
  if (!deviceName) return null;
  const parts = deviceName.split('/');
  return parts[parts.length - 1] || null;
}

/**
 * Extract human-readable device name
 */
function extractDeviceName(eventData) {
  return eventData?.resourceUpdate?.name || 'Unknown Device';
}

/**
 * Main Google Pub/Sub Webhook
 */
router.post('/', async (req, res) => {
  console.log('\n========================================');
  console.log('🔔 WEBHOOK RECEIVED FROM GOOGLE');
  console.log('========================================');
  console.log('Raw body:', JSON.stringify(req.body, null, 2));

  // ✅ Immediately acknowledge (prevents Pub/Sub retry)
  res.status(200).json({ status: 'received' });
  res.end();

  // Process asynchronously (don’t block response)
  process.nextTick(async () => {
    let eventData = req.body;
    let deviceKey = null;

    try {
      // ✅ Decode Pub/Sub payload
      if (req.body.message && req.body.message.data) {
        const decodedData = Buffer.from(req.body.message.data, 'base64').toString('utf-8');
        console.log('📦 Decoded data:', decodedData);
        eventData = JSON.parse(decodedData);
        console.log('📋 Parsed event:', JSON.stringify(eventData, null, 2));
      }

      console.log('========================================\n');

      // Extract key + name
      deviceKey = extractDeviceKey(eventData);
      const deviceName = extractDeviceName(eventData);

      if (!deviceKey) {
        console.error('⚠️ Cannot extract device key from event');
        return;
      }

      // Lock: prevent simultaneous processing for the same device
      if (processingLocks.has(deviceKey)) {
        console.log(`⏳ Waiting for previous event to finish for device: ${deviceKey}`);
        await processingLocks.get(deviceKey);
      }

      // Create a processing promise and store it in the map
      const processingPromise = (async () => {
        try {
          console.log(`📩 Processing event for device: ${deviceKey}`);

          await handleDeviceEvent({
            ...eventData,
            deviceKey,
            deviceName
          });

          console.log(`✅ Event handled successfully for device: ${deviceKey}`);
        } catch (err) {
          console.error(`❌ Error processing event for device ${deviceKey}:`, err);
        }
      })();

      processingLocks.set(deviceKey, processingPromise);

      // Wait for this device’s event to complete
      await processingPromise;

      // Unlock
      processingLocks.delete(deviceKey);
      console.log(`🔓 Lock released for device: ${deviceKey}`);
    } catch (error) {
      console.error('❌ Error processing webhook event:', error);
      if (deviceKey && processingLocks.has(deviceKey)) {
        processingLocks.delete(deviceKey);
        console.log(`🔓 Lock released due to error for device: ${deviceKey}`);
      }
    }
  });
});

/**
 * Debug endpoint — list currently locked devices
 */
router.get('/locks', (req, res) => {
  const { apiKey } = req.query;
  if (apiKey !== process.env.RAILWAY_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.json({
    activeLocksCount: processingLocks.size,
    lockedDevices: Array.from(processingLocks.keys()),
  });
});

module.exports = router;
