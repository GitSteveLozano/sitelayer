ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS applied_at timestamptz;
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS error text;

CREATE INDEX IF NOT EXISTS mutation_outbox_ready_idx
  ON mutation_outbox (company_id, status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS sync_events_ready_idx
  ON sync_events (company_id, status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'processing');
