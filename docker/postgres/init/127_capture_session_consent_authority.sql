-- Server-owned consent authority metadata for capture sessions.
--
-- `consent_version` says which notice/policy was accepted. These fields record
-- who accepted it, under which server authority, and what scope the server
-- understood at capture start. Public portal grants can populate the same
-- columns later with consent_actor_kind='portal_guest'.

ALTER TABLE capture_sessions
  ADD COLUMN IF NOT EXISTS consent_actor_kind text,
  ADD COLUMN IF NOT EXISTS consent_actor_ref text,
  ADD COLUMN IF NOT EXISTS consent_authority text,
  ADD COLUMN IF NOT EXISTS consent_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS consented_at timestamptz;

CREATE INDEX IF NOT EXISTS capture_sessions_consent_actor_idx
  ON capture_sessions (company_id, consent_actor_kind, consent_actor_ref, started_at DESC)
  WHERE consent_actor_kind IS NOT NULL AND consent_actor_ref IS NOT NULL;
