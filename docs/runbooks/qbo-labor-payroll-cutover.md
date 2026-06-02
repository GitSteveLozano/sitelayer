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
- [ ] You have admin access to the `sitelayer` GitHub repo's Actions
      `production` environment
- [ ] You have SSH to `sitelayer@10.118.0.4` (the prod droplet) via the
      `DEPLOY_SSH_KEY`
- [ ] Pilot customer is NOT actively running a payroll cycle right now

## Step 1 — Add `ESTIMATE_SHARE_SECRET` to production

This is independent of the QBO flip but should land first since it
removes a noisy `[estimate-share]` warning log and gives you rotation
independence from `QBO_STATE_SECRET`.

```bash
# From your local machine. Generate a fresh 64-byte hex secret.
SECRET=$(openssl rand -hex 32)

# Set it in the production environment. gh prompts for the value;
# paste $SECRET when asked.
gh secret set ESTIMATE_SHARE_SECRET \
  --env production \
  --repo GitSteveLozano/sitelayer \
  --body "$SECRET"

# Trigger a re-deploy so the new secret lands on the droplet. Either
# push an empty commit or re-run the latest deploy workflow.
gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
```

After the deploy completes, verify:

```bash
ssh sitelayer@10.118.0.4 "grep '^ESTIMATE_SHARE_SECRET=' /app/sitelayer/.env | cut -d= -f1"
# Expected: ESTIMATE_SHARE_SECRET
```

The application will pick up the new secret automatically when the API
container restarts (the deploy workflow handles this).

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
# Update the production environment variable. gh sets it as plaintext
# (it's a flag, not a secret).
gh variable set QBO_LIVE_LABOR_PAYROLL \
  --env production \
  --repo GitSteveLozano/sitelayer \
  --body "1"

# Trigger a re-deploy so the new env reaches the droplet. Don't
# manually edit /app/sitelayer/.env — the deploy workflow re-renders
# it from ops/env/production.env.json.
gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
```

The deploy workflow's worker container restart picks up the new env.
You don't need to manually `docker compose up -d worker` because
deploy-droplet.yml does the recreate.

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
gh variable set QBO_LIVE_LABOR_PAYROLL --env production --body "0"
gh workflow run deploy-droplet.yml --repo GitSteveLozano/sitelayer
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

- A nightly `gh workflow run` that hits `scripts/qbo-sandbox-smoke.sh`
  with a refreshed token, alerts Sentry on regression. Catches
  upstream Intuit API breakage before it hits prod TimeActivity.
- A monthly key-rotation job that re-runs `gh secret set` for
  `ESTIMATE_SHARE_SECRET` after warning operators that pending
  share-links will need to be re-sent.

Both are explicit follow-ups; do not implement them as part of this
cutover.
