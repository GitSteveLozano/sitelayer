-- 032_labor_burden.sql
--
-- Labor burden columns for the fm-today-v2 "today's burden so far"
-- card and the Phase 2 owner-side cost rollups.
--
-- The design's headline figure ($724 = 13.4 crew-hrs × $54.20/hr loaded
-- with "9% under plan") needs three things the schema doesn't have yet:
--
--   1. Per-worker base hourly rate. Workers had `name` + `role` only.
--   2. Per-worker burden multipliers (insurance %, benefits %, OT premium).
--      Real construction shops vary these worker-by-worker.
--   3. Per-project daily budget so "% under plan" has a denominator.
--
-- Burden formula (computed in @sitelayer/domain so the worker + API both
-- use the same one):
--
--   loaded_hourly = base_hourly * (1 + insurance_pct/100 + benefits_pct/100)
--   ot_loaded     = loaded_hourly * (1 + ot_premium_pct/100)
--
--   straight_hours_dollars = loaded_hourly * straight_hours
--   ot_dollars             = ot_loaded * ot_hours
--   total_burden           = straight_hours_dollars + ot_dollars
--
-- Defaults are chosen so existing rows produce sane numbers:
--   - insurance_pct  20    (~industry average general liability + WC)
--   - benefits_pct    8    (PTO accrual + light benefits)
--   - ot_premium_pct 50    (time-and-a-half over 8h/day)
--   - base_hourly_cents 0  (no rate set; UI shows "—" until configured)
--
-- daily_budget_cents on projects defaults to 0 ("no budget set" — the
-- UI surfaces "no plan set" instead of pretending there is one).
--
-- All columns are integers/numeric — no jsonb here, the values are
-- aggregated on every render.

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS base_hourly_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurance_pct numeric(5, 2) NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS benefits_pct numeric(5, 2) NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS ot_premium_pct numeric(5, 2) NOT NULL DEFAULT 50,
  ADD CONSTRAINT workers_base_hourly_cents_chk CHECK (base_hourly_cents >= 0),
  ADD CONSTRAINT workers_insurance_pct_chk CHECK (insurance_pct >= 0 AND insurance_pct <= 200),
  ADD CONSTRAINT workers_benefits_pct_chk CHECK (benefits_pct >= 0 AND benefits_pct <= 200),
  ADD CONSTRAINT workers_ot_premium_pct_chk CHECK (ot_premium_pct >= 0 AND ot_premium_pct <= 200);

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS daily_budget_cents integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT projects_daily_budget_cents_chk CHECK (daily_budget_cents >= 0);
