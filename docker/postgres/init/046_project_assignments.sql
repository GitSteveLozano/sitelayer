-- 046_project_assignments.sql
--
-- Per-project role assignments layered on top of company_memberships.
-- A user may carry company-level role admin/foreman/member and additionally
-- be assigned foreman or worker on specific projects. Same user can be
-- foreman on Hillcrest and worker on Aspen Ridge simultaneously — the
-- design handoff (Design Overview/) treats foreman/worker as project
-- contexts, not company-wide titles.
--
-- Shape:
--   - `clerk_user_id` is the assignee. We reference Clerk identity rather
--     than `workers.id` so an admin who is also a foreman has one row keyed
--     to their auth identity, not two rows in different tables.
--   - `role` is constrained to ('foreman', 'worker'). Company-level admin
--     is implicit — admins always retain the calm dashboard surface and
--     do not need an assignment row to act as foreman or worker.
--   - `assigned_by` is the actor that created the row (admin or foreman),
--     stored as clerk_user_id for the audit trail. Nullable for system
--     seed data.
--   - `deleted_at` matches the soft-delete pattern used elsewhere in
--     the schema (workers, blueprint_documents). Active assignments are
--     `where deleted_at is null`.
--
-- Indexes:
--   - by-user-active drives the role-aware shell heuristic (callers ask
--     "what am I assigned to right now?" on bootstrap)
--   - by-project-active drives the foreman's crew view ("who's on this
--     site today")

CREATE TABLE IF NOT EXISTS project_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  role text NOT NULL,
  assigned_by_clerk_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT project_assignments_role_chk CHECK (
    role IN ('foreman', 'worker')
  )
);

-- Prevent duplicate active assignments. A user can hold both foreman and
-- worker on the same project (rare but legal — e.g., a working foreman),
-- so the unique key includes role.
CREATE UNIQUE INDEX IF NOT EXISTS project_assignments_unique_active
  ON project_assignments(project_id, clerk_user_id, role)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS project_assignments_user_active_idx
  ON project_assignments(clerk_user_id, company_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS project_assignments_project_active_idx
  ON project_assignments(project_id)
  WHERE deleted_at IS NULL;

-- Bootstrap-cache invalidation. /api/bootstrap returns the caller's own
-- assignments, so any insert/update/soft-delete on this table must bump
-- company_bootstrap_state.token to force a fresh fan-out on the next read.
-- Pattern matches migration 014 (the existing trigger function). Statement-
-- level triggers keep cost flat under bulk inserts.
DROP TRIGGER IF EXISTS project_assignments_bootstrap_bump_ins ON project_assignments;
DROP TRIGGER IF EXISTS project_assignments_bootstrap_bump_upd ON project_assignments;
DROP TRIGGER IF EXISTS project_assignments_bootstrap_bump_del ON project_assignments;
CREATE TRIGGER project_assignments_bootstrap_bump_ins AFTER INSERT ON project_assignments
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER project_assignments_bootstrap_bump_upd AFTER UPDATE ON project_assignments
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER project_assignments_bootstrap_bump_del AFTER DELETE ON project_assignments
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
