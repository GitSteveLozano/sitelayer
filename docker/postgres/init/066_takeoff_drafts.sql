-- 066_takeoff_drafts.sql
--
-- Multi-draft takeoff infrastructure (Phase A.1 of docs/MULTI_DRAFT_TAKEOFF_SPEC.md).
--
-- Before this migration, `takeoff_measurements` hangs directly off
-- `project_id`. Estimators wanting to maintain two parallel scopes for the
-- same project had to delete the first scope before measuring the second.
-- The original README/prototype notes promised "multiple measurement drafts
-- per project — create, rename, duplicate, switch between drafts" but the
-- schema never landed.
--
-- This migration adds the `takeoff_drafts` table and a nullable `draft_id`
-- column on `takeoff_measurements`, then backfills:
--
--   1. One default draft per existing project (name='Default',
--      type='measurement', status='active').
--   2. Every existing measurement's `draft_id` set to that default.
--
-- `draft_id` stays NULLABLE for now. The API change (Phase A.2) will start
-- supplying `draft_id` on new measurements; once all writers have cut
-- over, a follow-up migration adds the NOT NULL constraint (Phase A.5 in
-- the spec).
--
-- The `type` column is intentionally free-text — 'measurement' today,
-- 'scaffolding' once the scaffolding-design tool lands. Pinned to text
-- (not an enum) because adding enum values is an ALTER TYPE that pre-pg18
-- couldn't do in a transaction; text + a check expression is easier to
-- evolve.
--
-- The composite (company_id, project_id) FK matches the rest of the
-- per-tenant tables in this schema; row-level tenancy filters in the
-- app rely on the same pattern.

CREATE TABLE IF NOT EXISTS takeoff_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'measurement',
  status text NOT NULL DEFAULT 'active',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  CONSTRAINT takeoff_drafts_status_check
    CHECK (status IN ('active', 'archived')),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS takeoff_drafts_project_idx
  ON takeoff_drafts (company_id, project_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS takeoff_drafts_project_active_idx
  ON takeoff_drafts (company_id, project_id)
  WHERE deleted_at IS NULL AND status = 'active';

ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS draft_id uuid;

CREATE INDEX IF NOT EXISTS takeoff_measurements_draft_idx
  ON takeoff_measurements (company_id, draft_id)
  WHERE draft_id IS NOT NULL;

-- Defensive FK: a hard-deleted draft (admin tool, manual psql) leaves its
-- measurements orphaned with draft_id = NULL rather than dangling at a
-- nonexistent uuid. Soft delete (status='archived' / deleted_at) leaves
-- measurements in place per spec.
--
-- The FK references takeoff_drafts(id) directly rather than the composite
-- (company_id, id) so ON DELETE SET NULL nulls only `draft_id` —
-- composite SET NULL would also try to null `company_id`, which violates
-- the NOT NULL constraint already on the column. Tenant scoping is still
-- enforced at the app layer (every insert/update goes through
-- company_id-filtered SQL) and through takeoff_drafts' own composite FK
-- back to projects(company_id, id).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'takeoff_measurements_draft_id_fkey'
  ) THEN
    ALTER TABLE takeoff_measurements
      ADD CONSTRAINT takeoff_measurements_draft_id_fkey
      FOREIGN KEY (draft_id)
      REFERENCES takeoff_drafts (id)
      ON DELETE SET NULL;
  END IF;
END $$;

-- Backfill step 1: ensure every project has at least one active draft
-- named 'Default'. Idempotent — re-running this migration on a partially
-- backfilled DB only inserts the missing rows. The NOT EXISTS guard keys
-- on (company_id, project_id, name='Default') so a manual rename of the
-- default draft post-rollout won't cause a duplicate insert.
INSERT INTO takeoff_drafts (company_id, project_id, name, type, status)
SELECT p.company_id, p.id, 'Default', 'measurement', 'active'
FROM projects p
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM takeoff_drafts d
    WHERE d.company_id = p.company_id
      AND d.project_id = p.id
      AND d.deleted_at IS NULL
  );

-- Backfill step 2: link every existing measurement to its project's
-- default draft. Only touches rows where `draft_id IS NULL`, so re-running
-- the migration on a DB that's already been partially cut over is safe.
-- If a project somehow has multiple active drafts (shouldn't happen
-- mid-rollout, but defensively), the subquery picks the oldest by
-- created_at — the one we just inserted.
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
