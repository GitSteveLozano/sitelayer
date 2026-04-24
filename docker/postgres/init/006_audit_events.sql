CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL DEFAULT 'system',
  actor_role text,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  request_id text,
  sentry_trace text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_entity_idx
  ON audit_events (company_id, entity_type, entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit_events (company_id, actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_request_idx
  ON audit_events (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS audit_events_company_recent_idx
  ON audit_events (company_id, created_at DESC);
