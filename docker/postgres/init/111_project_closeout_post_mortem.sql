-- 111_project_closeout_post_mortem.sql
--
-- Post-mortem terminal state for the project_closeout workflow.
--
-- The closeout reducer gains a third state: active → completed → post_mortem.
-- `completed` now means "work done, summary locked, post-mortem not yet
-- acknowledged"; `post_mortem` means "the owner has reviewed the post-mortem
-- and the record is closed". The human ACKNOWLEDGE_POST_MORTEM event records
-- WHEN and WHO acknowledged on these two new columns.
--
-- Pure expand (additive, nullable). Existing `completed` projects have
-- post_mortem_acknowledged_at = NULL, so they keep reading as `completed`
-- (post-mortem pending) — the desired default; they are NOT auto-promoted to
-- post_mortem. No state_version rewrite: the ACKNOWLEDGE_POST_MORTEM event
-- bumps state_version only when a human acknowledges, and the workflow_event_log
-- unique key is workflow-scoped (migration 106). No backfill, no contract step.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS post_mortem_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS post_mortem_acknowledged_by text;
