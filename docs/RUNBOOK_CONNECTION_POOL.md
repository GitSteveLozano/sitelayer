# Runbook — Postgres Connection Pool Exhaustion

**When to read this:** API is throwing 503s, requests time out at the pg
connect step, and you suspect the app has run out of pool slots against the
managed Postgres instance.

**Related code:** `apps/api/src/server.ts` (pool configuration, default
`PG_POOL_MAX=40` in prod, `idleTimeoutMillis=30s`).

## Symptom

- API returns 503 on previously-healthy routes; `/health` flaps.
- API logs (`docker compose logs api`) show:
  - `Connection terminated unexpectedly`
  - `timeout exceeded when trying to connect`
  - `Error: Connection terminated` from `pg`
- Sentry `sitelayer-api` shows a spike of `DatabaseError` /
  `error: terminating connection` issues.

## Detection

> **No Prometheus today.** `/api/metrics` is exposed (gated by
> `API_METRICS_TOKEN`) but **nothing scrapes it** — there is no Prometheus
> server and no alerting on these series. The metric names below are real and
> you can curl `/api/metrics` ad hoc, but treat "graph the gauge" as "curl it
> twice and eyeball the delta", and rely on Sentry + the `pg_stat_activity`
> queries below as the live detection surface. Wiring a scraper + alerts is
> tracked as open work.

- **HTTP error rate:** `sitelayer_http_request_errors_total` rate
  (anything > 0.5/s sustained is bad) — curl `/api/metrics` (not scraped; see
  note above).
- **From the droplet:**

  ```bash
  doctl compute ssh sitelayer --ssh-command="
    docker run --rm --network host \
      -e PGURL=\"\$(grep ^DATABASE_URL= /app/sitelayer/.env | cut -d= -f2-)\" \
      postgres:18-alpine \
      psql \"\$PGURL\" -c 'SELECT count(*), state FROM pg_stat_activity GROUP BY state;'
  "
  ```

  Normal: ~5–15 `active` + small `idle` count. Bad: dozens of
  `idle in transaction` or `idle` totaling near
  `PG_POOL_MAX × replicas` (default `40 × 1 api = 40`, plus the worker's
  own pool).

- **Long-running queries:**

  ```sql
  SELECT pid, now() - query_start AS age, state, query
    FROM pg_stat_activity
   WHERE state != 'idle'
   ORDER BY age DESC NULLS LAST
   LIMIT 10;
  ```

## Common causes

1. **Long migration holding rows / locks** — migration runner is single-threaded
   and bounded by `PG_STATEMENT_TIMEOUT_MS` (5s default), but a `CREATE INDEX`
   on a big table without `CONCURRENTLY` blocks writes until done.
2. **Runaway query** — a missing index or accidental cross join from a new
   endpoint chews backends. Look at `pg_stat_activity.query`.
3. **Idle-in-transaction leak** — a code path opened a transaction with
   `client.query('BEGIN')` and didn't `COMMIT/ROLLBACK` on error. Holds a
   pool slot + a backend until `idle_in_transaction_session_timeout`
   kicks in (Postgres default unlimited).
4. **`idleTimeoutMillis` insufficient** — you shipped a new high-fan-out
   endpoint that bursts to pool max, holds idle conns long enough that
   managed-Postgres connection limit is hit by other tenants of the
   droplet (e.g. worker, ad-hoc psql). The 30s default shipped in
   `apps/api/src/server.ts` should keep this from being the cause; this
   runbook is for the surprise case.
5. **DO managed-Postgres `db-s-1vcpu-2gb` connection cap (~47)** — at
   small sizes the managed instance caps total connections low. The cluster
   is `db-s-1vcpu-2gb` (single node), which allows roughly 47 total
   connections. API `PG_POOL_MAX=40` _plus_ the worker pool _can_ exceed
   this if both are busy (DO also reserves a handful for the maintenance /
   `doadmin` user). See "Right-size" below.

## Mitigation (in order)

1. **Kill the offending backend** — buys time, doesn't fix the cause:

   ```sql
   SELECT pg_terminate_backend(<pid>);
   ```

   Pick the longest-running `active` or `idle in transaction` from the
   query above. `pg_cancel_backend` first (gentler) if you're unsure.

