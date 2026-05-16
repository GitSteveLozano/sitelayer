-- workflow_event_log: add sentry_baggage column.
--
-- Closes a trace-propagation gap from the 2026-05-16 verification audit.
-- workflow_event_log already had request_id + sentry_trace (migration 020),
-- but baggage was missing — every other trace-carrying ledger table
-- (mutation_outbox, sync_events, audit_events) already persists baggage,
-- and the apps/api currentTraceHeaders() helper returns both. Without the
-- column the helper had nowhere to write the baggage half of the W3C
-- header pair, so cross-service trace links from the SPA → API → workflow
-- transition row dropped the baggage propagation context.
--
-- Additive, nullable, no backfill required — historical rows simply
-- have NULL baggage which matches "no trace was active at the time".

ALTER TABLE workflow_event_log
  ADD COLUMN IF NOT EXISTS sentry_baggage text;
