-- 004_estimate_line_org_tags.sql — org axes on estimate lines (PlanSwift gap G4, cont.).
--
-- Gap G6 added phase/location/zone/folder to takeoff_measurements; gap G4
-- shipped the multi-axis estimate rollup (GET .../estimate/rollup), but it could
-- only group by the axes estimate_lines already carried (division_code / kind /
-- service_item_code). This adds those four org axes to estimate_lines so the
-- estimate recompute/explode can thread each measurement's tags onto every line
-- it produces, and the rollup can then group by ANY PlanSwift axis.
--
-- Additive only: four nullable columns + partial indexes on an existing tenant
-- table (estimate_lines already has RLS). No backfill — lines created before
-- this carry NULL tags; the next recompute re-derives them from the measurements.

ALTER TABLE public.estimate_lines
    ADD COLUMN IF NOT EXISTS phase text,
    ADD COLUMN IF NOT EXISTS location text,
    ADD COLUMN IF NOT EXISTS zone text,
    ADD COLUMN IF NOT EXISTS folder text;

CREATE INDEX IF NOT EXISTS estimate_lines_phase_idx
    ON public.estimate_lines (company_id, project_id, phase) WHERE phase IS NOT NULL;
CREATE INDEX IF NOT EXISTS estimate_lines_location_idx
    ON public.estimate_lines (company_id, project_id, location) WHERE location IS NOT NULL;
CREATE INDEX IF NOT EXISTS estimate_lines_zone_idx
    ON public.estimate_lines (company_id, project_id, zone) WHERE zone IS NOT NULL;
CREATE INDEX IF NOT EXISTS estimate_lines_folder_idx
    ON public.estimate_lines (company_id, project_id, folder) WHERE folder IS NOT NULL;
