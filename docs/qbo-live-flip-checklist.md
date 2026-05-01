# QBO Live-Flip Checklist

Pre-flight for flipping the GitHub production environment variables
`QBO_LIVE_ESTIMATE_PUSH=1` and `QBO_LIVE_RENTAL_INVOICE=1`.
Production runtime env is rendered from `ops/env/production.env.json`
by `.github/workflows/deploy-droplet.yml`; do not hand-edit the
droplet `.env` except for emergency break-glass, because the next deploy
will overwrite it.

Worker push impl gates: `apps/worker/src/worker.ts` reads
`QBO_LIVE_RENTAL_INVOICE` for rental invoices and
`QBO_LIVE_ESTIMATE_PUSH` for estimates. Until the flags are `1`, both
code paths return synthetic STUB ids. After the flip, the next worker
boot logs `live QBO ... push enabled` instead of the stub line.

## Pre-flip

- [ ] **Sandbox smoke passes against current env.**
  - Run `bash scripts/qbo-sandbox-smoke.sh` on a host with sandbox
    creds in env (`QBO_SANDBOX_BASE_URL`, `QBO_SANDBOX_REALM_ID`,
    `QBO_SANDBOX_REFRESH_TOKEN`, `QBO_SANDBOX_CLIENT_ID`,
    `QBO_SANDBOX_CLIENT_SECRET`).
  - Re-run with `RENTAL_INVOICE_TEST=1` to exercise the
    presigned-URL line description path before flipping
    `QBO_LIVE_RENTAL_INVOICE`.
  - Confirm exit 0 and capture the rotated refresh token from the
    `/tmp/qbo-smoke-*.log` file. The refresh token rotates on every
    exchange — failing to capture it here is a self-inflicted
    auth outage at the next run.

- [ ] **Sentry alerts wired for QBO 4xx/5xx in worker.**
  - Worker code already calls `Sentry.captureException` with
    `tags: { scope: 'estimate_push' | 'rental_billing_invoice_push' }`
    on every drain failure (see `worker.ts:546-555`) and
    `Sentry.captureMessage` with
    `tags.scope=workflow_stuck_posting` on stuck-in-posting rows
    (see `worker.ts:476-508`, threshold env
    `WORKFLOW_STUCK_POSTING_MINUTES`, default 30 min).
  - Verify in Sentry UI that an alert rule fires on:
    - new issue with tag `scope:estimate_push` or
      `scope:rental_billing_invoice_push` in `sitelayer-worker`
      project; AND
    - any issue with tag `scope:workflow_stuck_posting`.
  - If `scripts/sentry-provision-alerts.sh` only provisions the
    `sitelayer-api` and `sitelayer-web` projects today, add a
    `sitelayer-worker` rule (or extend the script).

- [ ] **OAuth refresh interval verified (token expiry vs cron
      cadence).**
  - QBO access tokens expire in ~3600s (1 h); refresh tokens are
    long-lived (~100 days) but rotate on every exchange.
  - The worker refreshes proactively when `access_token_expires_at` is
    missing/about to expire and refreshes once on a QBO 401 via
    `apps/worker/src/qbo-token-refresh.ts`.
  - Before flipping live, confirm the branch running in prod includes
    `docker/postgres/init/025_qbo_token_expiry.sql` and the
    `integration_connections.access_token_expires_at` column exists.
  - Confirm a sandbox refresh test produces a fresh `access_token` and
    captures the rotated `refresh_token` back into the DB row.

