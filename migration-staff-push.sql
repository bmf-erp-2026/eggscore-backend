-- Oct 12 2026 — Staff alerts: a push notification to staff devices ("New customer
-- message") that works even when the ERP is closed. One row per staff DEVICE that
-- tapped "Turn on message alerts" in the ERP sidebar. Staff devices are kept apart
-- from the customer table (push_subscriptions) on purpose: a staff alert can never
-- reach a customer's phone and a customer broadcast can never reach a staff device.
-- Safe to run more than once.
CREATE TABLE IF NOT EXISTS staff_push_subscriptions (
  id               SERIAL PRIMARY KEY,
  endpoint         TEXT NOT NULL UNIQUE,          -- the device's unique push address
  p256dh           TEXT NOT NULL,                 -- encryption key from the device
  auth             TEXT NOT NULL,                 -- encryption secret from the device
  user_email       TEXT,                          -- which staff member turned it on
  role             TEXT,                          -- owner / rep / etc. at the time
  user_agent       TEXT,
  active           BOOLEAN NOT NULL DEFAULT true, -- false once switched off or the address dies
  failure_count    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_staff_push_active ON staff_push_subscriptions (active);
ALTER TABLE staff_push_subscriptions ENABLE ROW LEVEL SECURITY;
