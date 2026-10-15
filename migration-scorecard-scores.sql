-- migration-scorecard-scores.sql
-- Oct 15 2026 — the ERP now sends each customer's Customer Scorecard result to the server, so the portal's
-- patronage ticker and the "suggested Trust Tier" logic can use the same score the Owner sees in Customer Scores.
--
--   customers.scorecard_score         final score (0-100): 70% objective + 30% relationship
--   customers.scorecard_objective     objective part (on-time payment, frequency, slow-day buying, tenure, minus penalties)
--   customers.scorecard_relationship  relationship part (advocacy, feedback, communication, respect, tags)
--   customers.scorecard_at            when the Owner's ERP last sent it
--
-- Additive and safe to run more than once. The code works with or without it.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS scorecard_score        INTEGER,
  ADD COLUMN IF NOT EXISTS scorecard_objective    INTEGER,
  ADD COLUMN IF NOT EXISTS scorecard_relationship INTEGER,
  ADD COLUMN IF NOT EXISTS scorecard_at           TIMESTAMPTZ;
