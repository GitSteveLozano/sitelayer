# Sitelayer Disaster Recovery — Restore Runbook

**Last updated:** 2026-04-25
**Audience:** on-call engineer recovering Sitelayer prod after data loss, droplet failure, or DB corruption.

## Targets (RPO / RTO)

| Failure                   | RPO                                           | RTO       | Primary recovery path                         |
| ------------------------- | --------------------------------------------- | --------- | --------------------------------------------- |
| App droplet lost          | 0 for DB and blueprint objects                | <= 30 min | Restore droplet snapshot OR redeploy from DCR |
| Managed Postgres deleted  | <= 24 h via daily logical pg_dump\*           | <= 60 min | psql restore from `/app/backups/postgres`     |
| Bad migration / data corr | <= 24 h via daily logical pg_dump on prod box | <= 60 min | psql restore from `/app/backups/postgres`     |
| Region-wide outage        | <= 24 h logical, weekly droplet snapshot      | hours     | Manual rebuild in different region from dump  |

> **\* True PITR is NOT available, and resizing RAM will NOT unlock it.**
> The managed cluster is **already** `db-s-1vcpu-2gb` (verified via
> `doctl databases get` — `Size=db-s-1vcpu-2gb`, `NumNodes=1`, single node,
> **no standby**). A common myth — repeated in older revisions of this doc —
> was that resizing to `db-s-1vcpu-2gb` would unlock PITR. It does not: the
> cluster is already that size, and DO managed point-in-time recovery is gated
> on a **standby node** (`NumNodes >= 2`), not on RAM. A continuous WAL-replay
> restore / `doctl databases fork --restore-from-timestamp` requires the
> source cluster to have a standby node retaining WAL; the single-node tier
> (at any RAM size) does not.
>
> So the real RPO for the managed DB is the **daily logical `pg_dump`**
> (≈ 24 h), NOT "<= 5 min PITR". DO's free automatic backups are taken roughly
> daily and are a coarse fallback, but they are not point-in-time and not the
> recovery path we rely on; the daily `pg_dump` (`/app/backups/postgres`, plus
> the off-host copy on the preview droplet and the off-region Spaces copy — see
> [`BACKUP_STRATEGY.md`](./BACKUP_STRATEGY.md)) is. **The real prerequisite for
> PITR is adding a node, which costs money:** convert the cluster to a
> standby-node (HA) topology (`--num-nodes 2`) — that roughly doubles the DB
> line (≈ +$15/mo, see [`COST_AND_LIMITS.md`](./COST_AND_LIMITS.md)). DO then
> enables continuous PITR and the "Managed Postgres deleted" RPO drops to
> minutes — re-point this row + the backup table below when that lands. Until
> someone provisions the standby node and pays for it, treat ≈ 24 h logical
> dump as the RPO; do **not** promise minutes.

Droplet weekly backups: Sunday 04:00 UTC, 28-day retention (DO standard).

## Where backups live

| Backup                  | Location                                                                                                                              | Retention | List command                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| Droplet snapshots       | DO snapshots service                                                                                                                  | 28 days   | `doctl compute droplet backups <ID>`                                                                        |
| Managed Postgres backup | DO managed (free daily automatic backups; coarse, not point-in-time)                                                                  | ~7 days   | `doctl databases backups 9948c96b-b6b6-45ad-adf7-d20e4c206c66`                                              |
| Managed Postgres PITR   | NOT AVAILABLE — single node (`NumNodes=1`); needs a standby node, NOT more RAM (cluster is already `db-s-1vcpu-2gb`) — see note above | n/a       | requires `--num-nodes 2` (HA / standby); until then use the logical pg_dump rows below                      |
| Logical pg_dump         | `/app/backups/postgres/sitelayer-YYYYMMDDTHHMMSSZ.sql.gz` on prod droplet                                                             | 30 days   | `ssh sitelayer ls /app/backups/postgres`                                                                    |
| Off-host logical dump   | Preview droplet `/app/offsite-backups/postgres-from-prod`                                                                             | 30 days   | `ssh sitelayer@10.118.0.2 ls -lh /app/offsite-backups/postgres-from-prod`                                   |
| Off-region logical dump | Non-`tor1` Spaces bucket `prod/YYYY/MM/DD/HHMMSSZ-prod.sql.gz` (`scripts/backup-to-offregion.sh`, daily 06:00 UTC)                    | 35 days   | `aws s3 ls s3://$DO_SPACES_OFFREGION_BUCKET/prod/ --endpoint-url $DO_SPACES_OFFREGION_ENDPOINT --recursive` |
| Blueprint objects       | DO Spaces `sitelayer-blueprints-prod` in `tor1`, versioning enabled                                                                   | versioned | `aws s3 ls s3://sitelayer-blueprints-prod --endpoint-url https://tor1.digitaloceanspaces.com`               |
| Off-host blueprint dump | Preview droplet `/app/offsite-backups/blueprints-from-prod` fallback                                                                  | 30 days   | `ssh sitelayer@10.118.0.2 ls -lh /app/offsite-backups/blueprints-from-prod`                                 |

