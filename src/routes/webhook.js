const express = require(‘express’);
const { handleDeviceEvent } = require(’../services/runtimeTracker’);

const router = express.Router();

// Track processing stats for monitoring
let stats = {
received: 0,
processed: 0,
failed: 0,
lastProcessTime: null
};

// Reset stats daily
setInterval(() => {
console.log(‘24hr Webhook Stats:’, stats);
stats = { received: 0, processed: 0, failed: 0, lastProcessTime: stats.lastProcessTime };
}, 24 * 60 * 60 * 1000);

// Google Nest webhook endpoint
router.post(’/’, async (req, res) => {
const startTime = Date.now();

try {
// Acknowledge receipt IMMEDIATELY - before any processing
res.status(200).json({ status: ‘received’ });
res.end();

```
stats.received++;

// Process completely asynchronously - detached from HTTP response
process.nextTick(async () => {
  try {
    let eventData = req.body;
    
    // Check if this is a Pub/Sub message format
    if (req.body.message && req.body.message.data) {
      try {
        // Decode base64 data
        const decodedData = Buffer.from(req.body.message.data, 'base64').toString('utf-8');
        
        // Parse JSON
        eventData = JSON.parse(decodedData);
      } catch (parseError) {
        console.error('Failed to parse Pub/Sub message:', parseError);
        stats.failed++;
        return;
      }
    }
    
    // Process event with timeout protection
    const processingPromise = handleDeviceEvent(eventData);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Event processing timeout')), 60000) // 60 second timeout
    );
    
    await Promise.race([processingPromise, timeoutPromise]);
    
    stats.processed++;
    stats.lastProcessTime = Date.now() - startTime;
    
  } catch (error) {
    console.error('Error processing webhook event:', error.message);
    stats.failed++;
    
    // Don't crash the server - just log and continue
    // Each event is isolated from others
  }
});
```

} catch (error) {
console.error(‘Webhook handler error:’, error);
stats.failed++;

```
// Even on error, try to respond if we haven't already
if (!res.headersSent) {
  res.status(500).json({ error: 'Internal server error' });
}
```

}
});

// Health check endpoint with stats
router.get(’/stats’, (req, res) => {
const { apiKey } = req.query;

if (apiKey !== process.env.RAILWAY_API_KEY) {
return res.status(401).json({ error: ‘Unauthorized’ });
}

res.json({
…stats,
successRate: stats.received > 0
? ((stats.processed / stats.received) * 100).toFixed(2) + ‘%’
: ‘N/A’,
uptime: process.uptime(),
memory: process.memoryUsage()
});
});

module.exports = router;