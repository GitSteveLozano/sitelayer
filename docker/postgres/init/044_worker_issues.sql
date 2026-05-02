-- 044_worker_issues.sql
--
-- Worker-flagged problems from Sitemap §11 panel `wk-issue` ("Flag a problem"
-- bottom sheet). One row per ping. Row creation drives a foreman push so the
-- foreman doesn't have to be in the app to know.
--
-- Shape:
--   - `kind` matches the chip row in apps/web-v2/src/screens/worker/issue-modal.tsx:
--       materials_out | crew_short | safety | other
--     Stored as text rather than an enum so adding a new chip later is a
--     migration of allowed values, not a schema-change rebuild.
--   - `project_id` is nullable: a worker can flag a problem before the
--     geofence has matched them to a project, and we'd rather log it
--     than reject the ping.
--   - `worker_id` is the company-side worker row (joined to the user's
--     clerk_user_id at insert time). Nullable so an unmatched user can
--     still ping.
--   - `reporter_clerk_user_id` is who pressed Send. Carries the audit
--     trail even when worker_id can't be resolved.
--   - `resolved_at` / `resolved_by_clerk_user_id` are written when a
--     foreman acknowledges the issue from their side. The acknowledge
--     UI is Phase 1D.3+; for now the column exists so we don't have to
--     amend later.

CREATE TABLE IF NOT EXISTS worker_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  worker_id uuid REFERENCES workers(id) ON DELETE SET NULL,
  reporter_clerk_user_id text NOT NULL,
  kind text NOT NULL,
  message text NOT NULL,
  resolved_at timestamptz,
  resolved_by_clerk_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT worker_issues_kind_chk CHECK (
    kind IN ('materials_out', 'crew_short', 'safety', 'other')
  ),
  CONSTRAINT worker_issues_message_len_chk CHECK (
    char_length(message) BETWEEN 1 AND 2000
  )
);

CREATE INDEX IF NOT EXISTS worker_issues_company_idx
  ON worker_issues(company_id, created_at DESC);

-- Open-issues feed for foreman dashboards: only-unresolved is the hot path.
CREATE INDEX IF NOT EXISTS worker_issues_open_company_idx
  ON worker_issues(company_id, created_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS worker_issues_project_idx
  ON worker_issues(company_id, project_id, created_at DESC);
