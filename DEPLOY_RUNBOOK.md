# Deploy Runbook

Last updated: 2026-04-29 (deploy model updated 2026-06-02)

> **DEPLOY MODEL UPDATED 2026-06-02.** Deploys are now local-fleet via
> `scripts/deploy.sh <prod|dev|demo>`, run from a fleet box — NOT GitHub
> Actions. **The repo runs ZERO GitHub Actions.** The deploy workflows
> (`deploy-droplet.yml`, `deploy-dev.yml`, `deploy-demo.yml`,
> `deploy-preview.yml`, plus `preview-gc.yml` / `registry-gc.yml`) were
> removed in commit `70b9584b`, and the last remaining workflow,
> `.github/workflows/quality.yml`, was deleted on 2026-06-02. The single
> verification authority is now the **local gate** `scripts/verify-local.sh`
> (`npm run verify`), run locally by the deploy path. The mechanics below
> (immutable migrations, pre-migration backup, image pinned to the built
> SHA, `.last_*_deployed_sha` markers, rollback via
> `scripts/rollback-droplet.sh`) are **unchanged** — only the orchestrator
> moved from a CI runner to `scripts/deploy-production-local.sh` on the
> fleet, and the gate moved from GitHub `Quality` to `scripts/verify-local.sh`.
> `scripts/deploy.sh prod` runs the full gate before it ships an image, so
> there is no separate "confirm CI is green" step. Where this doc still says
> "the workflow" / "push to `main`", read it as "`scripts/deploy.sh prod`"
> unless noted.

This is the operating contract for shipping changes to the production
`sitelayer` droplet (`165.245.230.3`) and managed Postgres database
(`sitelayer-db`). Locked down in advance of the pilot so that a single
careless merge cannot break a paying customer.

> **Canonical production IP:** the reserved IP `159.203.51.158` is the
> canonical address for the production droplet (see `CLAUDE.md` →
> Current Infrastructure Snapshot). The bare `165.245.230.3` used in the
> `ssh` examples below is the droplet's current public IPv4; prefer the
> reserved IP, which survives droplet replacement.

## Hard rules

1. **Nothing reaches prod without a green local gate for that exact SHA.**
   Under the adopted trunk-ish model, solo work may commit to `main`/`dev`
   directly and prune branches aggressively. Exercise risky changes on
   `dev` / a preview first. The hard invariant: the SHA you deploy to prod
   passes `scripts/verify-local.sh` — and it does, because
   `scripts/deploy.sh prod` runs that gate locally **before** building and
   shipping the image (break-glass `FORCE_DEPLOY_UNCHECKED=1` only). There
   is no GitHub `Quality` status check to confirm; the gate is the deploy.

2. **Migrations are forward-only.** Once a file in
   `docker/postgres/init/*.sql` exists on `main`, it is immutable. To
   change behavior, add a new migration with the next sequential
   number. The runtime ledger (`schema_migrations`) keeps a SHA-256
   checksum per applied file and refuses to apply a file with the same
   name and a different checksum.

3. **The local gate must be green.** `scripts/verify-local.sh`
   (`npm run verify`) is the single verification authority — there is no CI
   workflow. Its docker-compose integration check runs every migration
   against a real Postgres 18 instance and boots the API against the
   resulting schema, so migration breakage gets caught locally before the
   deploy, not at deploy time.

4. **Preview must be smoked.** Before merging, hit the changed
   surface on the preview URL printed in the PR comment
   (`https://pr-N.preview.sitelayer.sandolab.xyz`). New API routes get
   a curl. New screens get a click-through.

5. **Never edit a migration that already shipped.** If you need to
   recover from a bad migration that already ran in any environment,
   write a follow-up migration that fixes the schema. Do not edit the
   original — that triggers a checksum mismatch and bricks the next
   deploy.

## What runs where

