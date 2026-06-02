# QBO Labor Payroll Live Cutover

Last updated: 2026-05-09 (post design-handoff merge)

This runbook completes Phase 3 of the design-handoff deploy: flipping
`QBO_LIVE_LABOR_PAYROLL=1` so approved labor payroll runs post real
TimeActivity entries to QuickBooks Online, not stub ids.

It also covers adding `ESTIMATE_SHARE_SECRET` to the production
environment so the public client portal share-link tokens stop falling
back to `QBO_STATE_SECRET`.

## Why this is a separate operator action

Per the operating rules in `CLAUDE.md`:

> Any `QBO_LIVE_*` flag flip needs a worker restart and a sandbox smoke
> first — not a full deploy. `QBO_LIVE_RENTAL_INVOICE=1` and
> `QBO_LIVE_ESTIMATE_PUSH=1` only take effect when the worker
> re-reads its env. The worker drains `mutation_outbox` and
> `sync_events`; flipping the flag on a stale process queues writes
> that never reach Intuit until the bounce.

Same rule applies to `QBO_LIVE_LABOR_PAYROLL`. Plus: an unsmoked live
flag risks mis-posting real customer time entries to QBO and that's not
something we get to undo cheaply.

## Pre-flight checklist

- [ ] Production deploy of design-handoff merge is healthy
      (`https://sitelayer.sandolab.xyz/api/version` shows `8da6304` or
      later, `/health` is 200, no error rate spike on the API/worker
      Sentry projects in the last 24 hours)
- [ ] You have access to the Intuit Developer dashboard for the
      sitelayer QBO app and can mint a fresh sandbox OAuth token (they
      expire ~60 minutes; if last smoke was older than that, mint a new
      pair)
- [ ] You have SSH to `sitelayer@10.118.0.4` (the prod droplet) via the
      `DEPLOY_SSH_KEY` — this is how prod env changes land (the live
      `/app/sitelayer/.env`); there is no GitHub Actions `production`
      environment in the path (the repo runs zero workflows)
- [ ] Pilot customer is NOT actively running a payroll cycle right now

## Step 1 — Add `ESTIMATE_SHARE_SECRET` to production

This is independent of the QBO flip but should land first since it
removes a noisy `[estimate-share]` warning log and gives you rotation
independence from `QBO_STATE_SECRET`.

Deploys are local-fleet — there is no GitHub Actions secret store or
`deploy-droplet.yml` workflow (both removed; the repo runs zero workflows).
The live source of truth is `/app/sitelayer/.env` on the prod droplet, which
each deploy REUSES. Add the secret in place and bounce the API:

```bash
# Generate a fresh 64-byte hex secret (from your local machine).
SECRET=$(openssl rand -hex 32)

# Write it into the live droplet .env and recreate the API so it re-reads
# the env. Also add the entry to ops/env/production.env.json (manifest;
# names/scope only — never the value) so a future re-render keeps it.
ssh sitelayer@10.118.0.4 \
  "grep -q '^ESTIMATE_SHARE_SECRET=' /app/sitelayer/.env \
     && sed -i 's|^ESTIMATE_SHARE_SECRET=.*|ESTIMATE_SHARE_SECRET=$SECRET|' /app/sitelayer/.env \
     || printf '\nESTIMATE_SHARE_SECRET=%s\n' '$SECRET' >> /app/sitelayer/.env \
     && cd /app/sitelayer && GIT_SHA=\$(cat .last_successful_deployed_sha) \
        docker compose -f docker-compose.prod.yml up -d --force-recreate api"
```

Then verify:

```bash
ssh sitelayer@10.118.0.4 "grep '^ESTIMATE_SHARE_SECRET=' /app/sitelayer/.env | cut -d= -f1"
# Expected: ESTIMATE_SHARE_SECRET
```

The API picks up the new secret when the container is recreated above.

## Step 2 — QBO sandbox smoke

```bash
cd ~/projects/sitelayer

# Provision fresh sandbox OAuth tokens. Open the Intuit dashboard's
# OAuth Playground for the sitelayer app, run the auth flow against
# the sandbox company, and copy the access_token + refresh_token.

export QBO_SANDBOX_REALM_ID="<from playground>"
export QBO_SANDBOX_ACCESS_TOKEN="<from playground>"
export QBO_SANDBOX_REFRESH_TOKEN="<from playground>"

# Run the smoke. This exercises the same code path the worker will
# use (createQboLaborPayrollPush) — one TimeActivity POST per labor
# entry, with refresh-token re-auth on 401.
bash scripts/qbo-sandbox-smoke.sh

# Expected output:
#   [smoke] sandbox connection ok
#   [smoke] posted TimeActivity STUB-... (or real id when live)
#   [smoke] refresh token rotation ok
#   [smoke] PASS
```

If smoke fails — STOP. Do not flip the live flag. Investigate. The
sandbox failure mode you'll see in prod is identical.

## Step 3 — Flip the live flag

