-- Per-dispatch callback tokens replace the broad shared webhook secret for
-- context work requests. The raw token is sent only in the dispatch payload to
-- the agent system; Sitelayer stores a SHA-256 hash for callback validation.

ALTER TABLE context_work_items
  ADD COLUMN IF NOT EXISTS agent_callback_token_hash text,
  ADD COLUMN IF NOT EXISTS agent_callback_token_issued_at timestamptz;

CREATE INDEX IF NOT EXISTS context_work_items_callback_token_idx
  ON context_work_items (company_id, agent_callback_token_issued_at DESC)
  WHERE agent_callback_token_hash IS NOT NULL;