| Stage       | Trigger                       | Mechanism                                               | Target                                                                  |
| ----------- | ----------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Verify gate | local, before every deploy    | `scripts/verify-local.sh` (`npm run verify`)            | none (validates only — static/build/unit/integration; e2e via `--full`) |
| Prod deploy | manual, from the fleet        | `scripts/deploy.sh prod` → `deploy-production-local.sh` | production droplet, `sitelayer_prod` Postgres                           |
| Dev deploy  | manual, from the fleet        | `scripts/deploy.sh dev` → `deploy-preview.sh`           | `dev.sitelayer.sandolab.xyz`, `sitelayer_dev` Postgres                  |
| Demo deploy | manual, from the fleet        | `scripts/deploy.sh demo` → `deploy-preview.sh` (+ seed) | `demo.preview.sitelayer.sandolab.xyz`, `sitelayer_demo` Postgres        |
| PR preview  | manual on the preview droplet | `scripts/deploy-preview.sh`                             | `pr-N.preview.sitelayer.sandolab.xyz`, `sitelayer_preview` Postgres     |

The prod deploy runs the local gate, builds + pushes the image on the fleet
box, then SSHes (flock-locked) to the production droplet. There is no GitHub
Actions in the deploy path at all — the repo runs zero workflows (the
`sitelayer-preview` self-hosted runner was part of the removed Actions
topology, and `quality.yml` was deleted on 2026-06-02).

## Migration workflow in detail

`scripts/migrate-db.sh` is the single source of truth for applying SQL.
It is invoked by:

- Local dev: `npm run db:migrate`
- Verify gate: `scripts/verify-local.sh`'s docker-compose integration
  check, against an ephemeral Postgres 18 service container
- Preview/dev/demo deploy: `scripts/deploy-preview.sh` against
  `sitelayer_preview` / `sitelayer_dev` / `sitelayer_demo`
- Prod deploy: inline in `scripts/deploy-production-local.sh` (the SSH
  heredoc on the prod droplet) against `sitelayer_prod`

Inside the script:

1. Acquire `pg_advisory_xact_lock(hashtextextended('sitelayer.schema_migrations', 0))`
   so two concurrent deploys cannot race.
2. Ensure `schema_migrations(name, checksum, applied_at)` exists.
3. For each `*.sql` file in lexical order:
   - If a row with the same `name` exists with a different `checksum`,
     **abort**. This is the runtime guard against migration edits.
   - If a row with the same `name` exists with the same `checksum`,
     skip.
   - Otherwise apply the file inside a transaction with
     `\set ON_ERROR_STOP on`, then insert the row.

Because the wrapper transaction includes both the migration body and the
ledger insert, a failed migration leaves zero state behind.

### The local gate catches edits before deploy

`scripts/check-migrations-immutable.sh` runs as part of the local gate
(`scripts/verify-local.sh`, which `scripts/deploy.sh prod` runs before it
ships). It diffs the working branch against the merge-base with
`origin/main` and fails if any pre-existing `docker/postgres/init/*.sql`
file shows up as `M` (modified), `D` (deleted), or `R` (renamed). New
files are always allowed.

To override on a feature branch (rare — only if a migration was added
this PR, never applied anywhere, and needs editing):
`MIGRATION_GUARD_OVERRIDE=1 bash scripts/check-migrations-immutable.sh`.

### Production deploy migration steps

`scripts/deploy-production-local.sh` runs these steps on the prod droplet,
in order, inside the SSH heredoc:

1. `git checkout` the exact SHA the image was built from (not
   `origin/main` — concurrent merges could otherwise advance past the
   built image).
2. **`scripts/backup-postgres.sh`** — logical pg_dump before any DDL.
   Stored under `/app/backups/postgres/` on the droplet.
3. `docker compose pull` the new image (so the deploy aborts cleanly if
   the registry image is missing — never partially-migrated).
4. **`scripts/migrate-db.sh`** — applies pending migrations under the
   advisory lock.
5. `scripts/check-db-schema.sh` — sanity check the resulting schema.
6. `docker compose up -d --remove-orphans` — swap containers.
7. HTTPS health check loop (30 attempts, 5s apart) against
   `sitelayer.sandolab.xyz/health`.
8. `scripts/verify-prod-deploy.sh` — confirms the running build matches
   `EXPECTED_GIT_SHA`.

If any of steps 2–8 fails, the deploy job exits non-zero and the
container swap does not happen. The new image is on disk but old
containers keep serving.

### Rollback

Migrations are forward-only, so rolling back the **schema** requires a
follow-up migration — there is no automatic reverse. Rolling back the
**code** (without a schema change) uses
`scripts/rollback-droplet.sh`:

```sh
ssh root@165.245.230.3
sudo bash /app/sitelayer/scripts/rollback-droplet.sh
```