- [ ] **Rollback plan: how to flip `QBO_LIVE_*=0` quickly if errors
      spike.**
  - Preferred rollback: set these GitHub production environment
    variables back to `0`, run the production deploy workflow, and
    confirm the worker restart logs the stub mode line:

    ```sh
    gh variable set QBO_LIVE_ESTIMATE_PUSH --env production --body 0
    gh variable set QBO_LIVE_RENTAL_INVOICE --env production --body 0
    gh workflow run deploy-droplet.yml --ref main
    ```

  - Emergency break-glass only: edit the droplet env and restart the
    worker, then backfill GitHub variables immediately so the next deploy
    does not re-enable live mode.
  - Worker boots back into stub mode (`STUB-EST-...`,
    `STUB-INV-...` ids); no in-flight work is lost because
    `processEstimatePush` / `processRentalBillingInvoicePush`
    are idempotent on `qbo_estimate_id` / `qbo_invoice_id` — a
    row already POSTed to QBO will be skipped on retry.
  - For a single offending row only, prefer
    `UPDATE estimate_pushes SET status='failed' WHERE id=$1`
    (or the rental-billing equivalent) over a global flag flip;
    keeps healthy rows pushing.
  - **DO NOT** edit `worker.ts:348` or `:376` to hardcode the
    flag — the env-var indirection is the rollback lever.

- [ ] **First-48h monitoring queries.**
  - Sentry (project `sitelayer-worker`):
    - Issues -> filter `scope:estimate_push OR scope:rental_billing_invoice_push` over 24 h.
    - Issues -> filter `scope:workflow_stuck_posting` over 24 h.
  - Postgres (run on prod via `psql $DATABASE_URL`):

    ```sql
    -- last 48 h estimate push terminal states
    select status, count(*) from estimate_pushes
    where updated_at > now() - interval '48 hours'
    group by status order by 2 desc;

    -- last 48 h rental billing terminal states
    select status, count(*) from rental_billing_runs
    where updated_at > now() - interval '48 hours'
    group by status order by 2 desc;

    -- anything stuck in posting
    select id, state_version, updated_at
    from estimate_pushes
    where status = 'posting' and deleted_at is null
      and updated_at < now() - interval '30 minutes';
    select id, state_version, updated_at
    from rental_billing_runs
    where status = 'posting' and deleted_at is null
      and updated_at < now() - interval '30 minutes';

    -- worker outbox depth — should not grow unboundedly
    select mutation_type, status, count(*)
    from mutation_outbox
    where mutation_type in ('post_qbo_invoice','post_qbo_estimate')
    group by 1,2;
    ```

  - Worker logs (on prod):
    ```sh
    docker compose -f docker-compose.prod.yml logs --tail=500 worker | \
      grep -E 'estimate-push|rental-billing|qbo'
    ```
  - First non-zero `_failed` count in `[worker] tick` JSON or any
    `scope:workflow_stuck_posting` Sentry hit -> follow the
    rollback plan above, then triage.

## Flip

Follow `DEPLOY_RUNBOOK.md` -> "Live-flag flip protocol":

1. Set the env var(s) in GitHub production environment variables:
   `QBO_LIVE_ESTIMATE_PUSH`, `QBO_LIVE_RENTAL_INVOICE`,
   `QBO_BASE_URL`, and `QBO_RENTAL_INCOME_ACCOUNT_ID` when needed.
2. Run the production deploy workflow from `main`; it renders the
   droplet env and restarts services through `docker-compose.prod.yml`.
3. Watch the next worker heartbeat for the `live QBO ... push enabled`
   line.
4. Drive one billing run end-to-end (`APPROVE` -> `POST_REQUESTED`)
   and verify the QBO sandbox or prod company shows the row.
5. Update `DEPLOY_RUNBOOK.md` -> "Pilot-readiness checklist" to tick
   the QBO smoke item.

## Notes

- CLAUDE.md operating rule #1: the smoke script will fail loud if
  required env is missing. Do not patch in localhost defaults.
- CLAUDE.md operating rule #5: any periodic refresh-token job goes
  in mesh `periodic_tasks` OR a systemd timer, never both.
- The smoke script is hand-run, not CI. CI runs
  `apps/api/src/qbo-material-bill-sync.test.ts` against a localhost
  HTTP mock (catches request-shape regressions, not auth or rate
  limit).
