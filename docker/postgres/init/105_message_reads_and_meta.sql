-- 105_message_reads_and_meta.sql
--
-- Chat last-message / unread tracking + structured message markers. Two
-- additive changes that close the GAP the chat screen documents inline
-- (apps/web/src/screens/mobile/chat.tsx) and the messaging route
-- (apps/api/src/routes/messaging.ts):
--
--   1. project_messages.meta jsonb (nullable) — a structured marker slot so
--      auto-posted / approval / field-intake messages can carry first-class
--      shape instead of being body-sniffed by the UI. Examples:
--        {"kind": "approval", "amount": 510}
--        {"linked_field_event_id": "<uuid>"}
--      Nullable, no default: legacy rows stay NULL and the UI keeps its
--      heuristic fallback for them. project_messages ALREADY got the
--      company_isolation RLS policy + ENABLE/FORCE in 101_v2_rls.sql, so this
--      migration only ADDS the column — it does NOT re-add RLS to that table.
--
--   2. message_reads — a per-(company, project, user) read marker. Records the
--      last time a user read a project's chat thread (last_read_at). Unread
--      count = project_messages newer than that marker. UPSERT-on-read keyed by
--      UNIQUE (company_id, project_id, user_id). user_id is the Clerk user id
--      (text), matching project_messages.author_user_id /
--      project_assignments.clerk_user_id. This is a NEW company-scoped table,
--      so it DOES get the full company_isolation RLS treatment (identical
--      permissive body to migration 066 / 101 / 104).
--
-- Follows the 104_project_billing_milestones.sql table pattern (per-project,
-- company-scoped) and the 101_v2_rls.sql RLS pattern (company_isolation
-- permissive policy + ENABLE + FORCE — FORCE because the app runs as the
-- table-owner `sitelayer` role on DO managed PG, see 085).
--
-- Additive, idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS), forward-only.
-- No data change to any existing row.

-- 1) Structured-marker slot on the existing chat message table.
--    Nullable, no default — legacy rows remain NULL. project_messages already
--    carries company_isolation RLS from 101; do NOT re-add it here.
ALTER TABLE project_messages
  ADD COLUMN IF NOT EXISTS meta jsonb;

-- 2) Per-user thread read marker (NEW table → full RLS below).
CREATE TABLE IF NOT EXISTS message_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Clerk user id of the reader (matches project_messages.author_user_id /
  -- project_assignments.clerk_user_id). text, not a FK — identity lives in
  -- the Clerk mirror, not a local users table.
  user_id text NOT NULL,

  -- Watermark: messages with created_at > last_read_at are unread for this
  -- user. Defaults to now() so a freshly-created marker starts caught up.
  last_read_at timestamptz NOT NULL DEFAULT now(),

  -- One marker per reader per project thread; the read route UPSERTs on this.
  UNIQUE (company_id, project_id, user_id)
);

-- Summary/unread reads are always "the marker for one (company, project,
-- user)"; this composite index backs the UPSERT conflict target + lookups.
CREATE INDEX IF NOT EXISTS message_reads_company_project_user_idx
  ON message_reads (company_id, project_id, user_id);

-- RLS — same belt-and-suspenders guarantee the rest of the company-scoped
-- domain has (identical permissive body to migration 066 / 101 / 104: stays
-- permissive when app.company_id is unset so debug/replay/webhook paths keep
-- working). ENABLE + FORCE because the app runs as the table-owner role on DO
-- managed PG (see 085 / 101). Idempotent: DROP POLICY IF EXISTS before CREATE.
DROP POLICY IF EXISTS company_isolation ON message_reads;
CREATE POLICY company_isolation ON message_reads
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());
ALTER TABLE message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_reads FORCE ROW LEVEL SECURITY;
