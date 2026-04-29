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

| Stage | Trigger | Workflow | Target |
|---|---|---|---|
| PR opened | every push to a PR branch | `.github/workflows/quality.yml` | none (validates only) |
| PR opened | every push to a PR branch | `.github/workflows/deploy-preview.yml` | `pr-N.preview.sitelayer.sandolab.xyz`, `sitelayer_preview` Postgres |
| PR closed | merged or discarded | `.github/workflows/deploy-preview.yml` (cleanup) | tears down preview stack |
| Push to `main` | merged PR | `.github/workflows/deploy-droplet.yml` | production droplet, `sitelayer_prod` Postgres |

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
**code** (without a schema change) is:

```sh
ssh sitelayer@165.245.230.3
cd /app/sitelayer
previous_sha="$(cat .last_previous_deployed_sha)"
APP_IMAGE="registry.digitalocean.com/sitelayer/sitelayer:${previous_sha}" \
  docker compose -f docker-compose.prod.yml pull api web worker
docker image inspect "$APP_IMAGE" >/dev/null  # confirm image exists
docker compose -f docker-compose.prod.yml up -d --remove-orphans
```

The deploy script writes `.last_previous_deployed_sha` after a
successful deploy, so this is always one variable away from being
reproducible.

If the schema migration that shipped with the bad code is itself bad,
write a new migration that reverses the damage and ship it the same
way (PR → preview → main).

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
- [ ] Periodic `scripts/replay-workflow.ts` cron against live customer
      data (set up after first customer onboarded)
- [ ] On-call rotation defined (single-developer until pilot scales)
- [ ] Rollback drill — exercise the
      `previous_sha → docker compose up` path on preview at least once
      before the pilot starts

The unchecked items are the work to wrap up before customer #1 lands.
