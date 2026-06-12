-- 018_takeoff_capture_async.sql
--
-- Async + honest AI blueprint-capture pipeline (one feature = one migration).
--
-- 1) takeoff_drafts capture lifecycle columns. POST /api/projects/:id/
--    takeoff-drafts/capture no longer awaits the Gemini/Anthropic vision call
--    inline in the HTTP handler: a LIVE capture inserts the draft at
--    capture_status='processing' and enqueues a dedicated
--    'takeoff_capture_pipeline' mutation_outbox row; the worker runner
--    (apps/worker/src/runners/takeoff-capture.ts) executes the pipeline and
--    transitions the draft to 'ready' (result + provenance + REAL token
--    usage) or 'failed' (provider error surfaced, ZERO fabricated rows).
--    Deterministic dry-run captures stay synchronous and insert at 'ready'.
--
--    - capture_status: 'ready' default keeps every pre-existing row (manual
--      drafts + already-completed captures) reviewable with no backfill.
--    - capture_provenance: honesty discriminator for HOW the stored
--      takeoff_result_json was produced. 'gemini-live' / 'anthropic-live' =
--      a real provider call; 'stub-dry-run' = the deterministic demo stub
--      (count-scope dry-runs included); 'deterministic' = the non-AI
--      pipelines (roomplan / photogrammetry / drone) that parse real
--      captured input with no model call. NULL = manual draft (no pipeline)
--      or a pre-migration capture row whose provenance was never recorded.
--      Provider errors NEVER produce stub rows — a failed live call is a
--      'failed' draft with capture_error set and takeoff_result_json NULL.
--    - capture_error: provider/pipeline error message for status='failed'.
--    - capture_token_usage: REAL token usage from the provider response
--      (Gemini usageMetadata / Anthropic usage), shape
--      { provider, model, input_tokens, output_tokens, billed_usd? }.
--      Replaces the retired flat $0.25/page cost fiction.
ALTER TABLE public.takeoff_drafts
  ADD COLUMN IF NOT EXISTS capture_status text DEFAULT 'ready' NOT NULL,
  ADD COLUMN IF NOT EXISTS capture_provenance text,
  ADD COLUMN IF NOT EXISTS capture_error text,
  ADD COLUMN IF NOT EXISTS capture_token_usage jsonb;

-- Pin the unions. Guarded so a re-run is a no-op (same pattern as
-- 009_work_item_domain_and_platform_grants.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'takeoff_drafts_capture_status_check'
  ) THEN
    ALTER TABLE public.takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_capture_status_check
      CHECK (capture_status IN ('processing', 'ready', 'failed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'takeoff_drafts_capture_provenance_check'
  ) THEN
    ALTER TABLE public.takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_capture_provenance_check
      CHECK (
        capture_provenance IS NULL
        OR capture_provenance IN ('gemini-live', 'anthropic-live', 'stub-dry-run', 'deterministic')
      );
  END IF;
END
$$;

COMMENT ON COLUMN public.takeoff_drafts.capture_status IS
  'Async capture lifecycle: processing (worker owns it) | ready (reviewable) | failed (capture_error set, no result rows). Default ready covers manual drafts and synchronous dry-run captures.';
COMMENT ON COLUMN public.takeoff_drafts.capture_provenance IS
  'How takeoff_result_json was produced: gemini-live | anthropic-live (real provider call, capture_token_usage carries real usage) | stub-dry-run (deterministic demo stub) | deterministic (non-AI roomplan/photogrammetry/drone parse). NULL = manual draft or pre-018 row.';
COMMENT ON COLUMN public.takeoff_drafts.capture_token_usage IS
  'Real provider token usage for live captures: { provider, model, input_tokens, output_tokens, billed_usd? }. Never estimated; NULL when no live call happened.';

-- 2) Seed the dispatch lane for the async capture runner. worker.ts wraps the
--    runner in runIfLaneActive('takeoff_capture_pipeline', ...); this row makes
--    the dispatch-lanes-seed parity test pass and gives operators a dedicated
--    kill-switch for AI blueprint captures. Pausing the lane is SAFE under the
--    inverted outbox contract: takeoff_capture_pipeline rows stay pending for
--    this runner; the generic drain can never claim them. (Pattern precedent:
--    008_rental_invoice_push_lane.sql / 017_send_estimate_share_lane.sql.)
INSERT INTO public.dispatch_lanes (name, state, last_decided_by)
VALUES ('takeoff_capture_pipeline', 'active', 'system:seed')
ON CONFLICT DO NOTHING;
