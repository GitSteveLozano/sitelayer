-- Add metadata column to projects and labor_entries for QBO sync
ALTER TABLE projects      ADD COLUMN IF NOT EXISTS metadata jsonb default '{}'::jsonb;
ALTER TABLE labor_entries ADD COLUMN IF NOT EXISTS metadata jsonb default '{}'::jsonb;

-- Index for QBO customer ref lookups
CREATE INDEX IF NOT EXISTS idx_projects_metadata ON projects USING gin(metadata);
CREATE INDEX IF NOT EXISTS idx_labor_metadata    ON labor_entries USING gin(metadata);

-- Unique constraint on QBO ID for labor entries (prevent duplicate syncs)
-- Using a partial unique index on the jsonb field
CREATE UNIQUE INDEX IF NOT EXISTS idx_labor_qbo_id
  ON labor_entries ((metadata->>'qbo_id'))
  WHERE metadata->>'qbo_id' IS NOT NULL;
