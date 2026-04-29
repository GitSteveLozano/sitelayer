CREATE TABLE IF NOT EXISTS support_debug_packets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id text NOT NULL,
  request_id text,
  route text,
  build_sha text,
  problem text,
  client jsonb NOT NULL DEFAULT '{}'::jsonb,
  server_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  redaction_version text NOT NULL DEFAULT 'support-packet-v1'
);

CREATE INDEX IF NOT EXISTS support_debug_packets_company_created_idx
  ON support_debug_packets (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS support_debug_packets_actor_created_idx
  ON support_debug_packets (company_id, actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS support_debug_packets_request_idx
  ON support_debug_packets (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS support_debug_packets_expires_idx
  ON support_debug_packets (expires_at)
  WHERE expires_at IS NOT NULL;
