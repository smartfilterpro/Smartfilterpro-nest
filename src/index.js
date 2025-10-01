require('dotenv').config();
const express = require('express');
const { initDatabase, getPool } = require('./database/db');
const { startPubSubListener } = require('./services/pubsubListener');
const { recoverActiveSessions } = require('./services/runtimeTracker');
const authRoutes = require('./routes/auth');
const deleteRoutes = require('./routes/delete');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/auth', authRoutes);
app.use('/api', deleteRoutes);

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function startup() {
  try {
    console.log('Starting Nest Runtime Tracker...');
    
    // Initialize database
    await initDatabase();
    console.log('✓ Database initialized');
    
    // Recover any active sessions from database
    await recoverActiveSessions();
    console.log('✓ Active sessions recovered');
    
    // Start Pub/Sub listener
    await startPubSubListener();
    console.log('✓ Pub/Sub listener started');
    
    // Start Express server
    app.listen(PORT, () => {
      console.log(`✓ Server running on port ${PORT}`);
      console.log('Application ready!');
    });
  } catch (error) {
    console.error('Failed to start application:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  const pool = getPool();
  await pool.end();
  process.exit(0);
});

startup();
