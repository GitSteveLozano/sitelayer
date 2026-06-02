# Runbook — Notification Backlog

**When to read this:** users (foremen, office) say they're not getting
clock-in confirmations, password reset emails, or push notifications, and
the `notifications` table has a growing backlog.

**Related code:** `apps/worker/src/notification-runner.ts`,
`packages/workflows/src/notification.ts`.

## Symptom

Any one of:

- `notifications` rows with `status='pending'` count > 100 (rough
  threshold; normal backlog at steady-state is 0–10).
- User reports: "I clocked in but never got the email/SMS confirmation."
- Sentry `sitelayer-worker` shows `[notification]` errors —
  `failed_provider`, `failed_clerk_not_found`, or
  `failed_clerk_unreachable` workflow transitions.

## Detection

- **API:** `GET /api/sync/events?entity_type=notification&status=pending`
  returns recent pending rows.
- **Prometheus:** graph
  `sitelayer_queue_pending_count{queue="notifications"}`. Sustained
  rise > 50 over 5 min is actionable.
- **Workflow counter:**
  `sitelayer_workflow_events_total{workflow="notification",outcome="failed"}`
  rate, broken out by the terminal `failed_*` states for cause attribution.

## Common causes

1. **Provider outage** — Resend / SendGrid (email) or future SMS / push
   provider. The runner short-circuits the rest of the batch after
   `NOTIFICATION_PROVIDER_FAILURE_THRESHOLD` (default 3) consecutive
   provider errors, so a steady-state outage looks like "send loop runs,
   bails fast, backlog grows."
2. **Webhook secret rotation broke Clerk hydration** — the runner uses
   `CLERK_SECRET_KEY` (cached for `CLERK_EMAIL_CACHE_TTL_MS`, default
   5 min) to resolve recipient emails. A rotated key that wasn't
   propagated to `/app/sitelayer/.env` shows up as
   `failed_clerk_unreachable` after the cache TTL expires.
3. **Push subscription stale** — for the future web-push channel, a
   browser that revoked permission yields permanent `failed_provider`
   without a clean retry signal.
4. **`NOTIFICATIONS_ENABLED=0`** — flag toggled off accidentally.
   Backlog grows because the runner skips draining entirely.

## Diagnosis

```bash
# 1. Are notifications actually disabled?
ssh sitelayer@10.118.0.4 "grep ^NOTIFICATIONS_ENABLED /app/sitelayer/.env"
# Expect NOTIFICATIONS_ENABLED=1

# 2. Distribution of pending-row workflow states.
curl -fsS "https://sitelayer.sandolab.xyz/api/sync/events?entity_type=notification&status=pending&limit=200" | \
  jq '[.[] | .state] | group_by(.) | map({state: .[0], n: length})'

# 3. Check the most recent failed transitions for cause attribution.
curl -fsS "https://sitelayer.sandolab.xyz/api/sync/events?entity_type=notification&status=failed&limit=20" | \
  jq '.[] | {id, state, error: .last_error, attempts: .attempt_count}'

# 4. Provider status (pick the one that matches EMAIL_PROVIDER).
#    https://status.resend.com/
#    https://status.sendgrid.com/
#    https://status.twilio.com/ (future SMS)

# 5. Worker logs for the most recent batch.
ssh sitelayer@10.118.0.4 \
  "docker compose -f /app/sitelayer/docker-compose.prod.yml logs worker --tail 200 | grep '\[notification\]'"
```

## Mitigation (in order)

1. **Wait one batch if provider status is yellow.** The runner exponentially
   backs off via `next_attempt_at` so a recovering provider drains the
   backlog without intervention. Watch the gauge drop.

2. **If `NOTIFICATIONS_ENABLED=0` accidentally** — set it back to `1` in
   `/app/sitelayer/.env` on the prod droplet (the live source of truth) and
   bounce the worker so it re-reads env (`docker compose -f
docker-compose.prod.yml up -d --force-recreate worker`). Deploys are
   local-fleet — there is no GitHub Actions `production` environment.

3. **If env vars rotated mid-run** — verify `CLERK_SECRET_KEY`,
   `RESEND_API_KEY` (or `SENDGRID_API_KEY`) on the droplet are the intended
   values (`/app/sitelayer/.env` is the live source; the
   `ops/env/production.env.json` manifest defines names/scope):

   ```bash
   ssh sitelayer@10.118.0.4 "grep -E '^(CLERK_SECRET_KEY|RESEND_API_KEY|SENDGRID_API_KEY)=' /app/sitelayer/.env | sed 's/=.*/=***/'"
   ```

   If a value is wrong, edit `/app/sitelayer/.env` in place (or re-render it
   via `scripts/render-production-env.mjs`) and bounce the worker.

4. **If a small number of rows are stuck claimed by a crashed worker**
   (claim_token set, `next_attempt_at` in the past, `status='pending'`):
   this is an **operator-only manual reset**. The worker normally
   re-claims via `FOR UPDATE SKIP LOCKED` after a 5-minute lease expiry;
   bypass that only if you're sure no worker holds the row:

   ```sql
   -- Reset stuck claims. ONLY run after docker compose ps shows worker
   -- container is up and the rows have been "pending" for > 10 min.
   UPDATE notifications
     SET claim_token = NULL, next_attempt_at = NOW()
     WHERE status = 'pending' AND claim_token IS NOT NULL
       AND claimed_at < NOW() - INTERVAL '10 minutes';
   ```

   This is advisory only — prefer the worker bounce in step 5 first.

5. **Worker bounce** — re-reads env, drops any stale in-memory state:

   ```bash
   ssh sitelayer@10.118.0.4 \
     "docker compose -f /app/sitelayer/docker-compose.prod.yml restart worker"
   ```

   Note: this restarts in place; if the underlying image needs to change
   (env structure differs across SHAs), re-deploy via `scripts/deploy.sh prod`
   from the fleet instead.

## Verifying recovery

```bash
# Backlog dropping toward 0:
curl -fsS -H "Authorization: Bearer $API_METRICS_TOKEN" \
  https://sitelayer.sandolab.xyz/api/metrics | \
  grep 'sitelayer_queue_pending_count{queue="notifications"}'

# Recent notifications hit terminal sent state, not failed_*:
curl -fsS "https://sitelayer.sandolab.xyz/api/sync/events?entity_type=notification&limit=20" | \
  jq '.[] | {id, state, applied_at}'
```

## Post-incident

File a postmortem using [POSTMORTEM_TEMPLATE.md](./POSTMORTEM_TEMPLATE.md)
if any customer noticed missing notifications. The action-item to focus on
is usually "alert on `sitelayer_queue_pending_count{queue="notifications"} > 50`
for 5 min" — we don't have that yet.
