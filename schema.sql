-- ═══════════════════════════════════════════════════════════════
-- EggScore Backend — Database Schema (v1, P0 domains only)
--
-- Deliberately NOT a straight copy of the localStorage JSON blobs.
-- Real foreign keys and real types replace the loose objects that
-- worked fine in a single browser but would let two devices quietly
-- disagree about the same order if kept as-is. Written in portable
-- SQL — the same statements run on SQLite (used here for local,
-- zero-account testing) and Postgres/Supabase with only trivial
-- syntax changes (AUTOINCREMENT -> SERIAL, noted inline).
-- ═══════════════════════════════════════════════════════════════

-- Customers — referenced by orders, not duplicated inside them
CREATE TABLE IF NOT EXISTS customers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- Postgres: SERIAL PRIMARY KEY
  cid           TEXT UNIQUE NOT NULL,                -- BEL-CID-YYMMDD-HHMMSS, matches existing ERP convention
  name          TEXT NOT NULL,
  phone         TEXT,
  location      TEXT,
  loyalty_tier  TEXT DEFAULT 'New',
  credit_limit  REAL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- Batches — real stock, drawn down by FIFO the same way the ERP already does
CREATE TABLE IF NOT EXISTS batches (
  id            TEXT PRIMARY KEY,       -- e.g. 'B036', matches existing batch ID convention
  supplier      TEXT,
  cost          REAL NOT NULL,
  received      INTEGER NOT NULL,
  remaining     INTEGER NOT NULL,
  qa_grade      TEXT,
  received_date TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Orders — the core P0 record. A real foreign key to customers,
-- not a customer name typed into a JSON blob every time.
CREATE TABLE IF NOT EXISTS orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ref                 TEXT UNIQUE NOT NULL,           -- BEL-ORD-YYMMDD-HHMMSS
  customer_id         INTEGER REFERENCES customers(id),
  customer_name       TEXT NOT NULL,                  -- kept redundantly for orders predating a matched customer
  phone               TEXT,
  location             TEXT,
  crates              INTEGER NOT NULL,
  egg_price_per_crate REAL NOT NULL,
  delivery_per_crate  REAL NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|in_transit|delivered|fulfilled|cancelled|rejected
  payment_verified    INTEGER NOT NULL DEFAULT 0,       -- boolean as 0/1 for SQLite; Postgres: BOOLEAN
  batch_id            TEXT REFERENCES batches(id),
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

-- Funnel events — the actual reason this whole backend got started.
-- One row per meaningful step, not an aggregate — lets you compute
-- any funnel shape later (step-to-step drop-off, time between steps,
-- which step a specific visitor abandoned at) without having decided
-- the exact funnel shape in advance.
CREATE TABLE IF NOT EXISTS funnel_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL,      -- one random ID per browser session, generated client-side, no personal data
  event_type    TEXT NOT NULL,      -- 'viewed_form' | 'set_crates' | 'reached_checkout' | 'submitted_order' | 'blocked_cap'
  order_ref     TEXT,               -- populated once/if the session results in a real order
  crates        INTEGER,
  metadata      TEXT,               -- small JSON blob for event-specific detail, deliberately NOT the whole record
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_funnel_session ON funnel_events(session_id);
CREATE INDEX IF NOT EXISTS idx_funnel_type ON funnel_events(event_type);

-- Sales Ledger — the fulfilled/recorded side, distinct from an order
-- still in progress. Mirrors the existing Sales Log's real fields.
CREATE TABLE IF NOT EXISTS sales (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref         TEXT REFERENCES orders(ref),
  rep               TEXT NOT NULL,
  customer_id       INTEGER REFERENCES customers(id),
  customer_name     TEXT NOT NULL,
  crates            INTEGER NOT NULL,
  price_per_crate   REAL NOT NULL,
  gross             REAL NOT NULL,
  delivery_total    REAL NOT NULL DEFAULT 0,
  commission        REAL NOT NULL DEFAULT 0,
  batch_id          TEXT REFERENCES batches(id),
  batch_cost        REAL,
  payment_method    TEXT NOT NULL,       -- cash|transfer|credit7|credit30|part
  settled_at        TEXT,
  fully_reversed    INTEGER NOT NULL DEFAULT 0,
  reversal_reason   TEXT,
  sale_date         TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_rep ON sales(rep);

-- API keys — the real auth layer that never existed before. Two
-- roles: the ERP (full access) and the customer portal (can only
-- create orders/events, never read financial data). This is a new
-- concept, not a migration of anything that existed client-side.
CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash    TEXT UNIQUE NOT NULL,     -- SHA-256 of the actual key; the raw key is never stored
  role        TEXT NOT NULL,            -- 'erp' | 'portal'
  label       TEXT,                     -- human-readable, e.g. "Bob's ERP laptop"
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
