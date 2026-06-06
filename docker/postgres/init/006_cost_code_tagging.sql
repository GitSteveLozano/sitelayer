-- 006_cost_code_tagging.sql — free-form cost-code org axis on the costing tables.
--
-- Migration 003 added the PlanSwift org axes (phase/location/zone/folder) to
-- takeoff_measurements and 004 mirrored them onto estimate_lines, so an estimate
-- can be navigated and rolled up by any of those axes. A `cost_code` is the
-- adjacent accounting-side axis: contractors tag each measured quantity / bid
-- line / labor entry with a job-cost code (e.g. a CSI/MasterFormat or
-- company-internal cost code) so spend rolls up by cost code, not just by
-- division or service item. `budget_lines.cost_code` already exists (migration
-- that added the budget snapshot derives it from division_code today); this adds
-- the same free-form axis directly to the three source costing tables so the tag
-- can be carried from takeoff → estimate → labor instead of inferred.
--
-- Additive only: one nullable text column per table (mirrors the 003/004 org-tag
-- columns exactly) plus a partial index per table so a cost-code rollup/filter is
-- cheap while every untagged legacy row stays out of the index. No backfill —
-- existing rows simply carry a NULL cost_code. All three tables already have RLS
-- and a (company_id, project_id) shape, so the indexes match the org-tag idx
-- precedent.

ALTER TABLE public.takeoff_measurements
    ADD COLUMN IF NOT EXISTS cost_code text;

ALTER TABLE public.estimate_lines
    ADD COLUMN IF NOT EXISTS cost_code text;

ALTER TABLE public.labor_entries
    ADD COLUMN IF NOT EXISTS cost_code text;

CREATE INDEX IF NOT EXISTS takeoff_measurements_cost_code_idx
    ON public.takeoff_measurements (company_id, project_id, cost_code) WHERE cost_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS estimate_lines_cost_code_idx
    ON public.estimate_lines (company_id, project_id, cost_code) WHERE cost_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS labor_entries_cost_code_idx
    ON public.labor_entries (company_id, project_id, cost_code) WHERE cost_code IS NOT NULL;
