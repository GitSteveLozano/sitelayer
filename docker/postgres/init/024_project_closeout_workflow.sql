-- Workflowize projects closeout.
--
-- Adds the deterministic-workflow scaffolding columns to `projects` so
-- the existing POST /api/projects/:id/closeout flow runs through the
-- registered reducer + writes workflow_event_log alongside the
-- `status='completed'` flip.
--
-- The reducer uses two states: 'active' and 'completed'. Existing rows
-- with status='lead' or any non-completed value are treated as 'active'
-- for workflow purposes; the underlying status column is unchanged.
-- Existing 'completed' rows are backfilled to state_version=2 so they
-- match exactly one CLOSEOUT transition from the v1 default.
--
-- The closeout route already sets closed_at + summary_locked_at; this
-- migration just adds the workflow audit columns. Side effects (margin
-- shortfall alert) remain in the route as best-effort post-commit work.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS state_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS closed_by text,
  ADD COLUMN IF NOT EXISTS workflow_engine text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS workflow_run_id text;

UPDATE projects
   SET state_version = 2
 WHERE status = 'completed' AND state_version = 1;
