-- migration-staff-hours.sql
-- Oct 12 2026 — Staff working hours (Mon-Sat 06:00 to 18:30 Lagos time) and the Owner's
-- one-day exceptions. One new table; nothing existing is altered.
--
--   staff_hours_exceptions  one row = "this staff member may work outside the usual hours on
--                           this Lagos calendar day". It lapses by itself at midnight (the
--                           server only looks for a row dated today) and can be revoked by
--                           the Owner at any time.
--
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS staff_hours_exceptions (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL,                       -- stored lower-case
  day         DATE NOT NULL,                       -- the Lagos calendar day it applies to
  note        TEXT,
  granted_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_hours_exc_unique ON staff_hours_exceptions(email, day);
ALTER TABLE staff_hours_exceptions ENABLE ROW LEVEL SECURITY;
