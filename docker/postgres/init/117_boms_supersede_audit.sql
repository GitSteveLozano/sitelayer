-- 117_boms_supersede_audit.sql
--
-- Additive (expand-only) audit columns for the scaffold_ops_approval
-- workflow's new `superseded` reducer state (packages/workflows/src/
-- scaffold-ops-approval.ts SCHEMA_VERSION 1).
--
-- `boms` already carries `status` ('draft' | 'approved' | 'superseded'),
-- `state_version`, and the `superseded_by` FK (migration 058). The
-- SUPERSEDE transition needs no new state column. These two columns
-- persist the supersession audit timestamps directly on the row so the
-- detail UI can render "superseded on / by" without replaying the event
-- log; they also live on the SUPERSEDE event payload + workflow_event_log
-- snapshot, so this is purely a convenience cache.
--
-- Never edits an applied migration (058/076 stay immutable); next unused
-- prefix after 116_labor_payroll_auto_post.sql.

ALTER TABLE boms
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by_user text;
