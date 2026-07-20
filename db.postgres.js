// db.postgres.js — the real Supabase/Postgres connection for production.
//
// Provides the same .prepare(sql).run()/.get()/.all() shape the SQLite
// version (db.js) used, so route files don't need a different query
// style. BUT — and this matters, correcting what the original README
// implied — Postgres is inherently asynchronous where SQLite (via
// better-sqlite3) was synchronous. Every call site now needs `await`.
// That IS a real change to the route files, not just this file — see
// MIGRATION-NOTES.md for exactly what changed and why.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Converts SQLite-style '?' placeholders to Postgres-style $1, $2...
// so the actual SQL strings in route files never had to be rewritten.
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// INSERT statements need RETURNING id to get the new row's id back —
// SQLite gives this for free via lastInsertRowid, Postgres doesn't.
// Adding it here, once, means route files didn't need each INSERT
// hand-edited individually.
function ensureReturningId(sql) {
  const isInsert = /^\s*INSERT/i.test(sql);
  const alreadyHasReturning = /RETURNING/i.test(sql);
  if(isInsert && !alreadyHasReturning) return sql.trim().replace(/;?\s*$/, '') + ' RETURNING id';
  return sql;
}

const db = {
  prepare(sql) {
    const pgSql = ensureReturningId(toPgPlaceholders(sql));
    return {
      async run(...params) {
        const result = await pool.query(pgSql, params);
        return {
          lastInsertRowid: result.rows[0]?.id,
          changes: result.rowCount,
        };
      },
      async get(...params) {
        const result = await pool.query(pgSql, params);
        return result.rows[0];
      },
      async all(...params) {
        const result = await pool.query(pgSql, params);
        return result.rows;
      },
    };
  },
  async exec(sql) {
    await pool.query(sql);
  },
  pool, // exposed for direct use / graceful shutdown if ever needed
};

function initSchema() {
  // Schema is applied once via `psql -f schema.postgres.sql` during
  // setup (see MIGRATION-NOTES.md) — not run automatically on every
  // server boot the way the SQLite version did, since running DDL
  // against a live production database on every restart is a real risk
  // the local-dev version didn't have to worry about.
}

module.exports = { db, initSchema };
