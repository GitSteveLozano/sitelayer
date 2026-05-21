-- Queue rows need a mutable timestamp for retry/backpressure diagnostics.
-- Worker runners already update this column when rows are applied, failed, or
-- rescheduled; this migration makes that contract explicit in fresh and
-- existing databases.

ALTER TABLE mutation_outbox
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE sync_events
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
