-- 137_assembly_component_include_when.sql
--
-- M2 (parent-driver + conditional formulas) — see
-- docs/TAKEOFF_DEEP_DIVE_2026-06-01.md §5.3 M2 and §6 P1.4.
--
-- Adds an OPTIONAL boolean `include_when` expression per assembly component. It
-- is evaluated by @sitelayer/formula-evaluator at explode time against the same
-- driver context as `quantity_formula` (measurement_quantity, measurement_unit,
-- plus the measurement drivers height/width/thickness/perimeter/sides and the
-- component's own formula_vars). When the expression is present and evaluates
-- falsy, that component is SKIPPED in the explosion; when NULL/absent the
-- component always explodes (the current, unchanged behavior).
--
-- This is the EXPAND step of an additive, forward-only change (sibling of
-- migration 109 which added quantity_formula / formula_vars). Every existing row
-- keeps its exact behavior: the new column is nullable with no default, so all
-- pre-existing components have include_when IS NULL => always included.
--
-- No new TABLES => no new RLS policies. service_item_assembly_components already
-- carries company_isolation ENABLE+FORCE; the new column inherits the existing
-- row-level policy. Verify with the schema-parity audit after applying.
--
-- Immutability: once committed, this file is checksummed in schema_migrations.
-- Any later correction is a new 138+ file — never edit this one.

ALTER TABLE service_item_assembly_components
  ADD COLUMN IF NOT EXISTS include_when text;            -- e.g. "height > 8" or "sides >= 4"

-- DoS guard (matches MAX_FORMULA_LENGTH in @sitelayer/formula-evaluator and the
-- quantity_formula CHECK added in migration 109).
DO $$
BEGIN
  ALTER TABLE service_item_assembly_components
    ADD CONSTRAINT service_item_assembly_components_include_when_len_chk
    CHECK (include_when IS NULL OR length(include_when) <= 500);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
