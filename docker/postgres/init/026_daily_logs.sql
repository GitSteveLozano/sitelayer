-- 026_daily_logs.sql
--
-- Foreman daily logs (Sitemap.html § fm-log).
--
-- Auto-populated throughout the day from clock events, photos uploaded
-- with project context, and schedule deviations the foreman flags. The
-- foreman opens the log at end-of-day, adds a free-text summary, and
-- submits. Submitted logs become the project's audit trail and the
-- input to the cohort model that produces "What needs me?" signals on
-- the owner dashboard (Phase 5).
--
-- Shape:
--   - one row per (company, project, day, foreman) — multiple foremen
--     on the same project each get their own log; one foreman cannot
--     submit two logs for the same day on the same project.
--   - structured json columns for scope_progress, weather, deviations,
--     crew_summary so analytics can aggregate without parsing free
--     text. notes is the foreman's narrative.
--   - photo_keys is a text[] of opaque storage keys (Spaces or local
--     fallback) — same convention as blueprint_documents.storage_path.
--   - status: 'draft' (auto-saving as the day progresses) or
--     'submitted' (locked, audit trail).
--   - version + updated_at follow the project's optimistic-concurrency
--     and LWW conventions (see assertVersion + lww.ts).

CREATE TABLE IF NOT EXISTS daily_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  occurred_on date NOT NULL,
  foreman_user_id text NOT NULL,
  -- Structured payloads.
  scope_progress jsonb NOT NULL DEFAULT '[]'::jsonb,
  weather jsonb,
  notes text,
  schedule_deviations jsonb NOT NULL DEFAULT '[]'::jsonb,
  crew_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  photo_keys text[] NOT NULL DEFAULT '{}',
  -- Workflow.
  status text NOT NULL DEFAULT 'draft',
  submitted_at timestamptz,
  -- Audit.
  origin text DEFAULT current_setting('app.tier', true),
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT daily_logs_status_chk CHECK (status IN ('draft', 'submitted')),
  CONSTRAINT daily_logs_submitted_chk CHECK (
    (status = 'submitted' AND submitted_at IS NOT NULL)
    OR (status = 'draft' AND submitted_at IS NULL)
  ),
  CONSTRAINT daily_logs_unique_per_foreman_day
    UNIQUE (company_id, project_id, occurred_on, foreman_user_id)
);

CREATE INDEX IF NOT EXISTS daily_logs_company_project_day_idx
  ON daily_logs (company_id, project_id, occurred_on DESC);
CREATE INDEX IF NOT EXISTS daily_logs_company_status_idx
  ON daily_logs (company_id, status, occurred_on DESC)
  WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS daily_logs_origin_idx
  ON daily_logs (origin) WHERE origin IS NOT NULL;
