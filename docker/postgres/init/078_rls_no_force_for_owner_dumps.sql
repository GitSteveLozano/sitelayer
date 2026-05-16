-- 078_rls_no_force_for_owner_dumps.sql
--
-- Migration 073 set ENABLE + FORCE ROW LEVEL SECURITY on four append-only
-- tables (audit_events, workflow_event_log, mutation_outbox, sync_events).
-- FORCE was intended to make the table owner subject to the policy too,
-- which is the right posture on DO Managed Postgres where the migrator
-- runs as `doadmin` (superuser-ish) but the app runs as `sitelayer`
-- (non-owner, fully filtered).
--
-- But the prod deploy pipeline runs `pg_dump` against the database
-- using the deploy user, which IS the table owner. With FORCE, even the
-- owner is blocked from reading the table, and `pg_dump` aborts:
--
--   pg_dump: error: query failed: ERROR: query would be affected by
--   row-level security policy for table "audit_events"
--   HINT: To disable the policy for the table's owner, use ALTER TABLE
--         NO FORCE ROW LEVEL SECURITY.
--
-- The hint is the safest reversible fix: drop FORCE so the owner can
-- read the table for backups. RLS stays ENABLED, so the app role (which
-- IS NOT the owner) is still filtered by the policy. We lose the "even
-- the owner is checked" defense-in-depth, but the security model still
-- holds for the actual application traffic.
--
-- A stricter follow-up is to provision a dedicated dump role with
-- BYPASSRLS, point the deploy backup at that role, and restore FORCE.
-- That requires a DB-level role rotation that's out of scope for this
-- hotfix. Documented as a follow-up in docs/SECURITY_RLS.md.

ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workflow_event_log NO FORCE ROW LEVEL SECURITY;
ALTER TABLE mutation_outbox NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sync_events NO FORCE ROW LEVEL SECURITY;
