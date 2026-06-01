-- Migration 131: durable product-trace forward state.
--
-- The mesh trace forwarder is intentionally isolated from the worker's
-- critical queue paths, but it still needs a local proof ledger: which
-- workflow/capture events were forwarded, which failed, and which can be
-- retried. This table is the Sitelayer-side checkpoint for the learning loop.

CREATE TABLE IF NOT EXISTS mesh_trace_forward_state (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_ref text NOT NULL,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  capture_session_id uuid,
  project_key text NOT NULL DEFAULT 'sitelayer',
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  forwarded_at timestamptz,
  last_status integer,
  last_error text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (company_id, event_ref),
  CONSTRAINT mesh_trace_forward_state_status_check
    CHECK (status IN ('pending', 'forwarded', 'failed')),
  CONSTRAINT mesh_trace_forward_state_source_kind_check
    CHECK (source_kind IN ('workflow_event_log', 'capture_session_event'))
);

CREATE INDEX IF NOT EXISTS mesh_trace_forward_state_pending_idx
  ON mesh_trace_forward_state (status, last_attempt_at NULLS FIRST, first_seen_at)
  WHERE status <> 'forwarded';

CREATE INDEX IF NOT EXISTS mesh_trace_forward_state_capture_session_idx
  ON mesh_trace_forward_state (company_id, capture_session_id, first_seen_at DESC)
  WHERE capture_session_id IS NOT NULL;

DROP POLICY IF EXISTS company_isolation ON mesh_trace_forward_state;
CREATE POLICY company_isolation ON mesh_trace_forward_state
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

ALTER TABLE mesh_trace_forward_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE mesh_trace_forward_state FORCE ROW LEVEL SECURITY;
