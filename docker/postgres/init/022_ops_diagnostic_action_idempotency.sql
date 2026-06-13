-- Idempotent onsite action requests from unreliable mobile networks.
-- The client_action_id is caller-provided and scoped to a session/action; result
-- stores the accepted_action payload so a replay can return without re-running
-- capture-router or evidence side effects.
ALTER TABLE public.ops_diagnostic_session_events
  ADD COLUMN IF NOT EXISTS client_action_id text,
  ADD COLUMN IF NOT EXISTS result jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS ops_diagnostic_session_events_client_action_idx
  ON public.ops_diagnostic_session_events (company_id, session_id, action_key, client_action_id)
  WHERE event_type = 'action.requested'
    AND action_key IS NOT NULL
    AND client_action_id IS NOT NULL;
