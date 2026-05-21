-- Context handoff / Work Request substrate.
--
-- These tables are Sitelayer-local authority for context-aware work
-- requests. They deliberately do not replace workflow_event_log (deterministic
-- reducer replay) or mutation_outbox (adapter delivery/retry).

CREATE TABLE IF NOT EXISTS context_work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  support_packet_id uuid NOT NULL REFERENCES support_debug_packets(id) ON DELETE RESTRICT,
  title text NOT NULL,
  summary text,
  status text NOT NULL DEFAULT 'new',
  lane text NOT NULL DEFAULT 'triage',
  severity text,
  route text,
  entity_type text,
  entity_id text,
  assignee_user_id text,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT context_work_items_title_nonempty CHECK (btrim(title) <> ''),
  CONSTRAINT context_work_items_status_check CHECK (
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
      'wont_do'
    )
  ),
  CONSTRAINT context_work_items_lane_check CHECK (lane IN ('triage', 'human', 'agent', 'both', 'done')),
  CONSTRAINT context_work_items_severity_check CHECK (
    severity IS NULL OR severity IN ('low', 'normal', 'high', 'urgent')
  )
);

CREATE TABLE IF NOT EXISTS context_handoff_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES context_work_items(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_kind text NOT NULL,
  actor_user_id text,
  actor_ref text,
  source_system text NOT NULL DEFAULT 'sitelayer',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  causation_event_id uuid REFERENCES context_handoff_events(id) ON DELETE SET NULL,
  correlation_id uuid,
  request_id text,
  sentry_trace text,
  sentry_baggage text,
  build_sha text,
  redaction_version text NOT NULL DEFAULT 'v1',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_handoff_events_event_type_nonempty CHECK (btrim(event_type) <> ''),
  CONSTRAINT context_handoff_events_actor_kind_check CHECK (actor_kind IN ('user', 'agent', 'system', 'external'))
);

CREATE INDEX IF NOT EXISTS context_work_items_status_idx
  ON context_work_items (company_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS context_work_items_entity_status_idx
  ON context_work_items (company_id, entity_type, entity_id, status)
  WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS context_work_items_created_by_idx
  ON context_work_items (company_id, created_by_user_id, created_at DESC)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS context_work_items_support_packet_idx
  ON context_work_items (support_packet_id);

CREATE INDEX IF NOT EXISTS context_handoff_events_work_item_recorded_idx
  ON context_handoff_events (company_id, work_item_id, recorded_at ASC);

CREATE INDEX IF NOT EXISTS context_handoff_events_event_type_idx
  ON context_handoff_events (company_id, event_type, recorded_at DESC);

CREATE INDEX IF NOT EXISTS context_handoff_events_request_idx
  ON context_handoff_events (company_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS context_handoff_events_trace_idx
  ON context_handoff_events (company_id, sentry_trace)
  WHERE sentry_trace IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS context_handoff_events_idempotency_idx
  ON context_handoff_events (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

DROP POLICY IF EXISTS company_isolation ON context_work_items;
CREATE POLICY company_isolation ON context_work_items
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

DROP POLICY IF EXISTS company_isolation ON context_handoff_events;
CREATE POLICY company_isolation ON context_handoff_events
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

ALTER TABLE context_work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_work_items FORCE ROW LEVEL SECURITY;

ALTER TABLE context_handoff_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE context_handoff_events FORCE ROW LEVEL SECURITY;
