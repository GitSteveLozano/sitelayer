-- Global executor-audience health signal for /api/ops/diagnostics.
-- This stores only timestamps for machine-token agent-feed polls; it contains
-- no tenant payloads, bearer tokens, or callback bodies.
CREATE TABLE IF NOT EXISTS public.agent_feed_audience_liveness (
  audience TEXT PRIMARY KEY,
  last_poll_at TIMESTAMPTZ NOT NULL,
  last_claim_at TIMESTAMPTZ,
  last_callback_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_feed_audience_liveness_audience_nonempty CHECK (btrim(audience) <> '')
);

CREATE INDEX IF NOT EXISTS idx_agent_feed_audience_liveness_last_poll
  ON public.agent_feed_audience_liveness (last_poll_at DESC);
