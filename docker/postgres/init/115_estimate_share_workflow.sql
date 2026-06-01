-- 115_estimate_share_workflow.sql
--
-- Promote the estimate-share send→accept/decline lifecycle into the
-- registered `estimate_share` deterministic workflow
-- (packages/workflows/src/estimate-share.ts). Until now the share
-- lifecycle lived only as denormalized stamps on estimate_share_links
-- (accepted_at / declined_at / viewed_at / expires_at) plus frontend
-- machines reconstructing it ad-hoc — no reducer, no state column, no
-- event log. This migration adds the workflow-state columns so the
-- portal/admin routes can dispatch through the reducer + record
-- workflow_event_log rows like every other workflow.
--
-- Expand/backfill only (CLAUDE.md deploy rule 2: migrations are
-- immutable once committed; schema changes are additive forward
-- migrations). The contract step (dropping the shareStatus() derive
-- fallback in the routes) happens in code once the backfill is verified.
--
-- accepted_at / declined_at / viewed_at / expires_at / signer_* already
-- exist (052_estimate_share_links.sql); this only adds the columns the
-- reducer owns that were missing.

-- EXPAND --------------------------------------------------------------
ALTER TABLE estimate_share_links
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS state_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS message text,
  ADD COLUMN IF NOT EXISTS include_signed_link boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

-- BACKFILL ------------------------------------------------------------
-- Derive the workflow state from the existing denormalized stamps — the
-- same precedence shareStatus()/computeTimelineStatus() applies in
-- application code, lifted into SQL once. Terminal stamps win over
-- viewed; everything not yet viewed and not expired is `sent`.
-- state_version stays at the column default of 1: pre-cutover rows have
-- no workflow_event_log rows, so the replay corpus starts fresh for them
-- (documented as a v1 cutover — applyEventLog iterates the event log,
-- which is empty for these rows, so there is no replay failure).
UPDATE estimate_share_links
SET status = CASE
  WHEN accepted_at IS NOT NULL THEN 'accepted'
  WHEN declined_at IS NOT NULL THEN 'declined'
  WHEN revoked_at IS NOT NULL THEN 'revoked'
  WHEN expires_at <= now() THEN 'expired'
  WHEN viewed_at IS NOT NULL THEN 'viewed'
  ELSE 'sent'
END
WHERE status IS NULL;

-- Index the workflow-state lookups the admin/portal list + the expiry
-- sweep need (mirrors estimate_share_links_pending_idx intent).
CREATE INDEX IF NOT EXISTS estimate_share_links_status_idx
  ON estimate_share_links (company_id, status);
