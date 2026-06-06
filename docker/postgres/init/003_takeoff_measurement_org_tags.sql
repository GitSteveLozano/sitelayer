-- 003_takeoff_measurement_org_tags.sql — PlanSwift org axes + extensible props (gap G6).
--
-- PlanSwift organizes every takeoff item by Division / Phase / Location / Zone /
-- Folder so a 500-line estimate is navigable and reports roll up by any axis.
-- Sitelayer had only `division_code` (+ a fixed east/south/west/north/roof/other
-- `elevation` enum). This adds the four missing free-form org axes plus a
-- generic `props` jsonb bag — the PlanSwift extensibility trick (every object
-- carries an open property bag) that also gives AI metadata / trade packs /
-- future per-item attributes a home without a schema change each time.
--
-- These four axes are what the multi-axis estimate rollup (gap G4) groups by,
-- so this is the data foundation that gap unblocks.
--
-- Additive only: new NULLable columns (+ a NOT NULL props defaulting to '{}')
-- on an existing tenant table; RLS already covers the table. No backfill —
-- existing rows simply carry NULL tags / an empty props bag. Postgres applies
-- the NOT NULL-with-default column without a table rewrite.

ALTER TABLE public.takeoff_measurements
    ADD COLUMN IF NOT EXISTS phase text,
    ADD COLUMN IF NOT EXISTS location text,
    ADD COLUMN IF NOT EXISTS zone text,
    ADD COLUMN IF NOT EXISTS folder text,
    ADD COLUMN IF NOT EXISTS props jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Cheap rollup/filter by each org axis. Partial indexes (only tagged rows) keep
-- them tiny while every untagged legacy row stays out of the index.
CREATE INDEX IF NOT EXISTS takeoff_measurements_phase_idx
    ON public.takeoff_measurements (company_id, project_id, phase) WHERE phase IS NOT NULL;
CREATE INDEX IF NOT EXISTS takeoff_measurements_location_idx
    ON public.takeoff_measurements (company_id, project_id, location) WHERE location IS NOT NULL;
CREATE INDEX IF NOT EXISTS takeoff_measurements_zone_idx
    ON public.takeoff_measurements (company_id, project_id, zone) WHERE zone IS NOT NULL;
CREATE INDEX IF NOT EXISTS takeoff_measurements_folder_idx
    ON public.takeoff_measurements (company_id, project_id, folder) WHERE folder IS NOT NULL;
