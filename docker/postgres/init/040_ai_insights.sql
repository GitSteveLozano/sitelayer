-- Phase 5: AI Layer.
--
-- ai_insights stores outputs from agent runs (takeoff → bid agent,
-- bid-accuracy summarizer, etc.) and the user's interaction with each
-- (dismissed, applied, ignored). The "dismiss-as-signal" rule from the
-- design says every dismissal is recorded so the agent loop can learn —
-- never silently dropped.
--
-- The shape is intentionally generic across insight kinds: a kind tag,
-- an entity ref (project / takeoff / rental), a JSON payload with the
-- structured suggestion, an ordinal confidence (low | med | high — not
-- a numeric pct, per the design rule), the source claim, and the user
-- action history.

CREATE TABLE IF NOT EXISTS ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence text NOT NULL DEFAULT 'med'
    CHECK (confidence IN ('low', 'med', 'high')),
  attribution text NOT NULL,
  source_run_id text,
  produced_by text NOT NULL DEFAULT 'system',
  applied_at timestamptz,
  applied_by text,
  dismissed_at timestamptz,
  dismissed_by text,
  dismiss_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_insights_company_kind_idx
  ON ai_insights (company_id, kind, created_at desc);

CREATE INDEX IF NOT EXISTS ai_insights_entity_idx
  ON ai_insights (company_id, entity_type, entity_id)
  WHERE entity_id IS NOT NULL;

-- Open insights — the dashboard queries this slice frequently.
CREATE INDEX IF NOT EXISTS ai_insights_open_idx
  ON ai_insights (company_id, created_at desc)
  WHERE applied_at IS NULL AND dismissed_at IS NULL;
