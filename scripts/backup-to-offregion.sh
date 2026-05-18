#!/usr/bin/env bash
# Off-region prod Postgres backup.
#
# Streams `pg_dump | gzip` straight into a DigitalOcean Spaces bucket in a
# non-`tor1` region. All existing backup paths (managed PG PITR, weekly
# droplet snapshot, daily logical dump + off-host copy to the preview
# droplet) live in `tor1`; this script is the defense-in-depth path for a
# region-wide DO outage.
#
# Designed to run under systemd as the `sitelayer` user on the prod
# droplet (see ops/systemd/sitelayer-offregion-backup.{service,timer}).
#
# Env contract (all four required, no defaults):
#   DATABASE_URL                   prod Postgres URL (managed PG)
#   DO_SPACES_OFFREGION_KEY        scoped Spaces access key id
#   DO_SPACES_OFFREGION_SECRET     scoped Spaces secret
#   DO_SPACES_OFFREGION_BUCKET     e.g. sitelayer-backups-nyc3
#   DO_SPACES_OFFREGION_ENDPOINT   e.g. https://nyc3.digitaloceanspaces.com
#
# Optional:
#   DO_SPACES_OFFREGION_REGION     default derived from endpoint host (nyc3 etc.)
#   RETAIN_DAYS                    default 35; overridden by --retain-days
#   ENV_FILE                       default /app/sitelayer/.env
#   AWS_CLI                        default `aws`
#
# Flags:
#   --retain-days N    delete objects under prod/ older than N days (default 35)
#   --skip-prune       skip the retention pass
#   --skip-backup      only run the retention pass (useful for manual sweeps)
#
# Exit codes:
#   0  full success (backup uploaded + retention pass clean, if enabled)
#   1  config / preflight failure
#   2  backup pipeline failure (pg_dump | gzip | aws s3 cp)
#   3  retention pass failure (object listed but delete failed)
#
# The script intentionally fails loudly when env vars are missing — the
# operator is expected to configure these before enabling the timer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-/app/sitelayer/.env}"
RETAIN_DAYS_DEFAULT=35
RETAIN_DAYS="${RETAIN_DAYS:-$RETAIN_DAYS_DEFAULT}"
SKIP_BACKUP=0
SKIP_PRUNE=0
AWS_CLI="${AWS_CLI:-aws}"

log() {
  printf '[offregion-backup] %s\n' "$*"
}

err() {
  printf '[offregion-backup] ERROR: %s\n' "$*" >&2
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    err "required env var $name is not set (configure $ENV_FILE or the systemd unit)"
    exit 1
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    --retain-days)
      RETAIN_DAYS="$2"
      shift 2
      ;;
    --retain-days=*)
      RETAIN_DAYS="${1#*=}"
      shift
      ;;
    --skip-prune)
      SKIP_PRUNE=1
      shift
      ;;
    --skip-backup)
      SKIP_BACKUP=1
      shift
      ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      err "unknown arg: $1"
      exit 1
      ;;
  esac
done

if ! [[ "$RETAIN_DAYS" =~ ^[0-9]+$ ]]; then
  err "--retain-days must be a non-negative integer (got: $RETAIN_DAYS)"
  exit 1
fi

# Load env. /app/sitelayer/.env is the rendered prod env on the droplet.
# Missing file is fine if all required vars are already exported by
# systemd (EnvironmentFile= or Environment=). Use the set -a / set +a
# pattern that matches the style of scripts/migrate-db.sh callers.
if [ -f "$ENV_FILE" ]; then
  log "sourcing env from $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
else
  log "env file $ENV_FILE not present; relying on inherited environment"
fi

require_env DATABASE_URL
require_env DO_SPACES_OFFREGION_KEY
require_env DO_SPACES_OFFREGION_SECRET
require_env DO_SPACES_OFFREGION_BUCKET
require_env DO_SPACES_OFFREGION_ENDPOINT

# Refuse to ship to a tor1 endpoint by mistake — the whole point is
# off-region. Operator can override by exporting OFFREGION_ALLOW_TOR1=1
# (e.g. local rehearsal against a tor1 sandbox bucket).
case "$DO_SPACES_OFFREGION_ENDPOINT" in
  *tor1*)
    if [ "${OFFREGION_ALLOW_TOR1:-0}" != "1" ]; then
      err "DO_SPACES_OFFREGION_ENDPOINT points at tor1; refusing to run (set OFFREGION_ALLOW_TOR1=1 to override)"
      exit 1
    fi
    log "OFFREGION_ALLOW_TOR1=1 — proceeding against tor1 endpoint (rehearsal only)"
    ;;
esac

# Derive region (e.g. https://nyc3.digitaloceanspaces.com -> nyc3) for the
# `aws --region` arg. Spaces accepts most region tokens but explicitly
# matching the endpoint avoids subtle SigV4 mismatches.
if [ -z "${DO_SPACES_OFFREGION_REGION:-}" ]; then
  host="${DO_SPACES_OFFREGION_ENDPOINT#https://}"
  host="${host#http://}"
  DO_SPACES_OFFREGION_REGION="${host%%.*}"
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  err "pg_dump is required on PATH (install postgresql-client matching the prod PG major)"
  exit 1