That script:

1. Reads `TARGET_SHA` from arg (`TARGET_SHA=abcdef1`) or
   `.last_previous_deployed_sha`.
2. Pulls the image using the deploy user's `~/.docker/config.json`
   (the prod registry token lives there; root's docker config is
   typically empty, which is why a manual `docker compose pull` as
   root returns `401 Unauthorized`).
3. Verifies the image is on disk before swapping.
4. Exports `APP_BUILD_SHA`, `GIT_SHA`, `SENTRY_RELEASE` so the
   rolled-back container reports the correct `build_sha` on the
   `/api/version` endpoint and Sentry release tag. Without these,
   the version endpoint reports `build_sha: "unknown"` (a real
   wrinkle discovered in the first rollback drill).
5. Polls `/health` until the new container is ready.
6. Verifies live `/api/version` matches the target SHA.

`DRY_RUN=1` pulls the image without swapping — useful for periodic
rollback drills.

If the schema migration that shipped with the bad code is itself bad,
write a new migration that reverses the damage and ship it the same
way (PR → preview → main).

#### Roll back to apps/web (v1)

ADR 0002 cutover criterion #6 reserves an option to route web traffic
back to `apps/web/` (v1) for the post-cutover release window. Use this
when a v2-specific regression slipped past `rollback-droplet.sh` (e.g.
a v2 PWA / IndexedDB issue that doesn't repro under v1's flat IA).

Prerequisites: the deployed image must include `apps/web/dist`. The
`Dockerfile` ships v1 dist alongside v2 dist for exactly this path
(`COPY apps/web/dist`), so any image built after the rollback-toggle
PR landed is eligible.

Steps:

```sh
ssh root@165.245.230.3
cd /app/sitelayer
# Bring up the v1 service (the rollback profile is intentionally not
# part of the default `docker compose up`).
docker compose -f docker-compose.prod.yml --profile rollback up -d web-legacy
# Flip Caddy's upstream and restart it.
WEB_BACKEND=web-legacy:3000 \
  docker compose -f docker-compose.prod.yml up -d caddy
```

To return to v2:

```sh
WEB_BACKEND=web:3000 \
  docker compose -f docker-compose.prod.yml up -d caddy
docker compose -f docker-compose.prod.yml stop web-legacy
```

The `api` and `worker` containers are unchanged in either direction
— this rollback is web-only.

#### Rollback drill log

| Date       | Drill | Result | Notes                                                                                                                                                                                                                    |
| ---------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-04-29 | First | OK     | Rolled `09afad2 → 563d372 → 09afad2` on prod, ~30s downtime each swap. Discovered `DOCKER_CONFIG=/home/sitelayer/.docker` requirement and `APP_BUILD_SHA` export needed. Both folded into `scripts/rollback-droplet.sh`. |

### DO Container Registry quota — what to do when push fails

The DO Container Registry Starter tier caps storage at 500 MB.
`scripts/deploy-production-local.sh` prunes old SHA tags after each
build+push (keeps `:main` + the newest 10 SHA tags, then starts an async
garbage-collection — this replaced the removed `registry-gc.yml`). The same
quota trap below still applies because GC is async.

**When it doesn't work, do NOT manually run `doctl registry
garbage-collection start`.** Trap discovered 2026-05-04 (workflow run
25342451665 → 25343615088 → 25344345514):

1. The push hits "quota exceeded" because >500 MB of blobs sit in the
   registry, including untagged blobs from earlier failed pushes.
2. GC frees the space, but the _async_ GC can't finalize until every
   active `--read-write` docker-config JWT expires. `doctl registry
login` mints a write token at deploy time; GC stays blocked until it
   times out.
3. While GC is in `waiting for write JWTs to expire` state,
   **all new write tokens for the registry are rejected with `401
