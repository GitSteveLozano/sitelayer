-- 109_assembly_explode_and_formulas.sql
--
-- PlanSwift Phase 2 — the parts / assembly engine. "Drag an assembly onto a
-- takeoff and it explodes into material + labor + equipment + sub quantities
-- with formulas and waste."  (docs/PLANSWIFT_PHASE2_PLAN.md §1.)
--
-- This is the EXPAND step. It is forward-only, additive, and idempotent. Every
-- existing row keeps its exact current behavior because all new columns are
-- nullable / defaulted:
--   - takeoff_measurements gains a nullable assembly_id attach point.
--     NULL => the current flat-line behavior; set => the recompute path
--     explodes the assembly into N estimate lines.
--   - service_item_assembly_components gains optional formula columns. A NULL
--     quantity_formula keeps the static quantity_per_unit path (fully backward
--     compatible); a non-NULL one is evaluated against the measurement quantity
--     at explode time.
--   - estimate_lines gains nullable provenance columns (assembly_id,
--     assembly_component_id, kind) so the estimate UI can group exploded lines
--     and the markup breakdown stays attributable. Lines are a FROZEN snapshot
--     at recompute time, so there is no FK from assembly_component_id back to
--     the component table (a later component delete must not cascade-wipe a
--     historical estimate line).
--
-- No new TABLES => no new RLS policies. The three touched tables already have
-- company_isolation ENABLE+FORCE (066/085/101 rollout); new columns inherit the
-- existing row-level policy. Verify with the schema-parity audit after applying.
--
-- Immutability: once committed, this file is checksummed in schema_migrations.
-- Any later correction is a new 110+ file — never edit this one.

-- ---------------------------------------------------------------------------
-- 1a. takeoff_measurements — add the assembly attach point.
-- ---------------------------------------------------------------------------

ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS assembly_id uuid;

-- ON DELETE SET NULL so soft/hard-deleting an assembly never orphans a
-- measurement write — the recompute simply falls back to the flat-line path.
-- NOT VALID skips the full-table scan on a potentially large table; new rows
-- are still checked (no legacy row has a non-null assembly_id). Wrapped in a
-- DO block because Postgres does not support ADD CONSTRAINT IF NOT EXISTS, and
-- the runner may re-apply (idempotent via the duplicate_object guard — same
-- defensive idiom as 101_v2_rls.sql).
DO $$
BEGIN
  ALTER TABLE takeoff_measurements
    ADD CONSTRAINT takeoff_measurements_assembly_fk
    FOREIGN KEY (assembly_id) REFERENCES service_item_assemblies(id) ON DELETE SET NULL
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Partial index for the recompute lookup ("which measurements carry an
-- assembly"). Scoped to the company + active (non-deleted) rows that actually
-- attach one.
CREATE INDEX IF NOT EXISTS takeoff_measurements_assembly_idx
  ON takeoff_measurements (company_id, assembly_id)
  WHERE assembly_id IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 1b. service_item_assembly_components — add optional formula columns.
-- ---------------------------------------------------------------------------

ALTER TABLE service_item_assembly_components
  ADD COLUMN IF NOT EXISTS quantity_formula text;            -- e.g. "measurement_quantity * 1.1 / coverage_rate"

ALTER TABLE service_item_assembly_components
  ADD COLUMN IF NOT EXISTS formula_vars jsonb;               -- e.g. {"coverage_rate": 32}

-- DoS guard (matches MAX_FORMULA_LENGTH in @sitelayer/formula-evaluator).
DO $$
BEGIN
  ALTER TABLE service_item_assembly_components
    ADD CONSTRAINT service_item_assembly_components_formula_len_chk
    CHECK (quantity_formula IS NULL OR length(quantity_formula) <= 500);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 1c. estimate_lines — add provenance columns.
-- ---------------------------------------------------------------------------

ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS assembly_id uuid;                 -- which assembly produced this line (NULL = hand/flat line)

ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS assembly_component_id uuid;       -- which component within it (informational, NOT a FK)

ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS kind text;                        -- material|labor|sub|freight for assembly lines; NULL for flat lines

DO $$
BEGIN
  ALTER TABLE estimate_lines
    ADD CONSTRAINT estimate_lines_kind_chk
    CHECK (kind IS NULL OR kind IN ('material', 'labor', 'sub', 'freight'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS estimate_lines_assembly_idx
  ON estimate_lines (company_id, project_id, assembly_id)
  WHERE assembly_id IS NOT NULL;
