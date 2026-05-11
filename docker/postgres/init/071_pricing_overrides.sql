-- 071_pricing_overrides.sql
--
-- Adds per-service-item rate overrides for the pricing chain resolver:
--   project_pricing_overrides → customer_pricing_overrides
--     → company_pricing_overrides → qbo item rate → service_items.default_rate
--
-- Why three tables (project / customer / company) instead of one polymorphic
-- table: each scope has different referential integrity (project FK on hard
-- delete should cascade differently than customer; companies are tenant-root
-- already), and the unique constraint per scope is cleaner. The resolver
-- joins all three in a single CTE so the query cost is the same as a single
-- polymorphic table with a `scope` column.
--
-- Each row carries an explicit `unit` so an override can specify a different
-- billing unit (e.g. the project negotiated "per hour" instead of the
-- catalog default "per sqft"). The resolver returns whatever the matching
-- row's unit is so estimate lines stay self-consistent.

CREATE TABLE IF NOT EXISTS project_pricing_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_item_code text NOT NULL,
  rate numeric(12,2) NOT NULL,
  unit text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, project_id, service_item_code)
);

CREATE INDEX IF NOT EXISTS project_pricing_overrides_lookup_idx
  ON project_pricing_overrides (company_id, project_id, service_item_code)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_pricing_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  service_item_code text NOT NULL,
  rate numeric(12,2) NOT NULL,
  unit text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, customer_id, service_item_code)
);

CREATE INDEX IF NOT EXISTS customer_pricing_overrides_lookup_idx
  ON customer_pricing_overrides (company_id, customer_id, service_item_code)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS company_pricing_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  service_item_code text NOT NULL,
  rate numeric(12,2) NOT NULL,
  unit text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, service_item_code)
);

CREATE INDEX IF NOT EXISTS company_pricing_overrides_lookup_idx
  ON company_pricing_overrides (company_id, service_item_code)
  WHERE deleted_at IS NULL;
