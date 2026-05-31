-- Capture sessions: the Sitelayer-local correlation spine for end-user usage.
--
-- This is intentionally additive. Existing app behavior keeps working without a
-- capture session. When one exists, web product traces, support packets,
-- context work items, worker issues, workflow rows, and later audio/rrweb/native
-- video artifacts can join through capture_session_id.

CREATE TABLE IF NOT EXISTS capture_sessions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id text,
  mode text NOT NULL DEFAULT 'trace',
  status text NOT NULL DEFAULT 'open',
  route_path text,
  device_kind text,
  platform text,
  viewport text,
  app_build_sha text,
  consent_version text NOT NULL DEFAULT '',
  redaction_version text NOT NULL DEFAULT 'capture-session-v1',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  discarded_at timestamptz,
  retention_expires_at timestamptz,
  CONSTRAINT capture_sessions_mode_check CHECK (mode IN ('trace', 'feedback', 'desktop', 'native', 'manual_upload')),
  CONSTRAINT capture_sessions_status_check CHECK (status IN ('open', 'stopped', 'discarded', 'failed', 'redacted'))
);

CREATE TABLE IF NOT EXISTS capture_session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL DEFAULT 0,
  client_event_id text,
  event_type text NOT NULL,
  event_class text NOT NULL DEFAULT '',
  route_path text,
  workflow_id text,
  entity_type text,
  entity_id text,
  request_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  redaction_version text NOT NULL DEFAULT 'capture-session-v1',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT capture_session_events_event_type_nonempty CHECK (btrim(event_type) <> '')
);

CREATE TABLE IF NOT EXISTS capture_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  capture_session_id uuid NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  storage_key text,
  uri text,
  content_type text,
  byte_size bigint,
  content_hash text,
  duration_ms integer,
  pii_level text NOT NULL DEFAULT 'internal',
  access_policy text NOT NULL DEFAULT 'support_only',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  retention_expires_at timestamptz,
  CONSTRAINT capture_artifacts_kind_nonempty CHECK (btrim(kind) <> ''),
  CONSTRAINT capture_artifacts_pii_level_check CHECK (pii_level IN ('low', 'internal', 'private', 'restricted')),
  CONSTRAINT capture_artifacts_access_policy_check CHECK (access_policy IN ('support_only', 'operator_only', 'tenant_visible'))
);

CREATE INDEX IF NOT EXISTS capture_sessions_company_recent_idx
  ON capture_sessions (company_id, started_at DESC);

CREATE INDEX IF NOT EXISTS capture_sessions_actor_recent_idx
  ON capture_sessions (company_id, actor_user_id, started_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS capture_session_events_session_seq_idx
  ON capture_session_events (company_id, capture_session_id, seq, occurred_at);

CREATE UNIQUE INDEX IF NOT EXISTS capture_session_events_client_event_uidx
  ON capture_session_events (company_id, capture_session_id, client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS capture_artifacts_session_created_idx
  ON capture_artifacts (company_id, capture_session_id, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE support_debug_packets
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

ALTER TABLE context_work_items
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

ALTER TABLE context_handoff_events
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

ALTER TABLE worker_issues
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

ALTER TABLE worker_issue_attachments
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

ALTER TABLE workflow_event_log
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

ALTER TABLE mutation_outbox
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

ALTER TABLE sync_events
  ADD COLUMN IF NOT EXISTS capture_session_id uuid;

CREATE INDEX IF NOT EXISTS support_debug_packets_capture_session_idx
  ON support_debug_packets (company_id, capture_session_id)
  WHERE capture_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS context_work_items_capture_session_idx
  ON context_work_items (company_id, capture_session_id)
  WHERE capture_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS context_handoff_events_capture_session_idx
  ON context_handoff_events (company_id, capture_session_id)
  WHERE capture_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS worker_issues_capture_session_idx
  ON worker_issues (company_id, capture_session_id)
  WHERE capture_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS worker_issue_attachments_capture_session_idx
  ON worker_issue_attachments (company_id, capture_session_id)
  WHERE capture_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS workflow_event_log_capture_session_idx
  ON workflow_event_log (company_id, capture_session_id, applied_at DESC)
  WHERE capture_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS mutation_outbox_capture_session_idx
  ON mutation_outbox (company_id, capture_session_id)
  WHERE capture_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sync_events_capture_session_idx
  ON sync_events (company_id, capture_session_id)
  WHERE capture_session_id IS NOT NULL;

DROP POLICY IF EXISTS company_isolation ON capture_sessions;
CREATE POLICY company_isolation ON capture_sessions
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

DROP POLICY IF EXISTS company_isolation ON capture_session_events;
CREATE POLICY company_isolation ON capture_session_events
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

DROP POLICY IF EXISTS company_isolation ON capture_artifacts;
CREATE POLICY company_isolation ON capture_artifacts
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

ALTER TABLE capture_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE capture_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_artifacts FORCE ROW LEVEL SECURITY;
