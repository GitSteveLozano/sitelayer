# Sitelayer Disaster Recovery — Restore Runbook

**Last updated:** 2026-04-24
**Audience:** on-call engineer recovering Sitelayer prod after data loss, droplet failure, or DB corruption.

## Targets (RPO / RTO)

| Failure                   | RPO                                           | RTO         | Primary recovery path                          |
| ------------------------- | --------------------------------------------- | ----------- | ---------------------------------------------- |
| App droplet lost          | 0 (data lives in managed DB / Spaces)         | <= 30 min   | Restore droplet snapshot OR redeploy from main |
| Managed Postgres deleted  | <= 5 min via DO point-in-time-restore (PITR)  | <= 60 min   | DO PITR fork (preferred), then re-cutover      |
| Bad migration / data corr | <= 24 h via daily logical pg_dump on prod box | <= 60 min   | psql restore from `/app/backups/postgres`      |
| Region-wide outage        | <= 24 h logical, weekly droplet snapshot      | hours       | Manual rebuild in different region from dump   |

DigitalOcean Managed Postgres includes daily backups + 7-day PITR on every plan.
Droplet weekly backups: Sunday 04:00 UTC, 28-day retention (DO standard).

## Where backups live

| Backup                  | Location                                                                          | Retention | List command                                                          |
| ----------------------- | --------------------------------------------------------------------------------- | --------- | --------------------------------------------------------------------- |
| Droplet snapshots       | DO snapshots service                                                              | 28 days   | `doctl compute droplet backups list <ID>`                             |
| Managed Postgres backup | DO managed                                                                        | 7 days    | `doctl databases backups 9948c96b-b6b6-45ad-adf7-d20e4c206c66`        |
| Managed Postgres PITR   | DO managed                                                                        | 7 days    | API: `/v2/databases/<id>/replicas` and fork-from-time                 |
| Logical pg_dump         | `/app/backups/postgres/sitelayer-YYYYMMDDTHHMMSSZ.sql.gz` on prod droplet         | 30 days   | `ssh sitelayer ls /app/backups/postgres`                              |
| Off-host logical dump   | DO Spaces `s3://sitelayer-blueprints-prod/db-backups/` (NOT YET ENABLED)          | 90 days   | requires Spaces creds — see "Open work" below                         |

## On-call quick reference (5 commands)

```bash
# 1. Latest droplet snapshot ID
doctl compute droplet backups list 566798325 --format ID,Name,CreatedAt

# 2. Most recent managed PG backup
doctl databases backups 9948c96b-b6b6-45ad-adf7-d20e4c206c66

# 3. SSH to prod and list logical dumps
doctl compute ssh sitelayer --ssh-command='ls -lh /app/backups/postgres/'

# 4. Restore a logical dump into a fresh DB (target is sitelayer_prod_restore)
DATABASE_URL=postgres://doadmin:...@.../sitelayer_prod_restore \
  /app/sitelayer/scripts/restore-postgres.sh /app/backups/postgres/<dump>

# 5. Promote restore: swap APP_TIER+DATABASE_URL in /app/sitelayer/.env, then
docker compose -f /app/sitelayer/docker-compose.prod.yml up -d --force-recreate api worker
```

## Procedure 1 — Restore droplet from snapshot

Use when the prod droplet is lost or compromised but the managed DB is fine.

```bash
# List snapshots
doctl compute droplet backups list 566798325

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

## Procedure 2 — Restore Postgres from DO managed backup (preferred)

Use when DB is corrupted but cluster still exists, OR when cluster was deleted in last 7 days.

**Option A: Fork from PITR (sub-5min RPO).** This creates a NEW cluster from a point in time:

```bash
doctl databases fork \
  --restore-from-cluster-id 9948c96b-b6b6-45ad-adf7-d20e4c206c66 \
  --restore-from-timestamp 2026-04-24T22:30:00Z \
  sitelayer-db-restore \
  --engine pg \
  --version 18 \
  --region tor1 \
  --size db-s-1vcpu-1gb \
  --num-nodes 1
```

Wait until `doctl databases get <new-id>` shows status `online`, then point prod `.env` at the new connection URI:

```bash
doctl databases connection <NEW_DB_ID>
ssh sitelayer 'sudo -u sitelayer sed -i "s|^DATABASE_URL=.*|DATABASE_URL=<NEW_URI>|" /app/sitelayer/.env'
ssh sitelayer 'cd /app/sitelayer && docker compose up -d --force-recreate api worker'
```

After validation, retire the old cluster and rename the new one to `sitelayer-db`.

**Option B: In-place backup restore.** DO console only — no doctl verb. Settings -> Restore. Slower; effectively rebuilds the cluster.

## Procedure 3 — Restore from logical pg_dump

Use when you need to recover a single table, undo a bad migration, or DO managed backups are unavailable.

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
# App responds
curl -fsS https://sitelayer.sandolab.xyz/api/bootstrap

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

1. **DO Spaces off-host copy.** Logical dumps currently live only on the prod droplet — single point of failure. Once `DO_SPACES_KEY`/`DO_SPACES_SECRET` are populated in `/app/sitelayer/.env`:
   ```bash
   bash /app/sitelayer/scripts/provision-spaces-buckets.sh   # creates sitelayer-blueprints-{dev,preview,prod}
   ```
   Then extend `scripts/backup-postgres.sh` to `aws s3 cp` each dump to `s3://sitelayer-blueprints-prod/db-backups/`.
2. **Off-region snapshot.** DO weekly snapshot is region-local. For DR against a tor1 outage, schedule a monthly `pg_dump` copied to a non-tor1 Space.
3. **Backup monitoring.** Add a Sentry cron monitor or a heartbeat to a healthcheck endpoint so a missed nightly dump pages on-call.
