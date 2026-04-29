-- Append-only workflow event log.
--
-- Every transition applied through a deterministic workflow reducer writes
-- one row here in the same transaction as the state update. Becomes the
-- replay corpus for regression testing: feeding the event stream back
-- through the reducer must reproduce the persisted snapshot bit-for-bit.
--
-- Design notes:
--   - workflow_name + entity_id is the stream key; (entity_id, state_version)
--     is unique so duplicate writes for the same transition are rejected.
--   - state_version is the version BEFORE the transition (i.e. the version
--     the event was dispatched against). The new version is implied as +1.
--   - schema_version pins the reducer signature; replays at a different
--     schema_version are explicit migrations, not silent drifts.
--   - actor_user_id is nullable so worker-emitted events (POST_SUCCEEDED,
--     POST_FAILED) record cleanly without a synthetic user.
--   - event_payload is the full reducer event as JSON, so replays can
--     reconstruct (event_type, approved_by, qbo_invoice_id, ...) without
--     re-deriving from the resulting row.
--   - snapshot_after is the full reducer-output snapshot for fast replay
--     verification without re-running every step from scratch.

CREATE TABLE workflow_event_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  workflow_name text NOT NULL,
  schema_version int NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  state_version int NOT NULL,
  event_type text NOT NULL,
  event_payload jsonb NOT NULL,
  snapshot_after jsonb NOT NULL,
  actor_user_id text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  request_id text,
  sentry_trace text,
  UNIQUE (entity_id, state_version)
);

CREATE INDEX workflow_event_log_company_workflow_idx
  ON workflow_event_log (company_id, workflow_name, applied_at DESC);

CREATE INDEX workflow_event_log_entity_idx
  ON workflow_event_log (entity_id, state_version);

CREATE INDEX workflow_event_log_workflow_applied_idx
  ON workflow_event_log (workflow_name, applied_at DESC);
