-- migration-staff-hours-until.sql
-- Oct 15 2026 — the Owner's late permission now has an end time.
--
--   staff_hours_exceptions.until_min  minutes after midnight, Lagos time, when the permission ends
--                                     (1200 = 8:00 PM). Rows saved before this change have no value
--                                     and keep their old meaning: until midnight.
--
-- Additive and safe to run more than once. The code works with or without it.
ALTER TABLE staff_hours_exceptions ADD COLUMN IF NOT EXISTS until_min INTEGER;
