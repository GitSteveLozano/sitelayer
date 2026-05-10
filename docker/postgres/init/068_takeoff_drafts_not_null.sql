-- 068_takeoff_drafts_not_null.sql
--
-- Phase A.5 of docs/MULTI_DRAFT_TAKEOFF_SPEC.md — tighten the
-- `takeoff_measurements.draft_id` and `estimate_lines.draft_id` columns
-- to NOT NULL now that every writer in the codebase (Phases A.2 and A.4)
-- supplies a draft_id.
--
-- The previous migrations (066 for measurements, 067 for estimate_lines)
-- shipped the columns as nullable so the API could roll out before the
-- NOT NULL constraint locked the schema. With A.2/A.4 deployed and
-- backfilled, the only remaining path to a NULL draft_id is:
--   * A hard-deleted draft triggering the FK's ON DELETE SET NULL
--     cascade (admin-only; the API does soft delete via `deleted_at`).
--   * An orphan row from before the backfill that the UPDATE missed
--     because its project had no active drafts at the time.
--
-- This migration:
--   1. Re-runs the backfill defensively for both tables. Idempotent —
--      only touches rows with NULL draft_id, and only when the project
--      has an active default draft to link to.
--   2. Cleans up any remaining NULL rows: rows whose project has no
--      active drafts are unreachable through the API today, so we
--      soft-delete them rather than dropping NOT NULL on the constraint
--      and letting them sit as schema time bombs.
--   3. Drops the existing ON DELETE SET NULL FK constraints — incompatible
--      with NOT NULL because the cascade would try to write NULL.
--   4. SETs NOT NULL on both columns.
--   5. Re-adds the FKs with ON DELETE RESTRICT so a future admin can't
--      accidentally orphan measurements/lines by hard-deleting a draft.
--      Soft delete (status='archived' / deleted_at) still works for the
--      normal "hide this draft" flow and leaves the children intact.

-- ---------------------------------------------------------------------------
-- 1. Re-run backfill on takeoff_measurements.
-- ---------------------------------------------------------------------------
UPDATE takeoff_measurements m
SET draft_id = (
  SELECT d.id FROM takeoff_drafts d
  WHERE d.company_id = m.company_id
    AND d.project_id = m.project_id
    AND d.deleted_at IS NULL
    AND d.status = 'active'
  ORDER BY d.created_at ASC
  LIMIT 1
)
WHERE m.draft_id IS NULL
  AND m.deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Soft-delete any takeoff_measurements that still have NULL draft_id.
--    These are measurements whose project lost all active drafts (admin
--    hard-deleted them) — the API can't surface them anyway. Keep the
--    row for audit but mark it deleted so NOT NULL becomes addable.
-- ---------------------------------------------------------------------------
UPDATE takeoff_measurements
SET deleted_at = COALESCE(deleted_at, now()),
    version = version + 1
WHERE draft_id IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Re-run backfill on estimate_lines.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. Hard-delete orphan estimate_lines (no soft-delete column on this
--    table; the next recompute would regenerate them anyway).
-- ---------------------------------------------------------------------------
DELETE FROM estimate_lines WHERE draft_id IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Re-issue FKs with ON DELETE RESTRICT, then SET NOT NULL.
--    Order matters: drop SET NULL FK before NOT NULL, otherwise the
--    constraint check on the existing FK objects to NOT NULL on a
--    SET NULL action target.
-- ---------------------------------------------------------------------------
ALTER TABLE takeoff_measurements
  DROP CONSTRAINT IF EXISTS takeoff_measurements_draft_id_fkey;
ALTER TABLE estimate_lines
  DROP CONSTRAINT IF EXISTS estimate_lines_draft_id_fkey;

ALTER TABLE takeoff_measurements
  ALTER COLUMN draft_id SET NOT NULL;
ALTER TABLE estimate_lines
  ALTER COLUMN draft_id SET NOT NULL;

ALTER TABLE takeoff_measurements
  ADD CONSTRAINT takeoff_measurements_draft_id_fkey
  FOREIGN KEY (draft_id)
  REFERENCES takeoff_drafts (id)
  ON DELETE RESTRICT;

ALTER TABLE estimate_lines
  ADD CONSTRAINT estimate_lines_draft_id_fkey
  FOREIGN KEY (draft_id)
  REFERENCES takeoff_drafts (id)
  ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 6. The takeoff_measurements_draft_idx and estimate_lines_draft_idx
--    partial indexes (WHERE draft_id IS NOT NULL) are now redundant —
--    the column itself can never be NULL. We DROP them in favor of
--    cleaner full-column indexes so query planning doesn't trip on the
--    predicate. Replacement indexes are created identically minus the
--    WHERE clause.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS takeoff_measurements_draft_idx;
CREATE INDEX IF NOT EXISTS takeoff_measurements_draft_idx
  ON takeoff_measurements (company_id, draft_id);

DROP INDEX IF EXISTS estimate_lines_draft_idx;
CREATE INDEX IF NOT EXISTS estimate_lines_draft_idx
  ON estimate_lines (company_id, draft_id);
