# Sitelayer Backup Strategy

**Audience:** operator / on-call. This is the source-of-truth description of
what is backed up, where it lives, how often, and how it is verified. The
**restore** procedures live in [`DR_RESTORE.md`](./DR_RESTORE.md) — this doc is
the topology + cadence; that doc is the recovery runbook.

## TL;DR

- **Managed Postgres has NO PITR.** The cluster is `db-s-1vcpu-2gb` **single
  node** (`NumNodes=1`). DO point-in-time recovery is gated on a **standby
  node** (`--num-nodes 2`), NOT on RAM — and resizing RAM will not change that
  (the cluster is already `db-s-1vcpu-2gb`). See `DR_RESTORE.md`.
- **The real DB RPO is ≈ 24 h**, set by the daily logical `pg_dump`. The
  managed daily auto-backups are a coarse (~daily, not point-in-time) fallback.
- Postgres logical dumps are kept in **three places**: local on the prod
  droplet, off-host on the preview droplet, and **off-region** in a non-`tor1`
  Spaces bucket (defense-in-depth against a whole-region DO outage).
- Blueprint PDFs live in DO Spaces (`sitelayer-blueprints-prod`, versioned) with
  an off-host fallback copy on the preview droplet.

## Backup topology

| Backup                       | What                                  | Where                                                                  | Schedule (UTC)        | Retention              | Script / unit                                                               |
| ---------------------------- | ------------------------------------- | ---------------------------------------------------------------------- | --------------------- | ---------------------- | --------------------------------------------------------------------------- |
| Managed auto-backups         | Full managed PG snapshot (coarse)     | DO managed (in-cluster)                                                | ~daily (DO-managed)   | ~7 days                | DO-managed — `doctl databases backups 9948c96b-…`                           |
| Logical pg_dump (local)      | `pg_dump \| gzip` of `sitelayer_prod` | Prod droplet `/app/backups/postgres/sitelayer-YYYYMMDDTHHMMSSZ.sql.gz` | daily ~03:17          | 30 days                | `scripts/backup-postgres.sh` → `sitelayer-postgres-backup.timer`            |
| Logical pg_dump (off-host)   | rsync of the latest local dump        | Preview droplet `10.118.0.2:/app/offsite-backups/postgres-from-prod`   | daily ~03:32          | 30 days                | `scripts/backup-postgres-offsite.sh` → `sitelayer-postgres-offsite.timer`   |
| Logical pg_dump (off-region) | `pg_dump \| gzip` streamed to Spaces  | Non-`tor1` Spaces `prod/YYYY/MM/DD/HHMMSSZ-prod.sql.gz`                | daily 06:00           | 35 days                | `scripts/backup-to-offregion.sh` → `sitelayer-offregion-backup.timer`       |
| Blueprint objects            | Customer PDFs                         | DO Spaces `sitelayer-blueprints-prod` (`tor1`, versioning on)          | continuous (on write) | indefinite (versioned) | app write path (`apps/api/src/storage.ts`)                                  |
| Blueprint objects (off-host) | Fallback copy of blueprint volume     | Preview droplet `/app/offsite-backups/blueprints-from-prod`            | per timer             | 30 days                | `scripts/backup-blueprints-offsite.sh` → `sitelayer-blueprint-backup.timer` |
| Droplet snapshots            | Whole-droplet image (prod+preview)    | DO snapshots service                                                   | weekly Sun 04:00      | 28 days                | DO droplet backup add-on                                                    |

All three logical-dump paths use `pg_dump --enable-row-security` so RLS-FORCEd
tables (migrations 073 / 085) are fully captured under the permissive
`app_current_company_id() IS NULL` policy — the managed deploy user is not
`BYPASSRLS`, so this flag is load-bearing, not cosmetic.

### Off-region path detail

`scripts/backup-to-offregion.sh` streams `pg_dump | gzip | aws s3 cp -`
straight into a **non-`tor1`** Spaces bucket (the script refuses a `tor1`
endpoint unless `OFFREGION_ALLOW_TOR1=1`, since the whole point is region
independence). Required env on the prod droplet (`/app/sitelayer/.env`, manifest
entries in `ops/env/production.env.json`):

