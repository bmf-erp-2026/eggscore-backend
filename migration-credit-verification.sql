-- migration-credit-verification.sql  (Oct 14 2026, queue item C — credit-onboarding verification)
-- The Owner must confirm a customer's shop (visited) and phone (reaches them) before the customer can be given credit
-- terms or moved up a tier. Customers who already had trade history (or a trust tier above New) when this runs are
-- marked "grandfathered" ONCE and keep what they have. Safe to run more than once: the grandfathering only happens
-- the first time, when the column is created.
-- Run it BEFORE uploading the matching code.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'verify_grandfathered') THEN
    ALTER TABLE customers ADD COLUMN verify_grandfathered BOOLEAN NOT NULL DEFAULT false;
    UPDATE customers SET verify_grandfathered = true
     WHERE id IN (SELECT DISTINCT customer_id FROM sales WHERE customer_id IS NOT NULL)
        OR name IN (SELECT DISTINCT customer_name FROM sales WHERE customer_name IS NOT NULL)
        OR COALESCE(trust_tier, 'new') <> 'new';
  END IF;
END $$;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS shop_verified_at   TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS shop_verified_by   TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS shop_verified_note TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_verified_at   TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_verified_by   TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_verified_note TEXT;
