-- migration-rep-ownership.sql  (Oct 13 2026)
-- Ties customers to the sales rep who pitched them, records who entered each sale, and keeps a
-- permanent log of every hand-over (a sale moved to another rep, a customer moved to another rep).
-- Safe to run more than once. Run it BEFORE uploading the matching code.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS owner_rep        TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS owner_rep_set_by TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS owner_rep_set_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS customers_owner_rep_idx ON customers (owner_rep);

ALTER TABLE sales ADD COLUMN IF NOT EXISTS entered_by       TEXT;         -- e-mail of the login that recorded the sale
ALTER TABLE sales ADD COLUMN IF NOT EXISTS handed_over_from TEXT;         -- rep the sale was moved away from (latest move)
ALTER TABLE sales ADD COLUMN IF NOT EXISTS handed_over_by   TEXT;         -- Owner who moved it
ALTER TABLE sales ADD COLUMN IF NOT EXISTS handed_over_at   TIMESTAMPTZ;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS handover_reason  TEXT;

CREATE TABLE IF NOT EXISTS rep_handovers (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,            -- 'sale' or 'customer'
  ref         TEXT NOT NULL,            -- the sale's invoice reference, or the customer's name
  subject     TEXT,                     -- customer name (for a sale) or a short note
  from_rep    TEXT,
  to_rep      TEXT NOT NULL,
  reason      TEXT,
  by_email    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rep_handovers_ref_idx ON rep_handovers (kind, ref);
ALTER TABLE rep_handovers ENABLE ROW LEVEL SECURITY;
