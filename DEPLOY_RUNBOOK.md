# Deploy Runbook

Last updated: 2026-04-29

This is the operating contract for shipping changes to the production
`sitelayer` droplet (`165.245.230.3`) and managed Postgres database
(`sitelayer-db`). Locked down in advance of the pilot so that a single
careless merge cannot break a paying customer.

## Hard rules

1. **No commit to `main` lands without going through preview first.**
   The default deploy path is PR → preview → smoke → merge → prod. If a
   change cannot be exercised in preview before prod (rare), call it out
   explicitly in the PR description and have a second pair of eyes.

2. **Migrations are forward-only.** Once a file in
   `docker/postgres/init/*.sql` exists on `main`, it is immutable. To
   change behavior, add a new migration with the next sequential
   number. The runtime ledger (`schema_migrations`) keeps a SHA-256
   checksum per applied file and refuses to apply a file with the same
   name and a different checksum.

3. **CI must be green.** `Quality` workflow on the PR has to pass.
   `test-integration` runs every migration against a real Postgres 18
   instance and boots the API against the resulting schema, so
   migration breakage gets caught at PR time, not deploy time.

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

| Stage          | Trigger                   | Workflow                                         | Target                                                              |
| -------------- | ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| PR opened      | every push to a PR branch | `.github/workflows/quality.yml`                  | none (validates only)                                               |
| PR opened      | every push to a PR branch | `.github/workflows/deploy-preview.yml`           | `pr-N.preview.sitelayer.sandolab.xyz`, `sitelayer_preview` Postgres |
| PR closed      | merged or discarded       | `.github/workflows/deploy-preview.yml` (cleanup) | tears down preview stack                                            |
| Push to `main` | merged PR                 | `.github/workflows/deploy-droplet.yml`           | production droplet, `sitelayer_prod` Postgres                       |

The production deploy job runs on the same self-hosted runner as preview
(`sitelayer-preview`), then SSHes from there to the production droplet.

## Migration workflow in detail

`scripts/migrate-db.sh` is the single source of truth for applying SQL.
It is invoked by:

- Local dev: `npm run db:migrate`
- CI: `quality.yml` → `test-integration` job, against an ephemeral
  Postgres 18 service container
- Preview deploy: `scripts/deploy-preview.sh:172-174` against
  `sitelayer_preview`
- Prod deploy: inline in the deploy-droplet workflow against
  `sitelayer_prod`

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

### CI catches edits at PR time

`scripts/check-migrations-immutable.sh` runs on every PR (wired into
`quality.yml`). It diffs the PR branch against the merge-base with
`origin/main` and fails if any pre-existing `docker/postgres/init/*.sql`
file shows up as `M` (modified), `D` (deleted), or `R` (renamed). New
files are always allowed.

To override on a feature branch (rare — only if a migration was added
this PR, never applied anywhere, and needs editing):
`MIGRATION_GUARD_OVERRIDE=1 bash scripts/check-migrations-immutable.sh`.

### Production deploy migration steps

`deploy-droplet.yml` runs these steps on the prod droplet, in order,
inside the SSH heredoc:

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

#### Rollback drill log

| Date       | Drill | Result | Notes                                                                                                                                                                                                                    |
| ---------- | ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-04-29 | First | OK     | Rolled `09afad2 → 563d372 → 09afad2` on prod, ~30s downtime each swap. Discovered `DOCKER_CONFIG=/home/sitelayer/.docker` requirement and `APP_BUILD_SHA` export needed. Both folded into `scripts/rollback-droplet.sh`. |

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

## Who can deploy

Production deploys are gated by GitHub Actions environment
`production`. The deploy job runs only when a push to `main` is
authorized for that environment. No human SSHes to the droplet to
deploy by hand — the `deploy_key` lives in GitHub Secrets and is
written to disk only inside the runner.

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

CI runs `apps/api/src/qbo-material-bill-sync.test.ts` against a
localhost mock, which catches request-shape regressions but not
authentication, rate-limiting, or schema-validation behaviours that
real QBO enforces. Those only show up against a live sandbox.

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
