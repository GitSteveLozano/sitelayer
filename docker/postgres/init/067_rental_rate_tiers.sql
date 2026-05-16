-- Tiered rental pricing — Avontus parity.
--
-- Today every job_rental_lines row has a single (agreed_rate, rate_unit).
-- Real rental shops price by duration: 1-7 days at the daily rate,
-- 8-30 days at a discounted weekly rate, 31+ at the monthly rate. The
-- existing `rate_unit` column accepts 'day'/'week'/'month' but only one
-- value can be active per line.
--
-- rental_rate_tiers makes the pricing structure first-class. A line
-- may have zero tiers (uses agreed_rate as the fallback, today's
-- behavior) or several non-overlapping tiers keyed by billable-days
-- ranges. The domain helper `pickRentalTierRate()` walks the list and
-- picks the row whose [min_days, max_days] window contains the
-- billable_days computed during a billing run.
--
-- Tiers are per-line, not per-item, because the same item rented to
-- two different jobs frequently has different commercial terms.

CREATE TABLE IF NOT EXISTS rental_rate_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_rental_line_id uuid NOT NULL REFERENCES job_rental_lines(id) ON DELETE CASCADE,
  /** Unit the tier rate is expressed in: day/week/month/cycle/each. Mirrors job_rental_lines.rate_unit. */
  rate_unit text NOT NULL,
  /** Inclusive lower bound on billable_days. Must be >= 1. */
  min_days int NOT NULL,
  /** Inclusive upper bound on billable_days. NULL means unbounded (matches all longer rentals). */
  max_days int,
  /** Per-unit rate at this tier. Replaces the line's agreed_rate when this tier wins. */
  rate numeric(12, 2) NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  origin text DEFAULT current_setting('app.tier', true),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rental_rate_tiers_unit_chk
    CHECK (rate_unit IN ('day', 'week', 'month', 'cycle', 'each')),
  CONSTRAINT rental_rate_tiers_min_days_chk CHECK (min_days >= 1),
  CONSTRAINT rental_rate_tiers_range_chk CHECK (max_days IS NULL OR max_days >= min_days),
  CONSTRAINT rental_rate_tiers_rate_chk CHECK (rate >= 0)
);

CREATE INDEX IF NOT EXISTS rental_rate_tiers_line_idx
  ON rental_rate_tiers (company_id, job_rental_line_id, sort_order);

-- RLS policy (shadow mode — see migration 066).
DROP POLICY IF EXISTS company_isolation ON rental_rate_tiers;
CREATE POLICY company_isolation ON rental_rate_tiers
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());
