-- migration-eod-reports.sql
-- Oct 12 2026 — End-of-Day reports. Two new tables; nothing existing is altered.
--
--   eod_reports     one row per staff member per Lagos working day: who, which day, whether it
--                   was filed on time (before 6:00 PM) or late (6:00 to 6:30 PM, or later if the
--                   Owner allowed late access), or excused by the Owner. The report itself (the
--                   day's figures, issues, cash and stock handover, LOOKAHEAD, anything else) is
--                   kept in one JSON column so a new section can be added later without changing
--                   the table.
--   eod_digest_log  one row per day once the 6:30 PM summary alert has gone to the Owner, so a
--                   server restart can never send it twice.
--
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS eod_reports (
  id                  SERIAL PRIMARY KEY,
  day                 DATE NOT NULL,                       -- the Lagos calendar day the report is for
  email               TEXT NOT NULL,                       -- stored lower-case
  name                TEXT,
  role                TEXT,
  status              TEXT NOT NULL,                       -- on_time | late | excused
  first_submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(), -- decides on time or late; never changes
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  data                JSONB NOT NULL DEFAULT '{}'::jsonb,
  excused_by          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eod_reports_email_day ON eod_reports(email, day);
CREATE INDEX IF NOT EXISTS idx_eod_reports_day ON eod_reports(day);
ALTER TABLE eod_reports ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS eod_digest_log (
  day       DATE PRIMARY KEY,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expected  INTEGER,
  filed     INTEGER
);
ALTER TABLE eod_digest_log ENABLE ROW LEVEL SECURITY;
