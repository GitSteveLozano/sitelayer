# Sitelayer Backup Strategy

**Status:** Production logical backup, Postgres off-host copy, Spaces-backed blueprint storage with versioning, blueprint-volume fallback copy, restore drill, and timer monitor installed; uses Dockerized Postgres 18 tooling
**Last updated:** 2026-04-25

## Current Managed Database Backups

DigitalOcean Managed Postgres provides automatic provider backups and point-in-time restore within the provider retention window. This is the first recovery path for short-term infrastructure failures.

Do not rely on provider backups as the only recovery layer. If the database cluster is deleted or a bad migration corrupts application data, independent logical backups give us a separate restore point.

## Backup Layers

1. **Provider backups:** DigitalOcean Managed Postgres automatic backups and point-in-time restore.
2. **Logical backups:** `scripts/backup-postgres.sh` creates compressed `pg_dump` files with configurable retention.
3. **Off-host copy:** `scripts/backup-postgres-offsite.sh` copies the newest dump to the preview droplet at `/app/offsite-backups/postgres-from-prod`.
4. **Blueprint primary storage:** `sitelayer-blueprints-prod` Spaces bucket in `tor1`, versioning enabled, app uses a scoped read/write key.
5. **Blueprint-volume fallback copy:** `scripts/backup-blueprints-offsite.sh` backs up `sitelayer_blueprint_storage` to `/app/offsite-backups/blueprints-from-prod` if local prod fallback is re-enabled.
6. **Pre-migration backups:** production deploys run the logical backup script before migrations.
7. **Restore drills:** restore a logical backup to a temporary database before pilot launch and after any major schema shift.
8. **Timer monitor:** hourly `sitelayer-timer-monitor.timer` checks backup/restore timer freshness and sends Sentry events on failure.

## Scripts

Create a backup:

```bash
BACKUP_DIR=/app/backups/postgres DATABASE_URL="$DATABASE_URL" scripts/backup-postgres.sh
```

Restore a backup to a target database:

```bash
DATABASE_URL="$RESTORE_TARGET_DATABASE_URL" scripts/restore-postgres.sh /app/backups/postgres/sitelayer-YYYYMMDDTHHMMSSZ.sql.gz
```

Install daily systemd backups on the production droplet:

```bash
sudo APP_DIR=/app/sitelayer ENV_FILE=/app/sitelayer/.env BACKUP_DIR=/app/backups/postgres RETENTION_DAYS=30 \
  bash /app/sitelayer/scripts/install-postgres-backup-systemd.sh
```

The installer creates `sitelayer-postgres-backup.timer`,
`sitelayer-postgres-offsite.timer`, and `sitelayer-restore-drill.timer`.
The backup timer defaults `PG_DUMP_DOCKER_IMAGE=postgres:18-alpine` because the
managed cluster is Postgres 18 and Ubuntu 22.04's default `pg_dump` is too old.
Install the blueprint-volume fallback timer separately with
`scripts/install-blueprint-backup-systemd.sh`, and install the hourly monitor
with `scripts/install-timer-monitor-systemd.sh`.

## Retention

Default logical retention is 30 days:

```bash
RETENTION_DAYS=30
```

For pilot, 30 days is enough. Move to 90 days once real customer production data exists or when contract requirements demand it.

## Droplet Snapshots

Both droplets (prod `566798325`, preview `566806040`) have weekly DO backups enabled (Sun 04:00 UTC, 28-day retention). Verify with:

```bash
curl -H "Authorization: Bearer $DO_TOKEN" \
  https://api.digitalocean.com/v2/droplets/566798325/backups/policy
```

## Disaster Recovery

Full restore procedures and on-call runbook live in `docs/DR_RESTORE.md`.

## Open Tasks

- Move the off-host Postgres copy from preview-droplet storage to DigitalOcean Spaces or another object store once database-backup retention requirements are defined.
- Wire Sentry timer-monitor alerts to an on-call routing rule once the on-call destination exists.