- `DO_SPACES_OFFREGION_KEY`
- `DO_SPACES_OFFREGION_SECRET`
- `DO_SPACES_OFFREGION_BUCKET` (e.g. `sitelayer-backups-nyc3`)
- `DO_SPACES_OFFREGION_ENDPOINT` (e.g. `https://nyc3.digitaloceanspaces.com`)

The dump is never staged on local disk (multipart upload from stdin). Listing
partitions by day (`prod/YYYY/MM/DD/…`); the script's own retention pass deletes
objects older than `--retain-days` (default 35).

## Backup monitoring

The backup **timers** are watched by `scripts/check-systemd-timers.sh`
(installed as `sitelayer-timer-monitor` via
`scripts/install-timer-monitor-systemd.sh`). It checks each unit's last
successful run against a staleness threshold and emits a Sentry event when a
timer is stale or has failed. Default watched units + thresholds:

- `sitelayer-postgres-backup.service` — stale after 36 h
- `sitelayer-postgres-offsite.service` — stale after 36 h
- `sitelayer-blueprint-backup.service` — stale after 36 h
- `sitelayer-restore-drill.service` — stale after 8 days

> **Gaps to close (operator tasks):**
>
> - The **off-region** unit (`sitelayer-offregion-backup.service`) is NOT in the
>   default `TIMER_MONITOR_SPECS` — add it so a silent off-region failure is
>   caught (it's the only copy that survives a `tor1`-wide outage).
> - Timer-monitor Sentry events are emitted by host tooling and land in the
>   **`sitelayer-api`** Sentry project (worker/host events fall back to
>   `SENTRY_DSN` — `SENTRY_WORKER_DSN` is absent). There is no live
>   `sitelayer-worker` project.
> - These Sentry events are not yet routed to a pager destination (see
>   `DR_RESTORE.md` Open work #3).

## Restore drills

`scripts/restore-drill.sh` spins up a throwaway `postgres:18-alpine` container,
restores the **most recent local logical dump** into it, runs sanity queries
(row counts + a recency check), tears the scratch container down, and prints
PASS/FAIL. It exercises the actual restore path end-to-end without touching
prod.

**Cadence:**

- **Automated:** `sitelayer-restore-drill.service` runs **weekly, Sunday 04:00
  UTC** (`DRILL_TIME=Sun *-*-* 04:00:00`), logging to `/var/log/sitelayer`.
  (Note: the script's header comment says "monthly" — the installed timer is
  weekly; the timer is authoritative.)
- **On demand after risky schema changes:** after any migration touching
  customer data, run `DR_RESTORE.md` Procedure 3 to a throwaway DB and run
  `scripts/check-db-schema.sh`.
- **Quarterly:** full droplet-snapshot restore drill (`DR_RESTORE.md`
  Procedure 1) into a `sitelayer-dr-test` droplet, then destroy.

### Drill log

Record each drill result here (date, dump tested, PASS/FAIL, notes). The mesh
`record_restore_drill_result` / `list_restore_drill_events` tools are the
operator-facing ledger; this section is the human-readable mirror.

| Date                                                           | Dump tested | Result | Notes |
| -------------------------------------------------------------- | ----------- | ------ | ----- |
| _(none recorded yet — populate from the next automated drill)_ |             |        |       |

## Open work

1. Add `sitelayer-offregion-backup.service` to the timer-monitor spec.
2. Confirm `DO_SPACES_OFFREGION_*` env is provisioned on the prod droplet and
   the off-region timer is `active` (`systemctl list-timers | grep offregion`).
3. Provision a Postgres **standby node** (`--num-nodes 2`) if/when the ≈24 h
   logical-dump RPO is too coarse for pilot data — that, not a RAM resize, is
   what unlocks PITR. Budget ≈ +$15/mo (see `COST_AND_LIMITS.md`).
4. Route backup-timer Sentry events to a pager destination.

## See also

- [`DR_RESTORE.md`](./DR_RESTORE.md) — the restore runbook (procedures 1–3).
- [`COST_AND_LIMITS.md`](./COST_AND_LIMITS.md) — DB tier, connection cap, PITR
  upgrade cost.
- [`UPTIME_ROBOT_MONITORS.md`](./UPTIME_ROBOT_MONITORS.md) — external liveness
  checks (separate from backup-timer monitoring).
