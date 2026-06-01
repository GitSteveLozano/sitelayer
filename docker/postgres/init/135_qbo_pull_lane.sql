-- 135_qbo_pull_lane.sql
--
-- QBO reference-data PULL worker lane (customers + items + classes backfill).
--
-- The push side (estimate_push, rental_billing_push, labor_payroll_push)
-- already drains through outbox-leased worker runners gated by a row in
-- dispatch_lanes (migration 094). The pull side historically ran inline in
-- the POST /api/integrations/qbo/sync request handler — no lease, no retry,
-- no circuit breaker, no kill-switch. This migration seeds the lane that
-- gates the new worker-backed pull runner (apps/worker/src/runners/qbo-pull.ts
-- → processQboPull in @sitelayer/queue), so an operator can pause the pull
-- without redeploying the worker with a flipped env flag — exactly like the
-- estimate_push lane lets a QBO live-flip be rolled back at runtime.
--
-- No new columns are required: integration_mappings, mutation_outbox,
-- sync_events, and integration_connections.sync_cursor all already exist and
-- are sufficient for v1 (a full re-pull each run, idempotent via the
-- integration_mappings on-conflict upserts). An incremental/CDC pull_cursor
-- column is intentionally out of scope and would land as a separate forward
-- migration.
--
-- Idempotent on re-run (DO NOTHING on the existing PK), matching the seed
-- convention in 094_dispatch_lanes.sql.

INSERT INTO dispatch_lanes (name, state, last_decided_by)
VALUES ('qbo_pull', 'active', 'system:seed')
ON CONFLICT (name) DO NOTHING;
