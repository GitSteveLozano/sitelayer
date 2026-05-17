-- Migration 083: hot-path composite indexes + recipient/role CHECK constraints.
--
-- Surfaced by the DB integrity audit:
--
--   1. Three hot WHERE/JOIN paths lack composite indexes — seq-scan risk
--      at pilot scale (10k-100k rows per company).
--   2. `notifications` allows both `recipient_clerk_user_id` AND
--      `recipient_email` to be NULL — a row with both null would 500 the
--      notification sender. Adding a CHECK so the schema enforces the
--      application invariant.
--   3. `company_memberships.role` is free-text. Adding a CHECK enum keeps
--      the schema in sync with `packages/domain/src/roles.ts:CompanyRole`.
--
-- All statements are idempotent (`IF NOT EXISTS` or `ADD CONSTRAINT IF NOT
-- EXISTS` patterns). Safe to re-apply.

-- ---------------------------------------------------------------------------
-- 1. Composite hot-path indexes
-- ---------------------------------------------------------------------------

-- estimate_lines is scanned per (company_id, project_id) by the estimate
-- recompute path and the scope-vs-bid endpoint. The existing
-- estimate_lines_draft_idx covers (company_id, draft_id) only; this
-- composite covers the non-draft path used by the per-project rollup
-- and by `summarizeProject` in apps/api/src/routes/projects.ts.
CREATE INDEX IF NOT EXISTS estimate_lines_company_project_idx
  ON estimate_lines (company_id, project_id);

-- labor_entries is scanned by (company_id, project_id, occurred_on)
-- across multiple analytics + bid-accuracy endpoints. The existing
-- labor_entries_company_occurred_idx covers (company_id, occurred_on);
-- adding project_id makes per-project rollups index-only.
CREATE INDEX IF NOT EXISTS labor_entries_company_project_occurred_idx
  ON labor_entries (company_id, project_id, occurred_on DESC);

-- workflow_event_log replay reads rows by (entity_id) ordered by
-- state_version. The existing workflow_event_log_entity_idx is on
-- (entity_id) only — adding state_version makes the replay scan
-- index-only and lets `applyEventLog` walk in order without a sort.
CREATE INDEX IF NOT EXISTS workflow_event_log_entity_state_idx
  ON workflow_event_log (entity_id, state_version ASC);

-- ---------------------------------------------------------------------------
-- 2. notifications recipient CHECK
-- ---------------------------------------------------------------------------

-- Application invariant: a notification must have at least one delivery
-- handle. Without this CHECK, a row with both columns null would 500 the
-- channel router when it tries to read either field.
--
-- Use a DO block so the ADD CONSTRAINT is idempotent — Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS` for CHECK constraints prior to 18.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'notifications_at_least_one_recipient'
      AND conrelid = 'notifications'::regclass
  ) THEN
    ALTER TABLE notifications
      ADD CONSTRAINT notifications_at_least_one_recipient
      CHECK (
        recipient_clerk_user_id IS NOT NULL OR
        recipient_email IS NOT NULL
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. company_memberships.role enum CHECK
-- ---------------------------------------------------------------------------

-- Schema-level documentation of the CompanyRole union defined in
-- packages/domain/src/roles.ts. A future addition (e.g. 'analyst') would
-- need both a code change AND this CHECK relaxation, which is the right
-- shape — adding a role silently in code shouldn't bypass the schema.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'company_memberships_valid_role'
      AND conrelid = 'company_memberships'::regclass
  ) THEN
    ALTER TABLE company_memberships
      ADD CONSTRAINT company_memberships_valid_role
      CHECK (role IN ('admin', 'foreman', 'office', 'member', 'bookkeeper'));
  END IF;
END $$;
