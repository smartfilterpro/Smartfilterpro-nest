require(‘dotenv’).config();
const express = require(‘express’);
const { initDatabase, getPool, getPoolMetrics } = require(’./database/db’);
const { recoverActiveSessions } = require(’./services/runtimeTracker’);
const { startPoller } = require(’./services/nestPoller’);
const authRoutes = require(’./routes/auth’);
const webhookRoutes = require(’./routes/webhook’);
const deleteRoutes = require(’./routes/delete’);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get(’/health’, (req, res) => {
const poolMetrics = getPoolMetrics();
res.json({
status: ‘ok’,
timestamp: new Date().toISOString(),
database: poolMetrics || { status: ‘not initialized’ },
memory: {
heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ‘MB’,
heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ‘MB’,
rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ‘MB’
},
uptime: Math.round(process.uptime()) + ‘s’
});
});

// Performance monitoring endpoint (protected)
app.get(’/metrics’, (req, res) => {
const apiKey = req.headers[‘x-api-key’] || req.query.apiKey;

if (apiKey !== process.env.RAILWAY_API_KEY) {
return res.status(401).json({ error: ‘Unauthorized’ });
}

const poolMetrics = getPoolMetrics();
const memUsage = process.memoryUsage();

res.json({
timestamp: new Date().toISOString(),
uptime: process.uptime(),
database: {
pool: poolMetrics,
connectionUtilization: poolMetrics ? (poolMetrics.total / 20 * 100).toFixed(1) + ‘%’ : ‘N/A’
},
memory: {
heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
rss: Math.round(memUsage.rss / 1024 / 1024),
external: Math.round(memUsage.external / 1024 / 1024)
},
process: {
pid: process.pid,
nodeVersion: process.version,
platform: process.platform
}
});
});

app.use(’/auth’, authRoutes);
app.use(’/webhook’, webhookRoutes);
app.use(’/api’, deleteRoutes);

app.use((err, req, res, next) => {
console.error(‘Error:’, err);
res.status(500).json({ error: ‘Internal server error’ });
});

async function startup() {
try {
console.log(‘Starting Nest Runtime Tracker…’);
console.log(`Node version: ${process.version}`);
console.log(`Platform: ${process.platform}`);

```
await initDatabase();
console.log('✓ Database initialized');

await recoverActiveSessions();
console.log('✓ Active sessions recovered');

// Poll immediately to sync actual state (but don't crash if it fails)
const { pollAllUsers, startPoller } = require('./services/nestPoller');

// Start the server first, then poll
app.listen(PORT, () => {
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ Webhook endpoint: POST /webhook`);
  console.log(`✓ Token storage: POST /auth/store-tokens`);
  console.log(`✓ Health check: GET /health`);
  console.log(`✓ Metrics: GET /metrics?apiKey=<key>`);
  console.log('Application ready!');
});

// Poll in background - don't wait for it or let it crash startup
pollAllUsers()
  .then(() => console.log('✓ Initial polling complete'))
  .catch(err => console.error('Initial polling failed (non-fatal):', err.message));

// Start polling scheduler
startPoller();
console.log('✓ Nest API poller scheduled');

// Log memory usage every 5 minutes
setInterval(() => {
  const poolMetrics = getPoolMetrics();
  const memUsage = process.memoryUsage();
  console.log('\n=== SYSTEM METRICS ===');
  console.log(`Memory: ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`);
  if (poolMetrics) {
    console.log(`DB Pool: ${poolMetrics.total} total, ${poolMetrics.idle} idle, ${poolMetrics.waiting} waiting`);
  }
  console.log('===================\n');
}, 5 * 60 * 1000);
```

} catch (error) {
console.error(‘Failed to start application:’, error);
process.exit(1);
}
}

process.on(‘SIGTERM’, async () => {
console.log(‘SIGTERM received, shutting down gracefully…’);
const pool = getPool();
await pool.end();
process.exit(0);
});

process.on(‘uncaughtException’, (error) => {
console.error(‘Uncaught Exception:’, error);
// Don’t exit - log and continue
});

process.on(‘unhandledRejection’, (reason, promise) => {
console.error(‘Unhandled Rejection at:’, promise, ‘reason:’, reason);
// Don’t exit - log and continue
});

startup();