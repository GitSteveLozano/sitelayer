# Sitelayer Backup Strategy

Last updated: 2026-04-24.

## Layers

Three independent layers, in increasing recovery cost:

1. **DigitalOcean managed Postgres automatic backups** — provider-managed,
   short retention. First recovery path for any cluster-level issue
   (operator-error drop, replica failure, accidental migration).
2. **Local logical pg_dump on the prod droplet** — `scripts/backup-postgres.sh`
   produces gzipped `pg_dump` files at `/app/backups/postgres`,
   30-day retention, daily at **03:17 UTC** via
   `sitelayer-postgres-backup.timer`. Survives DO Postgres outage; does NOT
   survive prod droplet loss.
3. **Off-host copy on the preview droplet** — `scripts/backup-postgres-offsite.sh`
   rsyncs the latest local dump from prod to the preview droplet over the
   private network, daily at **03:32 UTC** via
   `sitelayer-postgres-offsite.timer`. Survives prod droplet loss.

## Retention

| Layer                  | Retention | Location                                              |
| ---------------------- | --------- | ----------------------------------------------------- |
| DO managed backups     | provider default | DigitalOcean                                   |
| Local logical pg_dump  | 30 days   | prod droplet `/app/backups/postgres`                  |
| Off-host (preview drop)| 30 days   | preview droplet `/app/offsite-backups/postgres-from-prod` |

## Off-host copy details

`scripts/backup-postgres-offsite.sh`:

- Picks the newest file matching `sitelayer-*.sql.gz` in `BACKUP_DIR`.
- Rsyncs to `OFFSITE_HOST:OFFSITE_DIR/<name>.tmp` (default
  `sitelayer@10.118.0.2:/app/offsite-backups/postgres-from-prod/`).
- Forces a remote `sync`, computes `sha256sum` on both ends, fails loudly
  on mismatch and leaves the `.tmp` in place for inspection.
- Atomic `mv .tmp -> final` only on sha256 match; chmods `600`.
- Mirrors 30-day retention on the remote side and sweeps stray `.tmp` files
  older than 1 day.
- Never deletes the local source file regardless of remote success.

The transport is the **DigitalOcean private 10.118.0.0/16 network**, not the
public internet. Both droplets share the VPC.

DO Spaces is the eventual target; off-host-to-preview is a stopgap until
Spaces credentials are minted in the DO web UI and added to prod `.env`.

## Restore drill

`scripts/restore-drill.sh` is the monthly verification:

```bash
bash /app/sitelayer/scripts/restore-drill.sh
```

What it does:

- Spins up a throwaway `postgres:18-alpine` container (no port mapping,
  tmpfs-backed data dir).
- Restores the most recent dump in `BACKUP_DIR`.
- Runs sanity queries:
  - row counts > 0 on `companies`, `projects`, `takeoff_measurements`
  - `max(created_at)` on `takeoff_measurements` is within
    `RECENCY_HOURS` (default 48h) of now.
- Tears down the container.
- Prints `PASS:` / `FAIL:` summary, exits 0 / 1 accordingly.

A weekly systemd timer (`sitelayer-restore-drill.timer`, Sundays 04:00 UTC)
appends the output to `/var/log/sitelayer/restore-drill.log`. The timer is
**log-only** — there is no pager hookup. Pager wiring is a separate concern;
plug it into whatever monitoring shows up later (Sentry cron monitor, an
`uptime-kuma`, etc.).

To skip drill timer install:

```bash
sudo INSTALL_DRILL_TIMER=0 ... bash scripts/install-postgres-backup-systemd.sh
```

## Install / re-install

The installer is idempotent — re-run after editing the script:

```bash
sudo APP_DIR=/app/sitelayer ENV_FILE=/app/sitelayer/.env \
  BACKUP_DIR=/app/backups/postgres RETENTION_DAYS=30 \
  OFFSITE_HOST=sitelayer@10.118.0.2 \
  OFFSITE_DIR=/app/offsite-backups/postgres-from-prod \
  bash /app/sitelayer/scripts/install-postgres-backup-systemd.sh
```

Then verify:

```bash
systemctl list-timers \
  sitelayer-postgres-backup.timer \
  sitelayer-postgres-offsite.timer \
  sitelayer-restore-drill.timer
systemctl status sitelayer-postgres-offsite.service
```

## SSH from prod -> preview

The off-site copy needs the `sitelayer` user on prod to be able to SSH to
`sitelayer@10.118.0.2` non-interactively. Setup once, on the prod droplet
as the `sitelayer` user:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''
ssh-copy-id -i ~/.ssh/id_ed25519.pub sitelayer@10.118.0.2
```

…and on the preview droplet:

```bash
sudo install -d -m 700 -o sitelayer -g sitelayer /app/offsite-backups/postgres-from-prod
```

The systemd service uses `BatchMode=yes` so any password / host-key prompt
is a hard failure and surfaces in `journalctl -u sitelayer-postgres-offsite`.

## Recovery runbook

1. Identify the right dump:
   - prefer the local `BACKUP_DIR` on prod;
   - if the prod droplet itself is lost, `ssh sitelayer@10.118.0.2` and pull
     from `/app/offsite-backups/postgres-from-prod`.
2. Stand up a replacement Postgres (managed DB or a new container).
3. Restore: `DATABASE_URL=… scripts/restore-postgres.sh path/to/dump.sql.gz`.
4. Validate: row counts via `scripts/check-db-schema.sh`, smoke the API.
5. Re-point the prod stack at the restored DB and redeploy.

## Cadence

| Action           | Frequency               | Owner |
| ---------------- | ----------------------- | ----- |
| Local dump       | daily 03:17 UTC (timer) | systemd |
| Off-host copy    | daily 03:32 UTC (timer) | systemd |
| Restore drill    | weekly (timer, log only) + **monthly manual** `bash scripts/restore-drill.sh` | Taylor |
| Spaces migration | one-shot, when DO Spaces creds land | Taylor |
