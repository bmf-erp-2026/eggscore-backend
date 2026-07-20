// db.js — SQLite for local/free development and testing, zero external
// account needed to run this today. Every query here is written in
// plain, portable SQL (no SQLite-only syntax beyond AUTOINCREMENT vs
// SERIAL, noted in schema.sql) — swapping to Postgres/Supabase later
// means changing the connection setup in this one file, not rewriting
// the route logic that calls it. See README.md "Swapping to Supabase."
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'eggscore.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // real concurrent read/write safety — the exact protection a browser never had

function initSchema() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);
}

module.exports = { db, initSchema };
