-- 067_estimate_lines_draft_id.sql
--
-- Phase A.4 of docs/MULTI_DRAFT_TAKEOFF_SPEC.md: thread the draft scope
-- through estimate_lines so each takeoff draft owns its own estimate.
--
-- Before this migration, `estimate_lines` hangs off `(company_id, project_id)`
-- only — a single recompute wipes the project's estimate and rebuilds it
-- from every measurement under the project regardless of draft. With the
-- multi-draft picker shipped in A.3, that meant switching drafts on the
-- canvas didn't change which scope the estimate panel reflected.
--
-- This migration adds a nullable `draft_id` column to `estimate_lines`,
-- backfills each existing row with its project's default draft (the same
-- one migration 066 created), and indexes (company_id, draft_id) for the
-- recompute fast-path. NOT NULL lands in the A.5 follow-up once the
-- recompute code in A.4 is exclusively writing to draft-scoped rows.
--
-- FK pattern mirrors `takeoff_measurements.draft_id` from migration 066:
-- non-composite reference to `takeoff_drafts(id) ON DELETE SET NULL` so a
-- hard-deleted draft nulls only the `draft_id` column (composite SET NULL
-- would also try to null `company_id`, violating its NOT NULL constraint).

ALTER TABLE estimate_lines
  ADD COLUMN IF NOT EXISTS draft_id uuid;

CREATE INDEX IF NOT EXISTS estimate_lines_draft_idx
  ON estimate_lines (company_id, draft_id)
  WHERE draft_id IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'estimate_lines_draft_id_fkey'
  ) THEN
    ALTER TABLE estimate_lines
      ADD CONSTRAINT estimate_lines_draft_id_fkey
      FOREIGN KEY (draft_id)
      REFERENCES takeoff_drafts (id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill: link existing lines to their project's default active draft.
-- Idempotent — only touches rows with draft_id IS NULL. If a project has
-- no active drafts (shouldn't happen post-066, but defensively), the
-- subquery returns NULL and the line stays unscoped; the A.4 helper will
-- treat NULL-draft lines as belonging to whatever draft is currently
-- requested, mirroring the same fallback as takeoff_measurements.
UPDATE estimate_lines l
SET draft_id = (
  SELECT d.id FROM takeoff_drafts d
  WHERE d.company_id = l.company_id
    AND d.project_id = l.project_id
    AND d.deleted_at IS NULL
    AND d.status = 'active'
  ORDER BY d.created_at ASC
  LIMIT 1
)
WHERE l.draft_id IS NULL;
