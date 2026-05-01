-- 036_assemblies.sql
--
-- Scope-item assemblies (Phase 3F). PlanSwift's killer feature.
--
-- A scope item like "EPS @ $4.85/sqft" is a flat rate today. The
-- real cost is materials + waste % + labor hours + freight, and
-- estimators think in those components. An assembly attaches that
-- composite to a service_item_code so the takeoff still surfaces a
-- single unit rate for speed but estimators can crack open the
-- assembly to adjust the underlying components.
--
-- This is also the data model that connects takeoff → estimate →
-- bill cleanly: an assembly's components are what flow into the
-- material_bills entries when the project ships.
--
-- Two tables:
--   service_item_assemblies — header (one per assembly, named)
--   service_item_assembly_components — line items per assembly
--
-- An assembly is per-company (companies bid different shapes).
-- A service_item can have at most one current assembly; older
-- versions stay around via deleted_at for the audit trail.

CREATE TABLE IF NOT EXISTS service_item_assemblies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  service_item_code text NOT NULL,
  name text NOT NULL,
  description text,
  /** Total per-unit rate. Cached from the sum of components. */
  total_rate numeric(12, 4) NOT NULL DEFAULT 0,
  unit text NOT NULL DEFAULT 'sqft',
  origin text DEFAULT current_setting('app.tier', true),
  deleted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_item_assemblies_active_idx
  ON service_item_assemblies (company_id, service_item_code)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS service_item_assembly_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  assembly_id uuid NOT NULL REFERENCES service_item_assemblies(id) ON DELETE CASCADE,
  /** What kind of component: material / labor / sub / freight. */
  kind text NOT NULL,
  name text NOT NULL,
  /** Per-unit-of-assembly quantity (e.g. 1.05 sqft of EPS per sqft of wall = 5% waste). */
  quantity_per_unit numeric(12, 4) NOT NULL DEFAULT 1,
  unit text NOT NULL,
  /** Cost per unit of THIS component (not per unit of the assembly). */
  unit_cost numeric(12, 4) NOT NULL DEFAULT 0,
  /** Optional waste %, applied multiplicatively after quantity_per_unit. */
  waste_pct numeric(5, 2) NOT NULL DEFAULT 0,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_item_assembly_components_kind_chk
    CHECK (kind IN ('material', 'labor', 'sub', 'freight')),
  CONSTRAINT service_item_assembly_components_qty_chk
    CHECK (quantity_per_unit >= 0),
  CONSTRAINT service_item_assembly_components_cost_chk
    CHECK (unit_cost >= 0),
  CONSTRAINT service_item_assembly_components_waste_chk
    CHECK (waste_pct >= 0 AND waste_pct <= 200)
);

CREATE INDEX IF NOT EXISTS service_item_assembly_components_assembly_idx
  ON service_item_assembly_components (company_id, assembly_id, sort_order);
