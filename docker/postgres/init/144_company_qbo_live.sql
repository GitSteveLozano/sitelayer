-- 144_company_qbo_live.sql
--
-- Per-company QBO live/dry-run flag (multi-tenant operation).
--
-- Until now the QBO push runners (rental-billing, estimate, labor-payroll,
-- damage-charge, qbo-pull) decided live-vs-stub from a single PROCESS-WIDE
-- env var (QBO_LIVE_RENTAL_INVOICE / QBO_LIVE_ESTIMATE_PUSH /
-- QBO_LIVE_LABOR_PAYROLL / QBO_LIVE_DAMAGE_INVOICE / QBO_LIVE_QBO_PULL).
-- With one worker draining a single tenant that was fine; once the worker
-- drains ALL companies, a global env can't keep company #2 in dry-run while
-- company #1 is live.
--
-- This column moves the live decision PER COMPANY. integration_connections
-- is the natural home: it is already the per-(company, provider) QBO
-- connection row (one row per company for provider='qbo'), carries the
-- tokens/realm/status the push fns read, and is created at QBO-connect time
-- (001_schema.sql seeds one for la-operations; the OAuth callback inserts
-- one per company that connects). A boolean here is read by the same tx
-- client the push already uses — no extra lookup table, no extra join.
--
-- ── FAIL-SAFE / NO ACCIDENTAL GO-LIVE ───────────────────────────────────
-- DEFAULT false. Backfilled false for every existing row. This matches
-- today's behavior exactly: no company goes live unless an operator
-- explicitly flips this flag true. The push dispatchers compute:
--
--     live = GLOBAL_KILL_SWITCH_ON (env QBO_LIVE_* === '1')
--            AND integration_connections.qbo_live_enabled = true
--
-- so the GLOBAL env becomes a CLUSTER-WIDE KILL SWITCH: if it is '0'/unset,
-- NO company goes live regardless of this per-company flag. Both must agree
-- for a real Intuit POST to happen; either alone keeps the company in
-- stub/dry-run mode (synthetic ids, full deterministic plumbing, zero QBO
-- HTTP calls).
--
-- Additive / expand-only and idempotent on re-run (ADD COLUMN IF NOT
-- EXISTS). Tolerates the old schema during rollout: old worker code never
-- reads this column (it reads only the env); new worker code reads it but
-- the DEFAULT false leaves every company in the exact pre-rollout
-- (env-only) dry-run posture. No applied migration is edited.

ALTER TABLE integration_connections
  ADD COLUMN IF NOT EXISTS qbo_live_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN integration_connections.qbo_live_enabled IS
  'Per-company QBO live/dry-run switch for the worker push runners. false '
  '(default) = stub/dry-run (synthetic ids, no Intuit POST). true = this '
  'company MAY push to real QBO, but ONLY when the cluster-wide kill switch '
  '(env QBO_LIVE_*=1) also allows it. live = global-env-on AND this-flag-on; '
  'either off keeps the company in dry-run. Fail-safe: no company goes live '
  'by default.';
