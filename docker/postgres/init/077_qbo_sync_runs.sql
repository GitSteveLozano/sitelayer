-- 074_qbo_sync_runs.sql
--
-- QBO sync runs — the durable workflow row for each
-- POST /api/integrations/qbo/sync invocation. Promotes the implicit
-- state-machine that previously lived in `integration_connections.status`
-- ('connected' / 'connecting' / 'error') into a first-class, replayable
-- workflow row.
--
-- The pre-existing `integration_connections.status` column stays as a
-- derived/cached flag for backwards-compatible API surfaces; the
-- authoritative state machine now lives in `qbo_sync_runs.status` and
-- `qbo_sync_runs.state_version`, fed through the workflow reducer in
-- packages/workflows/src/qbo-sync-run.ts.
--
-- States (see qbo-sync-run.ts):
--   pending → syncing → succeeded | failed → retrying → syncing → ...
--
-- Events emitted by the route + worker:
--   START_SYNC      (route, human-initiated) → pending → syncing
--   SYNC_SUCCEEDED  (worker-only)            → syncing → succeeded
--   SYNC_FAILED     (worker-only)            → syncing → failed
--   RETRY           (route, human-initiated) → failed  → retrying
--
-- `failed` is non-terminal — RETRY brings it back into the loop. The
-- reducer enforces this; the API surface refuses worker-only events at
-- the human endpoint via parseQboSyncRunEventRequest.

CREATE TABLE IF NOT EXISTS qbo_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  integration_connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'pending',
  state_version int NOT NULL DEFAULT 1,

  -- Timestamps stamped by transitions (NULLable; populated as the run
  -- moves through the reducer).
  started_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  retried_at timestamptz,

  -- Last error payload from a SYNC_FAILED transition. Cleared on RETRY.
  error text,

  -- Sync summary populated on SYNC_SUCCEEDED — same shape the route
  -- already returns (synced customers/items/divisions, pulled time
  -- activities + bills counts).
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Who triggered the run (Clerk user id when human; NULL for periodic
  -- worker-triggered runs).
  triggered_by text,

  workflow_engine text NOT NULL DEFAULT 'postgres',
  workflow_run_id text,

  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS qbo_sync_runs_company_status_idx
  ON qbo_sync_runs (company_id, status, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS qbo_sync_runs_connection_idx
  ON qbo_sync_runs (integration_connection_id, created_at DESC)
  WHERE deleted_at IS NULL;