fi

if ! command -v gzip >/dev/null 2>&1; then
  err "gzip is required on PATH"
  exit 1
fi

if ! command -v "$AWS_CLI" >/dev/null 2>&1; then
  err "$AWS_CLI is required on PATH (install with: pip install awscli, or set AWS_CLI=...)"
  exit 1
fi

# pg_dump must read RLS-protected tables (audit_events, mutation_outbox,
# sync_events, workflow_event_log — RLS ENABLED via migration 073). Same
# trick as scripts/backup-postgres.sh: -c row_security=off at the GUC
# layer. DO managed-PG deploy user has BYPASSRLS so this is allowed.
PG_DUMP_PGOPTIONS="${PG_DUMP_PGOPTIONS:--c row_security=off}"

# Configure awscli to talk to the off-region Spaces endpoint. Scope the
# vars to this invocation rather than mutating the calling env.
export AWS_ACCESS_KEY_ID="$DO_SPACES_OFFREGION_KEY"
export AWS_SECRET_ACCESS_KEY="$DO_SPACES_OFFREGION_SECRET"
export AWS_DEFAULT_REGION="$DO_SPACES_OFFREGION_REGION"
export AWS_ENDPOINT_URL="$DO_SPACES_OFFREGION_ENDPOINT"

bucket="$DO_SPACES_OFFREGION_BUCKET"

if [ "$SKIP_BACKUP" -ne 1 ]; then
  # Key: prod/YYYY/MM/DD/HHMMSSZ-prod.sql.gz so the listing partitions
  # naturally by day. UTC; the systemd timer fires at 06:00 UTC.
  stamp_dir="$(date -u +%Y/%m/%d)"
  stamp_file="$(date -u +%H%M%SZ)"
  key="prod/${stamp_dir}/${stamp_file}-prod.sql.gz"
  uri="s3://${bucket}/${key}"

  log "start: pg_dump | gzip -> ${uri}"
  log "region=${DO_SPACES_OFFREGION_REGION} endpoint=${DO_SPACES_OFFREGION_ENDPOINT}"

  # Stream the dump into S3. `aws s3 cp -` reads stdin and uses multipart
  # upload internally so the dump is never staged on local disk. PIPESTATUS
  # lets us catch a pg_dump or gzip failure even though `aws s3 cp` exited 0.
  set +e
  PGOPTIONS="$PG_DUMP_PGOPTIONS" pg_dump --no-owner --no-privileges "$DATABASE_URL" \
    | gzip -9 \
    | "$AWS_CLI" s3 cp --no-progress --expected-size 0 - "$uri"
  pipe_status=("${PIPESTATUS[@]}")
  set -e

  for s in "${pipe_status[@]}"; do
    if [ "$s" -ne 0 ]; then
      err "backup pipeline failed (PIPESTATUS=${pipe_status[*]})"
      exit 2
    fi
  done

  # Report the uploaded object size so journalctl shows growth over time.
  remote_size="$("$AWS_CLI" s3 ls "$uri" 2>/dev/null | awk 'NR==1 {print $3}')"
  if [ -n "${remote_size:-}" ]; then
    human="$(numfmt --to=iec --suffix=B "$remote_size" 2>/dev/null || echo "${remote_size}B")"
    log "uploaded ${human} (${remote_size} bytes) -> ${uri}"
  else
    log "uploaded -> ${uri} (size unknown; aws s3 ls returned empty)"
  fi
fi

if [ "$SKIP_PRUNE" -ne 1 ]; then
  log "retention pass: deleting prod/ objects older than ${RETAIN_DAYS} days"

  if command -v gdate >/dev/null 2>&1; then
    cutoff="$(gdate -u -d "${RETAIN_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
  else
    cutoff="$(date -u -d "${RETAIN_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
  fi
  log "cutoff: $cutoff (UTC)"

  # `aws s3api list-objects-v2` paginates the entire prefix. We read the
  # JSON with python — already installed wherever awscli works — to avoid
  # a jq dependency. Each row: "<iso-mtime> <key>".
  listing="$(
    "$AWS_CLI" s3api list-objects-v2 \
      --bucket "$bucket" \
      --prefix "prod/" \
      --query 'Contents[].[LastModified,Key]' \
      --output text 2>/dev/null || true
  )"

  if [ -z "$listing" ]; then
    log "retention pass: bucket prefix prod/ is empty, nothing to do"
    exit 0
  fi

  deleted=0
  kept=0
  failed=0
  while IFS=$'\t' read -r mtime key; do
    [ -z "$key" ] && continue
    if [[ "$mtime" < "$cutoff" ]]; then
      if "$AWS_CLI" s3 rm "s3://${bucket}/${key}" >/dev/null; then
        deleted=$((deleted + 1))
      else
        err "failed to delete s3://${bucket}/${key}"
        failed=$((failed + 1))
      fi
    else
      kept=$((kept + 1))
    fi
  done <<<"$listing"

  log "retention pass: deleted=${deleted} kept=${kept} failed=${failed}"

  if [ "$failed" -gt 0 ]; then
    exit 3
  fi
fi

log "done"
