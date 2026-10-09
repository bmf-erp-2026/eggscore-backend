-- migration-push-notifications.sql
-- Oct 9 2026 — Push notifications for the customer portal (installed PWA).
--
-- Three new tables, nothing existing is altered:
--   push_subscriptions  one row per customer DEVICE that said "yes" to
--                       notifications (the address the phone's browser gave us)
--   push_sent           one row per message actually sent to a device — used to
--                       (a) never send the same automatic message twice and
--                       (b) cap how many promo-type messages one device gets a week
--   push_log            one row per campaign (broadcast or automatic run) so the
--                       Owner can see what went out and how many devices got it
--
-- Run in the Supabase SQL editor BEFORE deploying the updated backend.
-- Safe to run more than once (everything is IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id               SERIAL PRIMARY KEY,
  endpoint         TEXT NOT NULL UNIQUE,          -- the device's unique push address
  p256dh           TEXT NOT NULL,                 -- encryption key from the device
  auth             TEXT NOT NULL,                 -- encryption secret from the device
  customer_id      INTEGER REFERENCES customers(id),
  customer_name    TEXT,
  language         TEXT NOT NULL DEFAULT 'en',    -- 'en' or 'pcm' (Pidgin)
  user_agent       TEXT,
  active           BOOLEAN NOT NULL DEFAULT true, -- false once the device unsubscribes or the address dies
  failure_count    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_success_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_push_subs_customer ON push_subscriptions(customer_id);
CREATE INDEX IF NOT EXISTS idx_push_subs_active   ON push_subscriptions(active);

CREATE TABLE IF NOT EXISTS push_sent (
  id               SERIAL PRIMARY KEY,
  subscription_id  INTEGER NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,                 -- order_update | reminder | winback | broadcast | test
  dedupe_key       TEXT,                          -- e.g. 'order:BEL-ORD-261012-101010:in_transit'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A given device can only ever receive a given dedupe_key once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_sent_dedupe
  ON push_sent(subscription_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_push_sent_recent ON push_sent(subscription_id, created_at);

CREATE TABLE IF NOT EXISTS push_log (
  id               SERIAL PRIMARY KEY,
  kind             TEXT NOT NULL,                 -- broadcast | reminder | winback | order_update | test
  title_en         TEXT,
  body_en          TEXT,
  title_pcm        TEXT,
  body_pcm         TEXT,
  audience         TEXT,
  targeted         INTEGER NOT NULL DEFAULT 0,    -- devices we tried
  delivered        INTEGER NOT NULL DEFAULT 0,    -- devices the push service accepted
  failed           INTEGER NOT NULL DEFAULT 0,
  created_by       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_log_created ON push_log(created_at DESC);

-- Automatic-message switches live in the existing key/value `settings` table
-- under the key 'push_settings' (created on first save from the ERP screen).
-- Until then the backend uses safe defaults (everything on, reminders at 4 PM
-- Lagos time, at most 3 promo-type messages per device per week).
