-- 042_takeoff_elevation.sql
--
-- Adds a first-class `elevation` column to `takeoff_measurements`.
--
-- Sitemap §5 panel 1 ("Items by location") groups measurements by
-- elevation (East / South / West / North / Roof / Other). The v2
-- frontend currently encodes this as a `elev:<tag>` prefix on the
-- `notes` field — which works but isn't queryable, makes notes
-- harder to search, and gets overwritten if a user types into notes.
--
-- This migration:
--   1. Adds an `elevation` text column (nullable — pre-existing rows
--      stay untagged).
--   2. Backfills it from the `elev:<tag>` prefix in `notes`, then
--      strips that prefix so the notes field is clean.
--   3. Adds an index on (company_id, project_id, elevation) for the
--      summary-by-elevation query.

ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS elevation text;

-- Backfill from the existing `elev:<tag>\n?` prefix on notes.
UPDATE takeoff_measurements
SET
  elevation = lower((regexp_match(notes, '^elev:(\w+)', 'i'))[1]),
  notes = regexp_replace(notes, '^elev:\w+\s*\n?', '', 'i')
WHERE notes ~* '^elev:\w+';

-- Empty notes after the strip → null, keeps the column tidy.
UPDATE takeoff_measurements
SET notes = NULL
WHERE notes IS NOT NULL AND length(trim(notes)) = 0;

CREATE INDEX IF NOT EXISTS takeoff_measurements_elevation_idx
  ON takeoff_measurements (company_id, project_id, elevation)
  WHERE elevation IS NOT NULL;
