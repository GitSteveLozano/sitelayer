# Sitelayer Backup Strategy

**Status:** Logical backup scripts added; production timer uses Dockerized Postgres 18 `pg_dump`
**Last updated:** 2026-04-24

## Current Managed Database Backups

DigitalOcean Managed Postgres provides automatic provider backups and point-in-time restore within the provider retention window. This is the first recovery path for short-term infrastructure failures.

Do not rely on provider backups as the only recovery layer. If the database cluster is deleted or a bad migration corrupts application data, independent logical backups give us a separate restore point.

## Backup Layers

1. **Provider backups:** DigitalOcean Managed Postgres automatic backups and point-in-time restore.
2. **Logical backups:** `scripts/backup-postgres.sh` creates compressed `pg_dump` files with configurable retention.
3. **Pre-migration backups:** run the logical backup script before destructive schema changes.
4. **Restore drills:** restore a logical backup to a temporary database before pilot launch and after any major schema shift.

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

The timer defaults `PG_DUMP_DOCKER_IMAGE=postgres:18-alpine` because the managed cluster is Postgres 18 and Ubuntu 22.04's default `pg_dump` is too old.

## Retention

Default logical retention is 30 days:

```bash
RETENTION_DAYS=30
```

For pilot, 30 days is enough. Move to 90 days once real customer production data exists or when contract requirements demand it.

## Open Tasks

- Add off-host copy to DigitalOcean Spaces or another object store once Spaces is provisioned.
- Run a restore drill against a non-production database and record the result.
