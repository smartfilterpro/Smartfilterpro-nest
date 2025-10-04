const { Pool } = require(‘pg’);

let pool;

function getPool() {
if (!pool) {
pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: process.env.NODE_ENV === ‘production’ ? { rejectUnauthorized: false } : false,
// Connection pool limits for scalability
max: 20, // Maximum number of connections in the pool
min: 2, // Minimum number of connections to maintain
idleTimeoutMillis: 30000, // Close idle connections after 30 seconds
connectionTimeoutMillis: 10000, // Fail fast if can’t get connection in 10 seconds
// Query timeout
statement_timeout: 30000, // 30 second query timeout
// Keep-alive settings
keepAlive: true,
keepAliveInitialDelayMillis: 10000
});

```
// Error handler for pool
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
});

// Log pool statistics periodically (optional, for monitoring)
if (process.env.LOG_POOL_STATS === 'true') {
  setInterval(() => {
    console.log('Pool stats:', {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount
    });
  }, 60000); // Every minute
}
```

}
return pool;
}

async function initDatabase() {
const pool = getPool();

// Test connection
const client = await pool.connect();
try {
await client.query(‘SELECT NOW()’);
console.log(‘Database connection successful’);
console.log(`Pool config: max=${pool.options.max}, min=${pool.options.min}`);
} finally {
client.release();
}
}

// Graceful shutdown helper
async function closePool() {
if (pool) {
await pool.end();
pool = null;
console.log(‘Database pool closed’);
}
}

module.exports = { getPool, initDatabase, closePool };