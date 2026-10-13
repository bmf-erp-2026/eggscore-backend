-- migration-attendance.sql
-- Oct 13 2026 — staff clock-in / clock-out record. One new table; nothing existing is altered.
--
--   staff_attendance  one row per staff member per Lagos day: the first time the ERP saw them that day
--                     (clock-in), the last time it saw them active, and the moment they signed out
--                     (Log Out, the idle lock or the 6:30 PM automatic sign-out). The Owner reads it
--                     inside Daily Reports. If someone just closes the browser, the last-seen time
--                     stands in for the clock-out.
--
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS staff_attendance (
  id             SERIAL PRIMARY KEY,
  day            DATE NOT NULL,                              -- the Lagos calendar day
  email          TEXT NOT NULL,                              -- stored lower-case
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),         -- clock-in; never changes
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_out_at  TIMESTAMPTZ,                                -- NULL while signed in (or closed without signing out)
  pings          INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_attendance_email_day ON staff_attendance(email, day);
CREATE INDEX IF NOT EXISTS idx_staff_attendance_day ON staff_attendance(day);
ALTER TABLE staff_attendance ENABLE ROW LEVEL SECURITY;
