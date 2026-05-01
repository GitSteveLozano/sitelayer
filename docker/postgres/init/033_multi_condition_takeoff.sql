-- 033_multi_condition_takeoff.sql
--
-- Multi-Condition Takeoff (Phase 3A) — the highest-impact takeoff
-- change in the design brief. One physical polygon (e.g. an EIFS
-- wall) carries multiple scope items (EPS + basecoat + finish + air
-- barrier), each with its own quantity and rate.
--
-- Today `takeoff_measurements` has a single `service_item_code`
-- column. This migration adds a 1:N `takeoff_measurement_tags`
-- table; each tag carries its own service_item_code + quantity +
-- unit + rate. The original column stays for backwards compatibility
-- with existing v1 callers — Phase 5 cutover removes the legacy
-- column once both clients write tags exclusively.
--
-- Defaults are constructed so an existing single-tag measurement
-- automatically reads as a one-row tag list (we backfill below).
-- New measurements written by Phase 3A code use the tags table; old
-- measurements continue to render via the legacy column until they
-- get re-saved.

CREATE TABLE IF NOT EXISTS takeoff_measurement_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  measurement_id uuid NOT NULL REFERENCES takeoff_measurements(id) ON DELETE CASCADE,
  service_item_code text NOT NULL,
  -- Quantity for this tag. Usually equals the polygon's geometric
  -- area, but can differ — e.g. caulk only runs the perimeter, so a
  -- caulk tag on a wall polygon carries the LF instead of sqft.
  quantity numeric(14, 4) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'sqft',
  rate numeric(12, 4) NOT NULL DEFAULT 0,
  notes text,
  -- Stable order within a measurement so the UI renders tags in the
  -- order the user added them.
  sort_order int NOT NULL DEFAULT 0,
  origin text DEFAULT current_setting('app.tier', true),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT takeoff_measurement_tags_quantity_chk CHECK (quantity >= 0),
  CONSTRAINT takeoff_measurement_tags_rate_chk CHECK (rate >= 0)
);

CREATE INDEX IF NOT EXISTS takeoff_measurement_tags_measurement_idx
  ON takeoff_measurement_tags (company_id, measurement_id, sort_order);

CREATE INDEX IF NOT EXISTS takeoff_measurement_tags_service_item_idx
  ON takeoff_measurement_tags (company_id, service_item_code);

-- Backfill: every existing measurement gets one tag row mirroring
-- its current single-scope shape. Idempotent because the WHERE
-- skips rows that already have a tag — re-running the migration
-- during testing is safe.
--
-- The legacy `takeoff_measurements` row carries service_item_code,
-- quantity, and unit but not a rate (the rate has always lived on
-- `service_items`). The new tag carries its own rate default of 0;
-- callers writing through the Phase 3 routes set the real rate.
INSERT INTO takeoff_measurement_tags (
  company_id, measurement_id, service_item_code, quantity, unit, rate, sort_order
)
SELECT
  m.company_id,
  m.id,
  m.service_item_code,
  m.quantity,
  m.unit,
  0,
  0
FROM takeoff_measurements m
WHERE NOT EXISTS (
  SELECT 1 FROM takeoff_measurement_tags t
  WHERE t.measurement_id = m.id
)
  AND m.service_item_code IS NOT NULL
  AND m.service_item_code <> '';
