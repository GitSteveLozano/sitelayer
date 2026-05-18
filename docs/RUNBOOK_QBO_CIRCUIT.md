# Runbook — QBO Circuit Breaker Open

**When to read this:** the worker has stopped pushing to QuickBooks Online
and you need to decide whether to wait, rotate creds, or escalate to Intuit.

**Related code:** `apps/worker/src/qbo-circuit.ts`,
`packages/queue/src/circuit-breaker.ts`.

## Symptom

Any one of:

- Sentry `sitelayer-worker` shows `CircuitOpenError` events tagged with
  `scope: 'circuit_breaker'`, integration `qbo`.
- `GET /api/sync/status` reports the most recent QBO sync attempt as
  `last_sync_status: failed` and `last_error` contains `CircuitOpenError`
  or upstream Intuit 5xx text.
- `GET /api/sync/outbox?status=pending` depth keeps growing for QBO
  `mutation_type` rows (`rental_billing_invoice_push`,
  `estimate_qbo_push`, `labor_payroll_post`, `damage_charge_post`).
- Sentry alert: `[circuit-breaker] open — halting QBO drain` (warning).

## Detection

- **Sentry filter:** project `sitelayer-worker`, tag
  `scope:circuit_breaker` and `integration:qbo`. The `onOpen` callback
  records a warning with that tag every time the breaker trips.
- **Prometheus:** graph
  `sitelayer_circuit_breaker_state{integration="qbo"}`. `0 = closed`,
  `1 = open`. A non-zero sustained reading > 10 min is the actionable
  signal; momentary trips during a single Intuit blip are expected.
- **Queue depth:** `sitelayer_queue_pending_count{queue="mutation_outbox"}`
  rising in concert with the gauge above is confirmation.

## Diagnosis

Run in order; stop when you've found the cause.

```bash
# 1. Are there pending QBO mutations? Which entity types?
curl -fsS -H "Authorization: Bearer $API_METRICS_TOKEN" \
  "https://sitelayer.sandolab.xyz/api/sync/outbox?status=pending" | \
  jq '[.[] | .mutation_type] | group_by(.) | map({type: .[0], n: length})'

# 2. Is this upstream? Check Intuit's status page.
#    https://status.developer.intuit.com/
#    Filter to "API Platform" — that's the surface QBO push uses.

# 3. Is it a single company or the whole fleet? Check connection health.
doctl compute ssh sitelayer --ssh-command="
  cd /app/sitelayer && \
  docker run --rm --network host -e PGURL=\"\$(grep ^DATABASE_URL= .env | cut -d= -f2-)\" \
    postgres:18-alpine \
    psql \"\$PGURL\" -c \
    \"SELECT company_id, provider, status, last_error \
     FROM integration_connections WHERE provider='qbo';\"
"

# 4. Are creds invalid? OAuth 401 looks the same to the breaker as a 5xx.
docker compose -f /app/sitelayer/docker-compose.prod.yml logs worker --tail 200 | \
  grep -E '\[qbo\]|CircuitOpenError|status=401|status=5'
```

## Mitigation (in order)

1. **Wait one cooldown cycle.** `QBO_CIRCUIT_COOLDOWN_MS` defaults to 5
   minutes; after that, one successful push closes the breaker. If the
   underlying Intuit issue is transient (most are), this is the whole fix.
   Watch `sitelayer_circuit_breaker_state{integration="qbo"}` drop to 0.

2. **If persistent (> 15 min) and Intuit status page is green** — suspect
   credentials. The breaker treats 401s as failures, so a refresh-token
   rotation gone wrong looks identical to an outage. Re-mint OAuth via
   the affected company's Settings → Integrations panel, or re-run the
   OAuth flow at `/api/integrations/qbo/auth`. New tokens land in
   `integration_connections`; the next worker drain attempt picks them up
   without a bounce.

3. **If mass-affected (every company failing, Intuit status page red)** —
   this is an Intuit outage. Notify pilot customers via the comms
   template below; do not rotate creds (you'll just queue more invalid
   tokens for replay). Wait it out. The worker defers `next_attempt_at`
   while the breaker is open, so backlog replays cleanly when Intuit
   recovers — no manual drain needed.

   > QuickBooks Online's API platform is currently degraded
   > (status.developer.intuit.com). Sitelayer is holding queued sync
   > writes; nothing is lost and we'll catch up automatically once
   > Intuit recovers. Time-tracking and field events continue normally.
   > — Taylor

4. **Tune for noise.** If the breaker trips on every Intuit hiccup and
   it's costing you on-call attention, raise `QBO_CIRCUIT_THRESHOLD`
   (default 3) via the GitHub Actions `production` environment, then
   re-deploy. Do not flip the threshold below 3 — that's the floor where
   the breaker still detects real outages.

## Manual queue drain

The worker auto-drains every 30 seconds. Force an immediate drain after
mitigation:

```bash
curl -fsS -X POST -H "Authorization: Bearer $API_METRICS_TOKEN" \
  https://sitelayer.sandolab.xyz/api/sync/process
```

This is the same code path the worker takes; it respects the circuit
breaker. If the breaker is still open, the call returns immediately
without touching Intuit — you're not bypassing the cooldown by hitting
this endpoint.

## Verifying recovery

```bash
# Gauge back to 0:
curl -fsS -H "Authorization: Bearer $API_METRICS_TOKEN" \
  https://sitelayer.sandolab.xyz/api/metrics | \
  grep 'sitelayer_circuit_breaker_state{integration="qbo"}'

# Outbox depth dropping:
curl -fsS -H "Authorization: Bearer $API_METRICS_TOKEN" \
  https://sitelayer.sandolab.xyz/api/metrics | \
  grep 'sitelayer_queue_pending_count{queue="mutation_outbox"}'

# Most recent sync attempt succeeded:
curl -fsS "https://sitelayer.sandolab.xyz/api/sync/status" | jq .
```

## Post-incident

If the outage exceeded 30 minutes or any customer noticed, file a
postmortem using [POSTMORTEM_TEMPLATE.md](./POSTMORTEM_TEMPLATE.md).
Particular things to capture for QBO incidents: cooldown tuning history,
which entity types backlogged most, whether idempotency keys protected
duplicate posts on recovery (they should — see
`packages/workflows/src/rental-billing.ts`).
