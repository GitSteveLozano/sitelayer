-- Seed the dispatch lane for the async debug-bundle enrichment worker
-- (apps/worker/src/runners/debug-bundle.ts → processAssembleDebugBundle in
-- packages/queue/src/pushers/debug-bundle.ts). worker.ts wraps the runner in
-- runIfLaneActive('debug_bundle', ...); this row makes the dispatch-lanes-seed
-- parity test pass and lets operators pause/resume the lane from the admin UI.
--
-- The bundle worker drains mutation_type='assemble_debug_bundle' rows enqueued
-- at capture-session finalize for domain='app_issue', runs the env-gated
-- Sentry + Axiom pulls around the ALREADY-PINNED trace/request ids, and writes
-- a capture_artifact kind='debug_bundle' on the capture session. Pausing this
-- lane stops the enrichment without affecting the (synchronous) tier-0/1
-- anchors + timeline already woven at finalize.
--
-- The 3-value shape (name, state, last_decided_by='system:seed') matches the
-- canonical forward-migration lane-seed pattern (008_rental_invoice_push_lane);
-- the remaining NOT NULL columns default.
INSERT INTO public.dispatch_lanes (name, state, last_decided_by)
VALUES ('debug_bundle', 'active', 'system:seed')
ON CONFLICT DO NOTHING;

-- One live debug_bundle artifact per capture session. The bundle worker UPSERTs
-- the assembled Sentry/Axiom blob on (company_id, capture_session_id) for
-- kind='debug_bundle' so a re-claim after a crash (or a STEP6 escalation
-- re-run) overwrites the prior blob in place rather than appending a duplicate.
-- Partial so it only constrains the (rare) bundle rows — the high-volume
-- screenshot/rrweb/audio artifacts are untouched — and excludes soft-deleted
-- rows so a discarded-then-recaptured session can mint a fresh bundle.
-- This partial unique index is what the pusher's ON CONFLICT predicate matches.
CREATE UNIQUE INDEX IF NOT EXISTS capture_artifacts_one_debug_bundle_per_session
    ON public.capture_artifacts (company_id, capture_session_id)
    WHERE kind = 'debug_bundle' AND deleted_at IS NULL;

-- Widen the support_packet_access_log access_type CHECK to allow 'escalate'.
-- STEP6 (POST /api/issues/:id/escalate) records ONE access-log row per
-- external pull it re-runs (the tier-2/3 Sentry + Axiom enrichment around the
-- ALREADY-PINNED trace/request/event_ref), so the per-issue cost ledger reads
-- exactly which evidence the operator paid to fetch. Additive: every prior
-- value (read/list/agent_prompt/export) still passes; the baseline constraint
-- (000_baseline.sql) is left untouched, the widened one replaces it here.
ALTER TABLE public.support_packet_access_log
    DROP CONSTRAINT IF EXISTS support_packet_access_type_check;
ALTER TABLE public.support_packet_access_log
    ADD CONSTRAINT support_packet_access_type_check
    CHECK (access_type = ANY (ARRAY['read'::text, 'list'::text, 'agent_prompt'::text, 'export'::text, 'escalate'::text]));
