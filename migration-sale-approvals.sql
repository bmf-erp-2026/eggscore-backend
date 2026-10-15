-- Oct 15 2026 — Owner approval for a sale that did not come through the Orders Inbox.
-- A staff member who records a sale in Record Sale or Quick Entry, when the sale has no order behind it (or has an order that
-- skipped the Orders Inbox checks), sends a request here. The sale is held until the Owner approves it on the Owner's device.
-- Nothing else reads or depends on this table; the sale itself is saved the ordinary way afterwards.
CREATE TABLE IF NOT EXISTS sale_approvals (
  id                 serial PRIMARY KEY,
  requested_by       text NOT NULL,                      -- login email of the staff member
  rep_name           text,
  customer_name      text NOT NULL,
  crates             integer NOT NULL,
  price_per_crate    numeric NOT NULL DEFAULT 0,         -- egg price per crate, naira
  delivery_per_crate numeric NOT NULL DEFAULT 0,
  payment            text,                               -- the payment status chosen on the form
  kind               text NOT NULL DEFAULT 'no_order',   -- no_order | skipped_inbox
  order_ref          text,                               -- the live order the sale would have linked to, if any
  status             text NOT NULL DEFAULT 'pending',    -- pending | approved | declined | used
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         text,
  decided_at         timestamptz,
  decline_reason     text,
  used_at            timestamptz,
  inv_ref            text                                -- the invoice the approval was used for
);
CREATE INDEX IF NOT EXISTS sale_approvals_status_idx ON sale_approvals (status, requested_at DESC);
CREATE INDEX IF NOT EXISTS sale_approvals_by_idx ON sale_approvals (requested_by, requested_at DESC);
ALTER TABLE sale_approvals ENABLE ROW LEVEL SECURITY;
