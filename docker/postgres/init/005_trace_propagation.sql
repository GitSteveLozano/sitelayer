-- Cross-process trace propagation: carry Sentry / W3C traceparent context
-- from API-side enqueue through the worker that claims the row. Opaque
-- text columns so the queue layer does not need to parse them.

ALTER TABLE mutation_outbox
  ADD COLUMN IF NOT EXISTS sentry_trace text,
  ADD COLUMN IF NOT EXISTS sentry_baggage text,
  ADD COLUMN IF NOT EXISTS request_id text;

ALTER TABLE sync_events
  ADD COLUMN IF NOT EXISTS sentry_trace text,
  ADD COLUMN IF NOT EXISTS sentry_baggage text,
  ADD COLUMN IF NOT EXISTS request_id text;

-- Indexing request_id lets the debug endpoint answer
-- "show me every queue row tied to this request" cheaply.
CREATE INDEX IF NOT EXISTS mutation_outbox_request_id_idx
  ON mutation_outbox (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS sync_events_request_id_idx
  ON sync_events (request_id)
  WHERE request_id IS NOT NULL;