2. **Bounce the API container** — drops all pooled conns, lets the pool
   warm cold:

   ```bash
   doctl compute ssh sitelayer --ssh-command="
     cd /app/sitelayer && \
     GIT_SHA=\$(cat .last_successful_deployed_sha) \
       docker compose -f docker-compose.prod.yml up -d --force-recreate api
   "
   ```

   Re-exporting `GIT_SHA` matters — per CLAUDE.md operating rule, a bare
   `restart` loses the build-sha env and breaks the rollback drill.

3. **Bounce the worker too if it's a likely culprit** — same shape:

   ```bash
   GIT_SHA=$(cat .last_successful_deployed_sha) \
     docker compose -f docker-compose.prod.yml up -d --force-recreate worker
   ```

4. **Right-size `PG_POOL_MAX`** — if the cause is legitimate load
   growth, edit `/app/sitelayer/.env` on the prod droplet (the live source
   of truth; also update the `ops/env/production.env.json` manifest) and
   bounce the affected container. Deploys are local-fleet — there is no
   GitHub Actions `production` environment:

   ```bash
   # Resolve the prod droplet first — prefer the reserved IP, which
   # survives droplet replacement (the bare public IPv4 can change on a
   # resize/reprovision). `doctl compute ssh sitelayer` works too.
   PROD_HOST=159.203.51.158   # reserved IP for droplet sitelayer (566798325)
   ssh sitelayer@"$PROD_HOST" \
     "sed -i 's/^PG_POOL_MAX=.*/PG_POOL_MAX=60/' /app/sitelayer/.env && \
      cd /app/sitelayer && \
      GIT_SHA=\$(cat .last_successful_deployed_sha) \
        docker compose -f docker-compose.prod.yml up -d --force-recreate api worker"
   ```

   Lower when the managed-Postgres connection cap is being hit (~47 on the
   current `db-s-1vcpu-2gb` tier). Raise only after confirming the managed
   instance can take more (resize to `db-s-2vcpu-4gb` or larger if needed —
   `doctl databases list`). Note: adding RAM does NOT add PITR — that needs
   a standby node; see `docs/DR_RESTORE.md`.

5. **Resize the managed instance** as a last resort. Raises connection
   cap and gives more RAM for buffer cache. Done from the DO console or
   `doctl databases resize`; expect a brief connection drop during the
   resize.

## A note on `idleTimeoutMillis`

The 30s `idleTimeoutMillis` shipped in `apps/api/src/server.ts` exists to
stop the pool from holding every connection it ever opened — managed
Postgres bills connection-hours, and idle conns count toward the
instance's connection cap. This runbook is for the case where 30s isn't
aggressive enough _or_ where active (non-idle) load really did saturate
the pool. Don't lower the idle timeout below 10s without measuring
reconnect overhead first; cold-start latency on managed Postgres is
~10–30ms which is fine, but a thrashing pool wastes CPU.

## Verifying recovery

```bash
# pg_stat_activity is back to baseline counts:
doctl compute ssh sitelayer --ssh-command="
  docker run --rm --network host \
    -e PGURL=\"\$(grep ^DATABASE_URL= /app/sitelayer/.env | cut -d= -f2-)\" \
    postgres:18-alpine \
    psql \"\$PGURL\" -c 'SELECT count(*), state FROM pg_stat_activity GROUP BY state;'
"

# /health green, API error rate dropped:
curl -fsS https://sitelayer.sandolab.xyz/health
curl -fsS -H "Authorization: Bearer $API_METRICS_TOKEN" \
  https://sitelayer.sandolab.xyz/api/metrics | grep sitelayer_http_request_errors_total
```

## Post-incident

File a postmortem using [POSTMORTEM_TEMPLATE.md](./POSTMORTEM_TEMPLATE.md).
The high-value follow-ups are usually (a) the missing index or unbounded
query, (b) standing up a Prometheus scraper for `/api/metrics` (none today)
plus an alert on `pg_stat_activity` total > 70% of cap (~47 on the
`db-s-1vcpu-2gb` tier).