Unauthorized`**, blocking every subsequent deploy attempt.

If a deploy fails mid-push and you `doctl registry garbage-collection
start` to "help", you've now blocked deploys for up to 1h waiting for
your own write JWTs to time out.

**Right play when push fails:**

- `doctl registry get -ojson | grep storage_usage_bytes` to see actual
  usage. If it's already < 400 MB, the failure was transient — just
  re-run the workflow.
- If it's > 400 MB and the workflow's own GC retry already triggered
  (check `doctl registry garbage-collection list` for a recent
  `succeeded` entry), wait for the workflow's GC to complete naturally
  and re-run the deploy.
- Only manually trigger GC if (a) the workflow hasn't already triggered
  one _and_ (b) you accept that no deploy will succeed for the next
  ~60 min.

Long-term: if registry pressure becomes routine, bump from Starter
($0/mo, 500 MB) to Basic ($5/mo, 5 GB) — that's the structural fix.

### Workflow event log replay

For workflows under `packages/workflows/` (rental_billing_run,
estimate_push), schema correctness includes one extra check: the
event-log replay. After a non-trivial reducer change, run

```sh
DATABASE_URL="$prod_ro_url" \
  npx tsx scripts/replay-workflow.ts <workflow-name> <entity-id>
```

against representative production rows. Exit code `2` means the reducer
output disagrees with the persisted state — that's a regression you
need to investigate before merging the change.

### RLS rollout — 073 ↔ 078 FORCE reversal

Phase-2 RLS shipped in two migrations a few days apart, and the
intermediate state turned out to be production-incompatible. Document
this here so restore drills and migration replays don't trip on it.

- **073 (`073_rls_enable_phase_2.sql`)** enables RLS _and_ `FORCE ROW
LEVEL SECURITY` on `audit_events`, `workflow_event_log`,
  `mutation_outbox`, and `sync_events`. FORCE was intended to make the
  table owner subject to the company-isolation policy too. In practice
  it broke `pg_dump` (the pre-deploy backup step), because `pg_dump`
  connects _as the owner_ and FORCE applied the policy to that
  connection — which has no `app.company_id` set — silently dumping
  zero rows for the affected tables.
- **078 (`078_rls_no_force_for_owner_dumps.sql`)** is the corrective.
  It runs `ALTER TABLE … NO FORCE ROW LEVEL SECURITY` on the same four
  tables. The application path is unaffected: API routes and worker
  drains still go through `withCompanyClient`, which sets
  `app.company_id` _and_ uses a non-owner role, so the policy
  enforces tenant isolation as designed.
- Both migrations are **idempotent** (`ENABLE` / `NO FORCE` are
  no-ops on an already-correct state). Re-running the ledger is safe.
- **The intermediate state (post-073, pre-078) is production-
  incompatible.** Restore drills that materialise a database at a
  commit between those two migrations must either (a) replay forward
  through 078 before running `pg_dump`, or (b) `ALTER ROLE … BYPASSRLS`
  on the dump role for the duration of the drill. Recording this
  explicitly so future drill operators don't conclude their backup is
  silently broken.

### Cosmetic: 074–077 header-comment off-by-one

Migrations `074`–`077` were renumbered late in their PR cycle but the
leading `-- NNN_*.sql` header comment inside each file still references
the original numbering (`-- 073_notifications_delivery_retry.sql`,
`-- 074_qbo_sync_runs.sql`, etc.). The file _names_ on disk are correct
and that is what `schema_migrations.name` records, so the runtime
ledger is consistent.

Do **not** edit the leading comment to "fix" the cosmetic mismatch.
Migrations are checksum-immutable once applied (`schema_migrations`
records a SHA-256 over the file body — the comment block included).
Editing any pre-existing migration body — even just the leading comment
— flips the checksum and the next `scripts/migrate-db.sh` run will
refuse to apply further migrations until the original content is
restored. If the comments must be corrected for clarity, do it in a
new no-op migration documenting the prior off-by-one.

## Who can deploy

Production deploys run from a trusted fleet box via `scripts/deploy.sh
prod`, which builds the image, pushes it to the DO registry, and SSHes
to the prod droplet as the `sitelayer` deploy user (key authorized on the
fleet). Whoever can run that script on a fleet box with the deploy key can
deploy — so the fleet box's access to the deploy key is the gate. The
verification gate is built in: `scripts/deploy.sh prod` runs
`scripts/verify-local.sh` locally before it builds or ships, so a deploy
cannot ship a SHA that fails the gate (break-glass `FORCE_DEPLOY_UNCHECKED=1`
only). GitHub branch protection on `main` (PR + review) is optional
code-review hygiene; it is no longer enforced by any status check, since the
repo runs zero GitHub Actions.

Manual SSH access is for diagnostics only:

```sh
ssh sitelayer@165.245.230.3   # via DEPLOY_SSH_KEY
```

The deploy user is in the docker group, so `docker` access is
root-equivalent. Treat `DEPLOY_SSH_KEY` as a production-root credential.

## QBO sandbox smoke

Before turning on either of the QBO live flags in prod
(`QBO_LIVE_RENTAL_INVOICE=1`, `QBO_LIVE_ESTIMATE_PUSH=1`), exercise
`scripts/qbo-sandbox-smoke.sh` against a real Intuit sandbox.

The local gate (`scripts/verify-local.sh`) runs
`apps/api/src/qbo-material-bill-sync.test.ts` against a localhost mock,
which catches request-shape regressions but not authentication,
rate-limiting, or schema-validation behaviours that real QBO enforces.
Those only show up against a live sandbox.

### Sandbox provisioning (one-time, per developer or per CI)

1. Sign in at <https://developer.intuit.com>, go to "My Apps",
   create an app or open the existing sitelayer dev app.
2. Under "Sandboxes", create a "Sandbox Company" and note the
   `Realm ID` (e.g. `9341454063892108`).
3. Use OAuth Playground or the in-app Keys/OAuth tab to fetch a
   short-lived `Access Token` for that realm. Tokens expire in ~60
   minutes, so capture them right before running the smoke.

### Running the smoke

```sh
QBO_REALM_ID=9341454063892108 \
  QBO_ACCESS_TOKEN=<token> \
  SITELAYER_API_URL=http://localhost:3001 \
  SITELAYER_COMPANY_ID=<uuid-of-local-company> \
  bash scripts/qbo-sandbox-smoke.sh
