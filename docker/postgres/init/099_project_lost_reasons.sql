-- 099_project_lost_reasons.sql
--
-- Lost reasons — structured capture of WHY a sent estimate didn't convert,
-- powering the v2 PROJECT · LOST screen (workflow 07) and the win-rate stats on
-- the client profile. The project_lifecycle workflow already has a `declined`
-- state with a free-text decline reason; this promotes that into a categorised
-- enum + optional note so we can aggregate ("lost on PRICE 4x this quarter").
--
-- One row per lost project (the most recent capture wins if a project bounces
-- declined → reopened → declined; the route upserts on project_id). Kept as a
-- sibling table rather than columns on projects so the reason set can grow and
-- a project that is never lost carries no row.
--
-- reason enum mirrors the v2 picker: PRICE | TIMING | SCOPE | GHOSTED |
-- COMPETITOR | OTHER. note is optional free text (e.g. "Hill Construction came
-- in 12% lower").

CREATE TABLE IF NOT EXISTS project_lost_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  reason text NOT NULL
    CHECK (reason IN ('price', 'timing', 'scope', 'ghosted', 'competitor', 'other')),
  note text NOT NULL DEFAULT '',

  -- Snapshot of the lost bid value at capture time (for win-rate / lost-$ rollups
  -- without re-joining the project, which may change later).
  lost_value numeric(14, 2) NOT NULL DEFAULT 0,

  recorded_by text,           -- Clerk user id

  origin text DEFAULT current_setting('app.tier', true),
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  -- One live lost-reason per project (upsert on re-decline).
  UNIQUE (project_id)
);

-- Win-rate / lost-reason analytics scan by company + reason.
CREATE INDEX IF NOT EXISTS project_lost_reasons_company_reason_idx
  ON project_lost_reasons (company_id, reason, created_at DESC)
  WHERE deleted_at IS NULL;
