-- Oct 15 2026 — Portal part payment, Stage 2.
-- A customer on the portal can REQUEST part payment on an order; the Owner confirms or declines each one.
-- The figures live here, NOT on the orders table, because the order lookup (GET /orders/:ref) can be read with the
-- portal key and a balance figure would give away part of the margin. Only the Owner's screen reads this table.
CREATE TABLE IF NOT EXISTS part_payments (
  order_ref     text PRIMARY KEY,
  customer_name text NOT NULL,
  level         text NOT NULL,                      -- the customer's Trust Tier when they asked
  status        text NOT NULL DEFAULT 'requested',  -- requested | confirmed | declined
  pay_now       numeric NOT NULL DEFAULT 0,         -- egg share due now PLUS delivery, naira
  balance       numeric NOT NULL DEFAULT 0,         -- the deferred share of the margin, naira (Owner only)
  days          integer NOT NULL DEFAULT 7,         -- days allowed for the balance
  due_date      text,                               -- set when confirmed (YYYY-MM-DD)
  requested_at  timestamptz NOT NULL DEFAULT now(),
  decided_by    text,
  decided_at    timestamptz,
  note          text
);
ALTER TABLE part_payments ENABLE ROW LEVEL SECURITY;
