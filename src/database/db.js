const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 20,
      min: 2,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      statement_timeout: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    });

    pool.on('error', (err, client) => {
      console.error('Unexpected error on idle client', err);
    });

    if (process.env.LOG_POOL_STATS === 'true') {
      setInterval(() => {
        console.log('Pool stats:', {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount
        });
      }, 60000);
    }
  }
  return pool;
}

async function initDatabase() {
  const pool = getPool();
  
  const client = await pool.connect();
  try {
    await client.query('SELECT NOW()');
    console.log('Database connection successful');
    console.log(`Pool config: max=${pool.options.max}, min=${pool.options.min}`);
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('Database pool closed');
  }
}

module.exports = { getPool, initDatabase, closePool };