## On-call quick reference (5 commands)

```bash
# 1. Latest droplet snapshot ID
doctl compute droplet backups 566798325 --format ID,Name,Created

# 2. Most recent managed PG backup
doctl databases backups 9948c96b-b6b6-45ad-adf7-d20e4c206c66

# 3. SSH to prod and list logical dumps
doctl compute ssh sitelayer --ssh-command='ls -lh /app/backups/postgres/'

# 4. Restore a logical dump into a fresh DB (target is sitelayer_prod_restore)
DATABASE_URL=postgres://doadmin:...@.../sitelayer_prod_restore \
  /app/sitelayer/scripts/restore-postgres.sh /app/backups/postgres/<dump>

# 5. Promote restore: swap APP_TIER+DATABASE_URL in /app/sitelayer/.env, then
cd /app/sitelayer
GIT_SHA=$(cat .last_successful_deployed_sha) docker compose -f docker-compose.prod.yml up -d --force-recreate api worker
```

## Procedure 1 — Restore droplet from snapshot

Use when the prod droplet is lost or compromised but the managed DB is fine.

```bash
# List snapshots
doctl compute droplet backups 566798325

# Create new droplet from latest snapshot
doctl compute droplet create sitelayer-restore \
  --image <SNAPSHOT_ID> \
  --size s-4vcpu-8gb \
  --region tor1 \
  --vpc-uuid 38d04b9b-7f67-4484-affc-558c85f51f18 \
  --ssh-keys <YOUR_KEY_ID>

# Reassign reserved IP 159.203.51.158 to the new droplet
doctl compute reserved-ip-action assign 159.203.51.158 <NEW_DROPLET_ID>

# Verify app boots
ssh sitelayer@159.203.51.158 'docker compose -f /app/sitelayer/docker-compose.prod.yml ps'
```

The managed DB trusted-sources firewall is on droplet UUID, not IP — update it:

```bash
doctl databases firewalls append 9948c96b-b6b6-45ad-adf7-d20e4c206c66 \
  --rule droplet:<NEW_DROPLET_ID>
```

Once verified healthy, destroy the dead droplet so its trusted-source rule auto-prunes.

## Procedure 2 — Restore Postgres from DO managed backup

Use when DB is corrupted but cluster still exists, OR when cluster was deleted
recently. On the current single-node cluster (`db-s-1vcpu-2gb`, `NumNodes=1`)
the realistic recovery is the **logical pg_dump (Procedure 3)** — DO managed
PITR/fork is not available until the cluster gains a **standby node**.

> **PITR / fork is NOT available on a single-node cluster.** The
> `doctl databases fork --restore-from-timestamp` command requires the source
> cluster to have a standby node (continuous WAL retention). The cluster today
> is `db-s-1vcpu-2gb` but **single node** (`NumNodes=1`), so the fork command
> below returns an error. **Resizing RAM will not fix this** — the cluster is
> already `db-s-1vcpu-2gb`; the missing piece is the standby node
> (`--num-nodes 2`), which is a paid HA upgrade. The fork block is kept here as
> the **post-standby** path: once the cluster has a standby node, this becomes a
> sub-5-min-RPO option. Until then, jump to Procedure 3.

**Option A (post-standby only): Fork from PITR.** Creates a NEW cluster from a point in time. **Requires the source cluster to have a standby node — errors on the current single-node cluster.**

```bash
doctl databases fork \
  --restore-from-cluster-id 9948c96b-b6b6-45ad-adf7-d20e4c206c66 \
  --restore-from-timestamp 2026-04-24T22:30:00Z \
  sitelayer-db-restore \
  --engine pg \
  --version 18 \
  --region tor1 \
  --size db-s-1vcpu-2gb \
  --num-nodes 2
```

Wait until `doctl databases get <new-id>` shows status `online`, then point prod `.env` at the new connection URI:

```bash
doctl databases connection <NEW_DB_ID>
ssh sitelayer 'sudo -u sitelayer sed -i "s|^DATABASE_URL=.*|DATABASE_URL=<NEW_URI>|" /app/sitelayer/.env'
ssh sitelayer 'cd /app/sitelayer && GIT_SHA=$(cat .last_successful_deployed_sha) docker compose -f docker-compose.prod.yml up -d --force-recreate api worker'
```

