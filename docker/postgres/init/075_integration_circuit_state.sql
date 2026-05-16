-- 074_integration_circuit_state.sql
--
-- Telemetry follow-up: surface CircuitBreaker state to the API so the
-- Prometheus metrics endpoint can publish a
-- `sitelayer_circuit_breaker_state{integration}` gauge.
--
-- The breaker lives in-process in the worker (apps/worker/src/worker.ts),
-- but the metrics scrape happens in the API. Rather than bolting a
-- separate HTTP surface onto the worker, we persist breaker state to a
-- small key/value-shaped table that both sides can read/write under
-- normal transactional semantics. One row per integration key
-- (currently just `qbo`); the worker's `onOpen`/`onClose` callbacks
-- upsert, the API's `refreshQueueGauges()` reads.

CREATE TABLE IF NOT EXISTS integration_circuit_state (
  integration text PRIMARY KEY,
  state text NOT NULL DEFAULT 'closed',
  failure_count integer NOT NULL DEFAULT 0,
  last_error text,
  opened_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_circuit_state_state_chk CHECK (state IN ('closed', 'open'))
);
