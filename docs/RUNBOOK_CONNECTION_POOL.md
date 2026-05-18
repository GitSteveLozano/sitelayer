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

- **HTTP error rate:** `sitelayer_http_request_errors_total` rate
  (anything > 0.5/s sustained is bad).
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
5. **DO managed-Postgres `db-s-1vcpu-1gb` connection cap (~25)** — at
   small sizes the managed instance caps total connections low. API
   `PG_POOL_MAX=40` _plus_ worker pool _can_ exceed this if both are
   busy. See "Right-size" below.

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
   growth, raise via the GitHub Actions `production` environment:

   ```bash
   gh variable set PG_POOL_MAX --env production --body "20"  # lower it
   # OR
   gh variable set PG_POOL_MAX --env production --body "60"  # raise it
   gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
   ```

   Lower when the managed-Postgres connection cap is being hit. Raise
   only after confirming the managed instance can take more (resize to
   `db-s-1vcpu-2gb` or larger if needed — `doctl databases list`).

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
  https://sitelayer.sandolab.xyz/api/metrics | grep http_request_errors_total
```

## Post-incident

File a postmortem using [POSTMORTEM_TEMPLATE.md](./POSTMORTEM_TEMPLATE.md).
The high-value follow-ups are usually (a) the missing index or unbounded
query, (b) a Prometheus alert on `pg_stat_activity` total > 70% of cap.
