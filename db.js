'use strict';
const { Pool } = require('pg');

function createPool() {
  const ENABLE_DATABASE = process.env.ENABLE_DATABASE !== '0';
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!ENABLE_DATABASE || !DATABASE_URL) return null;

  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
    max: parseInt(process.env.DB_MAX_CONNECTIONS || '10', 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) => console.error('Database pool error:', err.message));
  return pool;
}

module.exports = { createPool };
