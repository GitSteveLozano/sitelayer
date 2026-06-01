-- 124_service_item_pricing_detail.sql
--
-- Mobile pricing-item detail (msg__85 "EPS BOARD · 2\"" — U11). The detail
-- screen wants three facts the `service_items` table never carried:
--
--   1. LABOR MULTIPLIER ("1.25× STD INSTALL") — a per-item productivity factor
--      on top of the catalog rate. Additive, NOT NULL DEFAULT 1.0 so every
--      legacy item reads as a neutral 1× until an estimator tunes it.
--   2. STATUS ("ACTIVE / SEASONAL / RETIRED") — a lifecycle marker distinct
--      from soft-delete (`deleted_at`): a SEASONAL/RETIRED item is still a real
--      catalog row, just not actively quoted. NOT NULL DEFAULT 'active'.
--   3. CURRENT-COST HISTORY ("WAS $3.20 (MAR) · $2.95 (JAN) · UP 17% YTD") — a
--      per-rate-change ledger so the detail screen can render the cost trail
--      without replaying the mutation_outbox / audit log.
--
-- Expand/backfill only (CLAUDE.md deploy rule 2: migrations are immutable once
-- committed; schema changes land as new forward files). Next unused prefix
-- after 123_blueprint_page_scale_verified.sql. No data change to existing rows
-- beyond the column defaults.

ALTER TABLE service_items
  ADD COLUMN IF NOT EXISTS labor_multiplier numeric(6,3) NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';

-- Lifecycle status is a small closed set. Added as NOT VALID-free CHECK because
-- the DEFAULT guarantees every existing row already satisfies it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'service_items_status_check'
  ) THEN
    ALTER TABLE service_items
      ADD CONSTRAINT service_items_status_check
      CHECK (status IN ('active', 'seasonal', 'retired'));
  END IF;
END $$;

-- Per-rate-change cost history. One row is appended whenever an item's
-- default_rate changes (PATCH / restore in routes/service-items.ts). The detail
-- screen reads the most-recent N rows to render the "WAS $X (MON)" trail and the
-- YTD delta. recorded_at is the change time; rate/unit snapshot the value that
-- was in effect AFTER the change.
CREATE TABLE IF NOT EXISTS service_item_rate_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  service_item_code text NOT NULL,
  rate numeric(12,2),
  unit text NOT NULL DEFAULT 'ea',
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_item_rate_history_code_recent_idx
  ON service_item_rate_history (company_id, service_item_code, recorded_at DESC);

DROP POLICY IF EXISTS company_isolation ON service_item_rate_history;
CREATE POLICY company_isolation ON service_item_rate_history
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

ALTER TABLE service_item_rate_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_item_rate_history FORCE ROW LEVEL SECURITY;