```bash
# It's a plaintext flag, not a secret. Edit the live droplet .env in
# place and recreate ONLY the worker (CLAUDE.md QBO rule #3: a QBO_LIVE_*
# flip needs a worker restart, not a full deploy). The local-fleet deploy
# REUSES /app/sitelayer/.env, so editing it in place is the supported path.
ssh sitelayer@10.118.0.4 \
  "grep -q '^QBO_LIVE_LABOR_PAYROLL=' /app/sitelayer/.env \
     && sed -i 's/^QBO_LIVE_LABOR_PAYROLL=.*/QBO_LIVE_LABOR_PAYROLL=1/' /app/sitelayer/.env \
     || printf '\nQBO_LIVE_LABOR_PAYROLL=1\n' >> /app/sitelayer/.env \
     && cd /app/sitelayer && GIT_SHA=\$(cat .last_successful_deployed_sha) \
        docker compose -f docker-compose.prod.yml up -d worker"
```

The worker container recreate above picks up the new env. (No GitHub
Actions / `deploy-droplet.yml` in the path — both removed.)

## Step 4 — Verify the worker picked up the flag

```bash
ssh sitelayer@10.118.0.4
docker logs sitelayer-worker-1 --tail 50 | grep '\[labor-payroll\]'
# Expected line:
#   [labor-payroll] live QBO TimeActivity push enabled
```

If you still see `[labor-payroll] stub QBO TimeActivity push (set QBO_LIVE_LABOR_PAYROLL=1 to go live)`,
the worker hasn't re-read its env. Force a recreate:

```bash
GIT_SHA=$(cat /app/sitelayer/.last_successful_deployed_sha) \
  docker compose -f /app/sitelayer/docker-compose.prod.yml up -d worker
```

Re-check the logs. Re-export `GIT_SHA` is per CLAUDE.md operating rule
#3 — without it the worker comes up with no `APP_BUILD_SHA` and the
rollback drill breaks.

## Step 5 — End-to-end smoke against real prod data

Pick a labor_payroll_run that's already in `approved` state (or create
one via the time-review approve flow on a pilot day). Then through the
admin UI or directly:

```bash
# List approved runs ready to post.
curl -sS https://sitelayer.sandolab.xyz/api/labor-payroll-runs?state=approved \
  -H "Authorization: Bearer $CLERK_TEST_JWT" | jq '.[].id'

# Dispatch POST_REQUESTED on one.
curl -sS -X POST \
  https://sitelayer.sandolab.xyz/api/labor-payroll-runs/<id>/events \
  -H "Authorization: Bearer $CLERK_TEST_JWT" \
  -H "Content-Type: application/json" \
  -d '{"event":"POST_REQUESTED","state_version":<v>}'

# Watch the worker drain the row.
ssh sitelayer@10.118.0.4 "docker logs sitelayer-worker-1 --tail 30 -f" | grep labor_payroll
```

Expected: row transitions `posting → posted`, `qbo_payroll_batch_ref`
column populated with real Intuit TimeActivity ids. Open QBO and confirm
the entries are visible on the company's TimeActivity report.

## Rollback

If the live flag does the wrong thing in prod (e.g. mis-posting), flip
it back immediately:

```bash
ssh sitelayer@10.118.0.4 \
  "sed -i 's/^QBO_LIVE_LABOR_PAYROLL=.*/QBO_LIVE_LABOR_PAYROLL=0/' /app/sitelayer/.env \
     && cd /app/sitelayer && GIT_SHA=\$(cat .last_successful_deployed_sha) \
        docker compose -f docker-compose.prod.yml up -d worker"
```

Stub ids will start being returned again. Open Intuit's dashboard,
locate the bad TimeActivity entries by their date range, and delete or
void them on the QBO side. The worker doesn't have a "void TimeActivity"
path yet — that's a follow-up if rollback ever bites.

## Why no automation

Two reasons we run this by hand instead of automating it:

1. The QBO sandbox smoke needs human-supplied OAuth tokens that expire
   in 60 minutes. Automating it means storing long-lived sandbox
   credentials, which Intuit's terms of service mark as not-recommended.
2. A prod env change here means editing `/app/sitelayer/.env` on the prod
   droplet and bouncing the worker, which is a deliberate human-driven step
   under the local-fleet deploy model (there is no GitHub Actions
   `production` environment / approver gate — the repo runs zero workflows).
   Same care that protects every other prod change.

So this stays a documented operator runbook, not an automated trigger.

## Future automation

When labor-payroll has accumulated a few weeks of green prod runs
without surprises, candidate automations:

- A nightly fleet timer (systemd, like `scripts/fleet-auto-deploy.sh`) that
  hits `scripts/qbo-sandbox-smoke.sh` with a refreshed token and alerts
  Sentry on regression. Catches upstream Intuit API breakage before it hits
  prod TimeActivity. (No GitHub Actions in the path — the repo runs zero
  workflows.)
- A monthly key-rotation job (fleet-side) that re-renders
  `ESTIMATE_SHARE_SECRET` into the droplet `.env` after warning operators
  that pending share-links will need to be re-sent.

Both are explicit follow-ups; do not implement them as part of this
cutover.
