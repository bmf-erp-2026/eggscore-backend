-- migration-followup-kinds.sql
-- Oct 13 2026 — lets order_followups hold address and delivery-day change requests as well as crate changes.
-- One new column; nothing existing is altered or removed. Safe to run more than once.
--   detail  a small JSON note for the request: for a day change the weekday the customer asked for, whether the
--           request was LATE (after 3 PM the day before delivery, or on the day), the delivery date at the time,
--           the old address or day, a proposed new address and who proposed it, and who approved.
ALTER TABLE order_followups ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}'::jsonb;
