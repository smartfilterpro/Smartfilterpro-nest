'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createPool } = require('../db');

async function main() {
  const pool = createPool();
  if (!pool) {
    console.error('Database disabled or missing DATABASE_URL');
    process.exit(1);
  }
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('✅ Database initialized');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