After validation, retire the old cluster and rename the new one to `sitelayer-db`.

**Option B: In-place daily-backup restore.** DO console only — no doctl verb.
Settings -> Restore, choose a daily automatic backup (coarse, ~daily
granularity, NOT point-in-time). Slower; effectively rebuilds the cluster. This
is the only managed-backup option on the current single-node cluster; for finer
recovery use the logical dump (Procedure 3).

## Procedure 3 — Restore from logical pg_dump (PRIMARY recovery path)

This is the recovery path the managed-DB RPO actually rests on (≈ 24 h, the
daily dump) while the cluster is single-node (`db-s-1vcpu-2gb`, `NumNodes=1`)
with no PITR. Use it to recover a single table, undo a bad migration, rebuild
after a cluster loss, or any time DO managed point-in-time restore is
unavailable (which is "always", until a standby node is provisioned).

```bash
# 1. Pick a dump
doctl compute ssh sitelayer --ssh-command='ls -lh /app/backups/postgres/'

# 2. Create a target DB on the existing cluster
doctl databases db create 9948c96b-b6b6-45ad-adf7-d20e4c206c66 sitelayer_prod_restore

# 3. From the prod droplet (has docker + creds in .env)
ssh sitelayer
cd /app/sitelayer
RESTORE_URL="postgres://doadmin:$(doctl databases connection 9948c96b-b6b6-45ad-adf7-d20e4c206c66 --format Password --no-header)@private-sitelayer-db-do-user-969393-0.d.db.ondigitalocean.com:25060/sitelayer_prod_restore?sslmode=require"
DATABASE_URL="$RESTORE_URL" ./scripts/restore-postgres.sh /app/backups/postgres/sitelayer-20260424T043000Z.sql.gz

# 4. Diff schema and row counts vs sitelayer_prod
psql "$RESTORE_URL" -c '\dt'
psql "$RESTORE_URL" -c "SELECT count(*) FROM projects;"

# 5. Cutover: rename DBs OR change DATABASE_URL in .env
#    Renaming is safer — schema-checked first.
```

## Verification after any restore

```bash
# Public endpoints respond
curl -fsS https://sitelayer.sandolab.xyz/health
curl -fsS https://sitelayer.sandolab.xyz/api/version

# Authenticated app APIs still require a Clerk JWT or internal bearer token
curl -fsS -H "Authorization: Bearer $TOKEN" https://sitelayer.sandolab.xyz/api/bootstrap

# Worker is processing
ssh sitelayer 'docker compose -f /app/sitelayer/docker-compose.prod.yml logs --tail=30 worker'

# Schema check
ssh sitelayer 'cd /app/sitelayer && DATABASE_URL=$(grep ^DATABASE_URL= .env | cut -d= -f2-) ./scripts/check-db-schema.sh'

# Row sanity
psql "$DATABASE_URL" -c "SELECT count(*) FROM projects; SELECT count(*) FROM blueprint_documents; SELECT count(*) FROM takeoff_measurements;"
```

## Drill schedule

- After every schema migration touching customer data: run Procedure 3 to a throwaway DB and run `check-db-schema.sh`.
- Quarterly: full droplet snapshot restore drill (Procedure 1) into `sitelayer-dr-test` then destroy.
- Log results in `docs/BACKUP_STRATEGY.md` "Restore drills" section.

## Open work

1. **Postgres dump object-store copy — DONE.** Logical dumps are copied to the preview droplet (off-host) and streamed to a non-`tor1` Spaces bucket off-region (`scripts/backup-to-offregion.sh`, daily 06:00 UTC, 35-day retention). See [`BACKUP_STRATEGY.md`](./BACKUP_STRATEGY.md) for the full topology. Remaining: confirm the `DO_SPACES_OFFREGION_*` env vars are provisioned on the prod droplet and the `sitelayer-offregion-backup.timer` is active.
2. **PITR (paid).** Real PITR requires a standby node (`--num-nodes 2`), NOT a RAM resize (the cluster is already `db-s-1vcpu-2gb`). Provision the standby node when pilot data RPO must drop below the ≈24 h daily-dump window — budget ≈ +$15/mo, see [`COST_AND_LIMITS.md`](./COST_AND_LIMITS.md).
3. **On-call routing.** `sitelayer-timer-monitor.timer` sends Sentry events on missed/stale backup timers; wire those events to the final on-call destination once that destination exists. NOTE: worker-side Sentry events (incl. backup-timer events) land in the **`sitelayer-api`** Sentry project — `SENTRY_WORKER_DSN` is absent so the worker falls back to `SENTRY_DSN`.
