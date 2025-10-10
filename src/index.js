require('dotenv').config();
const express = require('express');
const { initDatabase, closePool } = require('./database/db');
const { recoverActiveSessions } = require('./services/runtimeTracker');
const { startPoller, stopPoller } = require('./services/nestPoller');
const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const deleteRoutes = require('./routes/delete');

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// Middleware
// ===============================
app.use(express.json({ limit: '1mb' })); // Limit payload size

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
    }
  });
});

// ===============================
// Routes
// ===============================
app.use('/auth', authRoutes);
app.use('/webhook', webhookRoutes);
app.use('/api', deleteRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ===============================
// Server lifecycle
// ===============================
let server;

async function startup() {
  try {
    console.log('Starting Nest Runtime Tracker...');
    console.log(`Node version: ${process.version}`);
    console.log(`Memory limit: ${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`);

    // Database initialization
    await initDatabase();
    console.log('✓ Database initialized');

    // Recover active runtime sessions (stub or real implementation)
    await recoverActiveSessions();
    console.log('✓ Active sessions recovered');

    // Start HTTP server
    server = app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Webhook endpoint: POST /webhook`);
      console.log(`✓ Health check: GET /health`);
      console.log('Application ready!');
    });

    // Connection timeouts
    server.timeout = 30000;
    server.keepAliveTimeout = 65000; // must be > LB timeout
    server.headersTimeout = 66000;   // must be > keepAliveTimeout

    // Initial background poll
    const { pollAllUsers } = require('./services/nestPoller');
    pollAllUsers()
      .then(() => console.log('✓ Initial polling complete'))
      .catch(err => console.error('Initial polling failed (non-fatal):', err.message));

    // Start periodic poller
    startPoller();
    console.log('✓ Nest API poller scheduled');

  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

// ===============================
// Graceful shutdown
// ===============================
async function gracefulShutdown(signal) {
  console.log(`\n${signal} received, shutting down gracefully...`);

  if (server) {
    server.close(() => {
      console.log('✓ HTTP server closed');
    });
  }

  stopPoller();
  console.log('✓ Poller stopped');

  await closePool();
  console.log('✓ Database connections closed');

  console.log('Shutdown complete');
  process.exit(0);
}

// ===============================
// Signal and error handlers
// ===============================
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ===============================
// Boot the service
// ===============================
startup();
