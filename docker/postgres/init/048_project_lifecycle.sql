-- Project lifecycle workflow scaffolding.
--
-- Models a sales/delivery pipeline alongside the existing
-- project_closeout workflow (which only answers "is the project
-- completed yet?"). The two coexist:
--
--   - lifecycle_state owns: draft → estimating → sent → accepted →
--     in_progress → done → archived (and a sent → declined branch).
--   - status (legacy) keeps its existing values; downstream readers
--     (analytics, summarizeProject, the bootstrap response) still
--     work unchanged.
--
-- Backfill maps the legacy `status` column onto the new lifecycle
-- vocabulary so existing companies see sensible default states:
--   'lead'      → 'draft'
--   'active'    → 'in_progress'
--   'completed' → 'done'
--   anything else → 'draft' (catch-all, mirrors the reducer default)
--
-- Existing rows get state_version=1 plus an extra +1 per backfilled
-- transition, so:
--   draft       → 1     (no transition applied yet)
--   in_progress → 4     (START_ESTIMATING, SEND, ACCEPT, START_WORK)
--   done        → 5     (...plus COMPLETE)
-- Picking these state_versions keeps the optimistic-version contract
-- honest: a UI fetched today would always see version >= 1, and the
-- next event applied lands at +1 against that baseline.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS lifecycle_state_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS lifecycle_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_decline_reason text,
  ADD COLUMN IF NOT EXISTS lifecycle_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_archived_at timestamptz;

-- Add CHECK constraint enumerating valid states. Wrapped in a DO block
-- so the migration is idempotent across re-runs / environments where
-- it might already exist (the schema_migrations checksum gate is the
-- real safety net, but defensive coding here matches the precedent in
-- 002_tier_origin.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'projects_lifecycle_state_chk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_lifecycle_state_chk
      CHECK (lifecycle_state IN (
        'draft', 'estimating', 'sent', 'accepted',
        'declined', 'in_progress', 'done', 'archived'
      ));
  END IF;
END $$;

-- Backfill from legacy status. UPDATE only touches rows still at the
-- defaults so re-runs are no-ops.
UPDATE projects
   SET lifecycle_state = 'in_progress',
       lifecycle_state_version = 4,
       lifecycle_started_at = COALESCE(closed_at, updated_at, created_at)
 WHERE status = 'active'
   AND lifecycle_state = 'draft'
   AND lifecycle_state_version = 1;

UPDATE projects
   SET lifecycle_state = 'done',
       lifecycle_state_version = 5,
       lifecycle_started_at = COALESCE(lifecycle_started_at, closed_at, updated_at, created_at),
       lifecycle_completed_at = COALESCE(closed_at, updated_at)
 WHERE status = 'completed'
   AND lifecycle_state = 'draft'
   AND lifecycle_state_version = 1;

-- 'lead' rows stay at default ('draft', state_version=1) — no UPDATE needed.

-- Index supporting the dashboard "show me everything in <state>" query.
-- Same shape as other per-company workflow lookups in this schema.
CREATE INDEX IF NOT EXISTS projects_lifecycle_state_idx
  ON projects (company_id, lifecycle_state)
  WHERE deleted_at IS NULL;
