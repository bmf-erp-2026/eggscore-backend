-- migration-drafts-followups.sql
-- Oct 13 2026 — two new tables; nothing existing is altered. Safe to run more than once.
--
--   eod_drafts       what a staff member has saved in today's End-of-Day report BEFORE filing it:
--                    the form as it stands, plus a timestamped log of issues written down as they
--                    happened. One row per person per Lagos day. Deleted when the report is filed
--                    (the issues move into the filed report). The Owner can read drafts in Daily
--                    Reports, so an issue is not lost if the report is never filed.
--   order_followups  something a customer asked for AFTER ordering that staff must act on and that
--                    must not be forgotten (today: a change in crates). Opened automatically when a
--                    customer message looks like a volume change, or by staff. While one is open,
--                    the order cannot be dispatched, waybilled or closed. Closed only by a recorded
--                    outcome: applied, moved to a new order, or declined, each with the customer told.
CREATE TABLE IF NOT EXISTS eod_drafts (
  id          SERIAL PRIMARY KEY,
  day         DATE NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  data        JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eod_drafts_email_day ON eod_drafts(email, day);
CREATE INDEX IF NOT EXISTS idx_eod_drafts_day ON eod_drafts(day);
ALTER TABLE eod_drafts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS order_followups (
  id            SERIAL PRIMARY KEY,
  order_ref     TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'volume_change',
  status        TEXT NOT NULL DEFAULT 'open',      -- open | applied | new_order | declined | dismissed
  crates        INTEGER,                           -- crates the customer asked to add (negative = remove); NULL if no number was given
  order_crates_at_open INTEGER,                    -- the order's crates when this was opened; 'applied' is only accepted once the order's crates differ from this
  source        TEXT NOT NULL DEFAULT 'auto',      -- auto (found in a customer message) | staff
  source_text   TEXT,                              -- the customer's words that opened it
  opened_by     TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by   TEXT,
  resolved_at   TIMESTAMPTZ,
  note          TEXT                               -- what was done / why declined
);
CREATE INDEX IF NOT EXISTS idx_order_followups_ref ON order_followups(order_ref);
CREATE INDEX IF NOT EXISTS idx_order_followups_open ON order_followups(status) WHERE status = 'open';
ALTER TABLE order_followups ENABLE ROW LEVEL SECURITY;
