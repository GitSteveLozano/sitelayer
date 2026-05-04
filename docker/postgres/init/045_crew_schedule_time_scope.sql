-- 045_crew_schedule_time_scope.sql
--
-- Adds `start_time`, `end_time`, and `takeoff_measurement_id` to
-- crew_schedules so the day-stream cards (Sitemap §7 panel 1) and
-- the new-assignment sheet (panel 3) can show a real time range and
-- a scope label sourced from a takeoff measurement.
--
-- All three columns are nullable so existing rows stay valid; the SPA
-- treats them as optional and renders calm fallbacks when missing.
-- The composite FK on (company_id, takeoff_measurement_id) enforces
-- that a schedule can only point at a takeoff in the same company —
-- piggybacking on the UNIQUE (company_id, id) constraint on
-- takeoff_measurements (see 001_schema.sql line 163). ON DELETE SET
-- NULL because deleting a takeoff measurement shouldn't cascade
-- through to the schedule row; the schedule keeps the time range and
-- crew, just loses the scope link.
--
-- No index on takeoff_measurement_id — schedules are filtered by
-- company + date (covered by crew_schedules_company_scheduled_idx),
-- and the takeoff link is a per-row read, not a list filter.

ALTER TABLE crew_schedules
  ADD COLUMN IF NOT EXISTS start_time time,
  ADD COLUMN IF NOT EXISTS end_time time,
  ADD COLUMN IF NOT EXISTS takeoff_measurement_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'crew_schedules_takeoff_measurement_fkey'
  ) THEN
    ALTER TABLE crew_schedules
      ADD CONSTRAINT crew_schedules_takeoff_measurement_fkey
      FOREIGN KEY (company_id, takeoff_measurement_id)
      REFERENCES takeoff_measurements (company_id, id)
      ON DELETE SET NULL;
  END IF;
END$$;