```

Exit codes: 0 OK, 1 missing config, 2 customer pull failed, 3 bill
push failed.

### Live-flag flip protocol

After the smoke is green:

1. Set `QBO_LIVE_RENTAL_INVOICE=1` (or `QBO_LIVE_ESTIMATE_PUSH=1`)
   in `/app/sitelayer/.env` on prod.
2. Restart the worker container only:
   `docker compose -f docker-compose.prod.yml restart worker`.
3. Watch worker logs for the next heartbeat tick to confirm the
   stub→live switch (boot log line "live QBO invoice push enabled"
   for rentals or "live QBO estimate push enabled" for estimates
   replaces the corresponding stub line).
4. Trigger one billing run with `state=approved` and dispatch
   `POST_REQUESTED`; verify the QBO sandbox shows the invoice.
5. Roll forward to the next customer-facing run.

Until the smoke is run with real credentials, the live flags should
stay unset. The first customer's first billing run is currently the
first live test if you skip the smoke — don't.

### QBO circuit breaker + retry cap (post-2026-05-16)

The worker wraps every QBO push (`rental_billing`, `estimate_push`,
`labor_payroll`) with a shared circuit breaker keyed `qbo`. Behavior:

- `QBO_CIRCUIT_THRESHOLD` (default `3`) consecutive 5xx or network
  errors open the circuit.
- `QBO_CIRCUIT_COOLDOWN_MS` (default `300000` = 5 min) is how long the
  circuit stays open before half-opening (next call passes through).
- While open, every QBO push throws `CircuitOpenError` immediately
  (without calling Intuit). The worker logs a single info-level line
  per drain pass and bumps `next_attempt_at` on the pending QBO outbox
  rows so they don't claim-and-fail every heartbeat.
- On open: one Sentry warning is sent (tags
  `scope:circuit_breaker integration:qbo`). On close (after a
  successful push), one info log line.

The retry cap is `MUTATION_MAX_RETRIES` (default `10`). At the start of
every heartbeat the worker runs `deadLetterStaleOutbox()` which marks
any `mutation_outbox` row whose `attempt_count >= MUTATION_MAX_RETRIES`
as `status='dead'`. Dead rows are visible via
`/api/system/mutation-outbox?status=dead` and are never re-claimed.
Investigate before tweaking the cap — the row is usually broken.

To force-close the breaker mid-incident: restart the worker (state is
in-memory). To inspect: the breaker exposes a `.snapshot('qbo')`
helper, surfaced indirectly via Sentry alerts.

## Pilot-readiness checklist

Before the first paying customer is on prod:

- [x] CI runs migrations against a real Postgres 18 on every PR
- [x] CI fails PRs that edit/delete pre-existing migration files
- [x] Preview deploy applies migrations to `sitelayer_preview`
- [x] Prod deploy takes a logical Postgres backup before migrations
- [x] Prod deploy uses an immutable image tag pinned to the built SHA
- [x] Migrations run inside transactions with `ON_ERROR_STOP`
- [x] Migration ledger uses a checksum so silent edits are rejected
- [x] Workflow event log + replay tool exist for the regression net
- [x] Periodic `scripts/replay-workflow.ts` cron against live customer
      data (sitelayer-replay-sweep.timer at 04:42 UTC, installed
      2026-04-29 — silent until customer data exists)
- [x] Rollback drill — exercised on prod 2026-04-29; canonical path is
      `scripts/rollback-droplet.sh`. See "Rollback drill log" above.
- [ ] On-call rotation defined (single-developer until pilot scales)
- [ ] QBO sandbox smoke run with real Intuit credentials before
      flipping `QBO_LIVE_RENTAL_INVOICE=1` /
      `QBO_LIVE_ESTIMATE_PUSH=1`. Provisioning steps in the QBO
      sandbox smoke section above. Token expires in ~60 min, so this
      gets re-run on every flip.

The unchecked items are the work to wrap up before customer #1 lands
or before flipping QBO live.

## Post-pilot follow-ups (deferred, not blockers)

These came out of the 2026-04-29 pre-pilot audit but were deemed
post-pilot work — none would burn the first customer:

### LOW

- **Zod-validate the rest of the API mutation routes.** The workflow
  event endpoints set the pattern (`parseRentalBillingEventRequest`,
  `parseEstimatePushEventRequest`, `parseCrewScheduleEventRequest`,
  `parseRentalEventRequest`, `parseProjectCloseoutEventRequest`).
  The shared helper `parseJsonBody(schema, body)` lives in
  `apps/api/src/http-utils.ts`. `POST /api/schedules` was migrated as
  the canonical example (`CreateScheduleBodySchema`). Remaining
  routes still using `body.foo ?? ...` ad-hoc shape checks:
  `clock.ts` (/in, /out), `projects.ts` (POST, PATCH),
  `customers.ts`, `workers.ts`, `divisions.ts`, `service-items.ts`,
  `pricing-profiles.ts`, `bonus-rules.ts`, `labor-entries.ts`,
  `material-bills.ts`, `takeoff-write.ts`, non-workflow paths in
  `rental-inventory.ts`, and `rentals.ts` POST/PATCH. Mechanical
  sweep ~1 day. Pattern: define `<Op><Entity>BodySchema` at module
  top, swap `await ctx.readBody()` with
  `const parsed = parseJsonBody(Schema, await ctx.readBody())`.
- **Workflowize blueprint revisions** (revision lineage today via
  copied-from notes). Small lift, low regression risk. The pattern
  is set by crew_schedules — copy + paste + adjust column names.
  (`projects` closeout shipped via PR #130.)

### Phase-2 of partially-shipped work

- **Rentals workflow phase 2.** Phase 1 (PR #126) added the schema
  scaffolding and registered the reducer; the replay sweep covers
  rentals. Phase 2 rewrites `routes/rentals.ts` to dispatch reducer
  events instead of direct PATCH-set-status, and wires the worker's
  cadence-driven flow (INVOICE_QUEUED, INVOICE_POSTED) through the
  reducer. Bigger than crew_schedules because of the worker
  integration, but the abstraction is in place.

### DEFER

- **Workflowize `integration_connections` / QBO sync.** Implicit
  retry FSM in JSONB, multi-API coordination, large lift. Best
  candidate for Temporal once we add it. **Don't take this on under
  the Postgres reducer model** — it'll outgrow the abstraction.
  Revisit after pilot when we know the real failure modes.

### Operational follow-ups

- **On-call rotation.** Single-developer pilot for now.
- **OnFailure= for sitelayer-replay-sweep.timer.** Currently a
  divergence exits the unit non-zero which surfaces in
  `systemctl list-units --failed`; wire to Sentry/Slack once an
  on-call destination exists.
- **Periodic rollback drills.** First drill executed 2026-04-29;
  schedule one quarterly to keep the muscle warm.
