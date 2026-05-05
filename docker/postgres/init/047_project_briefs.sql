-- 047_project_briefs.sql
--
-- Foreman morning brief (Sitemap.html § fm-brief).
--
-- The morning counterpart to daily_logs: the foreman composes today's
-- plan and pushes it to the crew. Workers read this on wk-today /
-- wk-scope. One row per (company, project, effective_date, foreman).
--
-- Phase 8 ships this as a write-only record; the worker UI surfaces it
-- read-only via /api/projects/:id/briefs?date=YYYY-MM-DD. Push/SMS
-- delivery to the crew is layered on top via the existing
-- notifications worker; a row inserted here triggers a fan-out the
-- same way worker_issues does for foreman alerts.

CREATE TABLE IF NOT EXISTS project_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  foreman_user_id text NOT NULL,
  effective_date date NOT NULL,
  goal text NOT NULL,
  -- Structured payloads — mirror daily_logs so the cohort model can
  -- compare brief intent vs. log outcome without parsing free text.
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  crew jsonb NOT NULL DEFAULT '[]'::jsonb,
  materials jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Audit + concurrency.
  origin text DEFAULT current_setting('app.tier', true),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_briefs_goal_nonempty CHECK (length(trim(goal)) > 0)
);

-- One brief per foreman per project per day. A second submit is an
-- update path (handled in app via PATCH /api/briefs/:id), not a new row.
CREATE UNIQUE INDEX IF NOT EXISTS project_briefs_uniq
  ON project_briefs (company_id, project_id, effective_date, foreman_user_id);

CREATE INDEX IF NOT EXISTS project_briefs_project_date_idx
  ON project_briefs (project_id, effective_date DESC);

CREATE INDEX IF NOT EXISTS project_briefs_company_recent_idx
  ON project_briefs (company_id, effective_date DESC);
