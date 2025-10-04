const { Pool } = require(‘pg’);

let pool;

function getPool() {
if (!pool) {
pool = new Pool({
connectionString: process.env.DATABASE_URL,
ssl: process.env.NODE_ENV === ‘production’ ? { rejectUnauthorized: false } : false,

```
  // Connection pool limits for scalability
  max: 20, // Maximum number of clients in the pool
  min: 2, // Minimum number of clients to keep alive
  
  // Connection timeouts
  connectionTimeoutMillis: 5000, // How long to wait for a connection
  idleTimeoutMillis: 30000, // How long a client can be idle before being closed
  
  // Keep connections alive
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  
  // Statement timeout to prevent long-running queries
  statement_timeout: 10000, // 10 second timeout for queries
});

// Log pool errors
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
});

// Monitor pool metrics
pool.on('connect', () => {
  console.log('New database connection established');
});

pool.on('remove', () => {
  console.log('Database connection removed from pool');
});
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

```
// Log pool status
console.log(`Pool status: ${pool.totalCount} total, ${pool.idleCount} idle, ${pool.waitingCount} waiting`);
```

} finally {
client.release();
}
}

// Get pool metrics for monitoring
function getPoolMetrics() {
if (!pool) return null;

return {
total: pool.totalCount,
idle: pool.idleCount,
waiting: pool.waitingCount
};
}

module.exports = { getPool, initDatabase, getPoolMetrics };