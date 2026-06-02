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

> **\* True PITR is NOT available on the current plan.** The managed cluster
> is `db-s-1vcpu-1gb` (single node, no standby). DigitalOcean point-in-time
> recovery / a continuous WAL-replay restore requires a plan that provisions a
> standby node — the 1 GB single-node tier does **not** support it. So the
> real RPO for the managed DB is the **daily logical `pg_dump`** (≈ 24 h),
> NOT "<= 5 min PITR". DO's free automatic backups are taken roughly daily and
> are a coarse fallback, but they are not point-in-time and not the recovery
> path we rely on; the daily `pg_dump` (`/app/backups/postgres`, plus the
> off-host copy on the preview droplet) is. **Upgrade path to true PITR:**
> resize the cluster to a plan with a standby node (e.g. `db-s-1vcpu-2gb` or
> larger with the standby add-on); DO then enables continuous PITR and the
> "Managed Postgres deleted" RPO drops to minutes — re-point this row + the
> backup table below when that lands.

Droplet weekly backups: Sunday 04:00 UTC, 28-day retention (DO standard).

## Where backups live

| Backup                   | Location                                                                     | Retention | List command                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| Droplet snapshots        | DO snapshots service                                                         | 28 days   | `doctl compute droplet backups <ID>`                                                          |
| Managed Postgres backup  | DO managed (free daily automatic backups; coarse, not point-in-time)         | ~7 days   | `doctl databases backups 9948c96b-b6b6-45ad-adf7-d20e4c206c66`                                |
| Managed Postgres PITR    | NOT AVAILABLE on `db-s-1vcpu-1gb` (single node, no standby) — see note above | n/a       | requires a standby-node plan; until then use the logical pg_dump rows below                   |
| Logical pg_dump          | `/app/backups/postgres/sitelayer-YYYYMMDDTHHMMSSZ.sql.gz` on prod droplet    | 30 days   | `ssh sitelayer ls /app/backups/postgres`                                                      |
| Off-host logical dump    | Preview droplet `/app/offsite-backups/postgres-from-prod`                    | 30 days   | `ssh sitelayer@10.118.0.2 ls -lh /app/offsite-backups/postgres-from-prod`                     |
| Blueprint objects        | DO Spaces `sitelayer-blueprints-prod` in `tor1`, versioning enabled          | versioned | `aws s3 ls s3://sitelayer-blueprints-prod --endpoint-url https://tor1.digitaloceanspaces.com` |
| Off-host blueprint dump  | Preview droplet `/app/offsite-backups/blueprints-from-prod` fallback         | 30 days   | `ssh sitelayer@10.118.0.2 ls -lh /app/offsite-backups/blueprints-from-prod`                   |
| Future object-store dump | DO Spaces `s3://sitelayer-blueprints-prod/db-backups/` (NOT YET ENABLED)     | 90 days   | requires Spaces creds — see "Open work" below                                                 |

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
recently. On the current `db-s-1vcpu-1gb` (single-node) plan the realistic
recovery is the **logical pg_dump (Procedure 3)** — DO managed PITR/fork is not
available until the cluster gains a standby node.

> **PITR / fork is NOT available on `db-s-1vcpu-1gb`.** The
> `doctl databases fork --restore-from-timestamp` command requires the source
> cluster to have a standby node (continuous WAL retention). The single-node
> 1 GB tier does not, so the fork command below returns an error today. It is
> kept here as the **post-upgrade** path: once the cluster is resized to a
> standby-capable plan, this becomes a sub-5-min-RPO option. Until then, jump
> to Procedure 3.

**Option A (post-upgrade only): Fork from PITR.** Creates a NEW cluster from a point in time. **Requires a standby-node plan — errors on `db-s-1vcpu-1gb`.**

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
is the only managed-backup option on the current single-node plan; for finer
recovery use the logical dump (Procedure 3).

## Procedure 3 — Restore from logical pg_dump (PRIMARY recovery path)

This is the recovery path the managed-DB RPO actually rests on (≈ 24 h, the
daily dump) while the cluster is single-node `db-s-1vcpu-1gb` with no PITR. Use
it to recover a single table, undo a bad migration, rebuild after a cluster
loss, or any time DO managed point-in-time restore is unavailable (which is
"always", on the current plan).

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

1. **Postgres dump object-store copy.** Logical dumps are copied to the preview droplet as of 2026-04-25. Move the second copy to object storage or another off-region target once retention requirements are defined.
2. **Off-region snapshot.** DO weekly snapshot is region-local. For DR against a tor1 outage, schedule a monthly `pg_dump` copied to a non-tor1 Space.
3. **On-call routing.** `sitelayer-timer-monitor.timer` sends Sentry events on missed/stale backup timers; wire those events to the final on-call destination once that destination exists.
