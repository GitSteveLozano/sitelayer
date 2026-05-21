-- Audit reads of support/debug packets. These packets carry redacted but still
-- sensitive operational context, so access needs its own append-only trail.

CREATE TABLE IF NOT EXISTS support_packet_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  support_packet_id uuid NOT NULL REFERENCES support_debug_packets(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  access_type text NOT NULL,
  route text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT support_packet_access_type_check CHECK (
    access_type IN ('read', 'list', 'agent_prompt', 'export')
  )
);

CREATE INDEX IF NOT EXISTS support_packet_access_packet_created_idx
  ON support_packet_access_log (company_id, support_packet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS support_packet_access_actor_created_idx
  ON support_packet_access_log (company_id, actor_user_id, created_at DESC);

DROP POLICY IF EXISTS company_isolation ON support_packet_access_log;
CREATE POLICY company_isolation ON support_packet_access_log
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

ALTER TABLE support_packet_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_packet_access_log FORCE ROW LEVEL SECURITY;
