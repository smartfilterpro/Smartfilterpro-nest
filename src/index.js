require('dotenv').config();
const express = require('express');
const { initDatabase, getPool } = require('./database/db');
const { recoverActiveSessions } = require('./services/runtimeTracker');
const { startPoller } = require('./services/nestPoller');
const authRoutes = require('./routes/auth');
const webhookRoutes = require('./routes/webhook');
const deleteRoutes = require('./routes/delete');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/auth', authRoutes);
app.use('/webhook', webhookRoutes);
app.use('/api', deleteRoutes);

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function startup() {
  try {
    console.log('Starting Nest Runtime Tracker...');
    
    await initDatabase();
    console.log('✓ Database initialized');
    
    await recoverActiveSessions();
    console.log('✓ Active sessions recovered');
    
    // Poll immediately to sync actual state
    const { pollAllUsers } = require('./services/nestPoller');
    console.log('Polling all devices to verify current state...');
    await pollAllUsers();
    console.log('✓ Initial polling complete');
    
    // Start polling scheduler
    const { startPoller } = require('./services/nestPoller');
    startPoller();
    console.log('✓ Nest API poller started');
    
    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log(`✓ Webhook endpoint: POST /webhook`);
      console.log(`✓ Token storage: POST /auth/store-tokens`);
      console.log('Application ready!');
    });
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  const pool = getPool();
  await pool.end();
  process.exit(0);
});

startup();
