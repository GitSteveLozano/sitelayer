-- Reversibility window for context_work_items.
--
-- Mirrors the mesh-side column (BIGINT NOT NULL DEFAULT) shipped in mesh
-- migration 261 so values round-trip identically between Sitelayer and Mesh.
-- Default 86400 (24h) matches what apps/worker/src/runners/context-work-dispatch.ts
-- has been sending outbound.
--
-- See docs/PROVING_GROUND_PLAN.md (Wedge 1) for the broader rationale.

ALTER TABLE context_work_items
  ADD COLUMN IF NOT EXISTS reversibility_window_seconds bigint NOT NULL DEFAULT 86400;

ALTER TABLE context_work_items
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

-- Allow 'reversed' as a terminal status. The original constraint in 088
-- enumerates the legal statuses via CHECK; we must drop and recreate it.
ALTER TABLE context_work_items
  DROP CONSTRAINT IF EXISTS context_work_items_status_check;

ALTER TABLE context_work_items
  ADD CONSTRAINT context_work_items_status_check CHECK (
    status IN (
      'new',
      'triaged',
      'agent_running',
      'human_assigned',
      'review_ready',
      'review_stale',
      'proposal_expired',
      'resolved',
      'reopened',
      'wont_do',
      'reversed'
    )
  );

-- Reversibility window expiry index for "expires soon" / obstruction-style queries.
-- Skip terminal items (resolved/cancelled/wont_do/reversed) because they cannot be reversed.
CREATE INDEX IF NOT EXISTS idx_context_work_items_reversibility_active
  ON context_work_items ((created_at + reversibility_window_seconds * interval '1 second'))
  WHERE status NOT IN ('resolved', 'wont_do', 'reversed');
