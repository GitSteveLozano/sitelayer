-- One-time onsite diagnostic control handoff tokens.
-- A transfer action creates a pending transfer hash; /control/redeem exchanges
-- it once for the next live control token and clears the pending hash.
ALTER TABLE public.ops_diagnostic_sessions
  ADD COLUMN IF NOT EXISTS pending_control_transfer_hash text;
