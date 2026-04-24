-- Writes get tagged with the tier that created them. app.tier is set at connection
-- startup by the API/worker pool via Postgres options (`-c app.tier=<tier>`). The
-- `current_setting('app.tier', true)` second argument lets the default evaluate to
-- NULL when the GUC is unset (e.g. psql sessions) instead of erroring.

ALTER TABLE projects              ADD COLUMN IF NOT EXISTS origin text DEFAULT current_setting('app.tier', true);
ALTER TABLE blueprint_documents   ADD COLUMN IF NOT EXISTS origin text DEFAULT current_setting('app.tier', true);
ALTER TABLE takeoff_measurements  ADD COLUMN IF NOT EXISTS origin text DEFAULT current_setting('app.tier', true);
ALTER TABLE labor_entries         ADD COLUMN IF NOT EXISTS origin text DEFAULT current_setting('app.tier', true);
ALTER TABLE material_bills        ADD COLUMN IF NOT EXISTS origin text DEFAULT current_setting('app.tier', true);
ALTER TABLE crew_schedules        ADD COLUMN IF NOT EXISTS origin text DEFAULT current_setting('app.tier', true);
ALTER TABLE estimate_lines        ADD COLUMN IF NOT EXISTS origin text DEFAULT current_setting('app.tier', true);

CREATE INDEX IF NOT EXISTS projects_origin_idx             ON projects (origin)             WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS blueprint_documents_origin_idx  ON blueprint_documents (origin)  WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS takeoff_measurements_origin_idx ON takeoff_measurements (origin) WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS labor_entries_origin_idx        ON labor_entries (origin)        WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS material_bills_origin_idx       ON material_bills (origin)       WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS crew_schedules_origin_idx       ON crew_schedules (origin)       WHERE origin IS NOT NULL;
CREATE INDEX IF NOT EXISTS estimate_lines_origin_idx       ON estimate_lines (origin)       WHERE origin IS NOT NULL;
