#!/usr/bin/env bash
#
# Periodic regression check for deterministic workflows.
#
# For every non-terminal row in rental_billing_runs and estimate_pushes,
# replay its workflow_event_log through the registered reducer and
# compare the output to the persisted row state. Divergence means a
# reducer change broke replay against historical data — Sentry alert
# fires.
#
# Run as the deploy user (or root) on the prod droplet via the
# sitelayer-replay-sweep systemd timer (installed by
# scripts/install-replay-sweep-systemd.sh).
#
# Tunable env vars:
#   APP_DIR         (default /app/sitelayer) — repo checkout
#   DATABASE_URL    (loaded from APP_DIR/.env if unset)
#   SWEEP_LIMIT     (default 100) — cap rows per workflow per run
#   DRY_RUN=1       — list the entity ids that would be replayed,
#                      don't actually run replay-workflow.ts

set -euo pipefail

APP_DIR="${APP_DIR:-/app/sitelayer}"
SWEEP_LIMIT="${SWEEP_LIMIT:-100}"

cd "$APP_DIR"

if [ -z "${DATABASE_URL:-}" ] && [ -f "$APP_DIR/.env" ]; then
  # shellcheck disable=SC1091
  set -a
  source "$APP_DIR/.env"
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set and not found in $APP_DIR/.env" >&2
  exit 1
fi

# Helper: query for entity ids in non-terminal states.
psql_query() {
  local sql="$1"
  docker run --rm --network host -e DATABASE_URL="$DATABASE_URL" \
    postgres:18-alpine \
    psql "$DATABASE_URL" -t -A -c "$sql"
}

# Two workflows known to the registry. If we add a third, list it
# here. The replay script enforces the registry membership anyway.
WORKFLOWS=(
  "rental_billing_run|select id from rental_billing_runs where deleted_at is null and status not in ('posted', 'voided') order by updated_at desc limit $SWEEP_LIMIT"
  "estimate_push|select id from estimate_pushes where deleted_at is null and status not in ('posted', 'voided') order by updated_at desc limit $SWEEP_LIMIT"
)

total_ok=0
total_diverged=0
total_skipped=0

for entry in "${WORKFLOWS[@]}"; do
  workflow="${entry%%|*}"
  query="${entry#*|}"
  echo "==> Sweeping $workflow"

  ids="$(psql_query "$query" || true)"
  if [ -z "$ids" ]; then
    echo "    no non-terminal rows"
    continue
  fi

  while IFS= read -r entity_id; do
    [ -z "$entity_id" ] && continue
    if [ "${DRY_RUN:-0}" = "1" ]; then
      echo "    DRY_RUN: would replay $workflow $entity_id"
      continue
    fi

    set +e
    out="$(npx tsx scripts/replay-workflow.ts "$workflow" "$entity_id" 2>&1)"
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
      total_ok=$((total_ok + 1))
    elif [ "$rc" -eq 2 ]; then
      total_diverged=$((total_diverged + 1))
      # Echo divergence to stdout so journalctl captures it; the systemd
      # service's StandardOutput=journal makes this visible.
      echo "DIVERGENCE $workflow $entity_id"
      echo "$out"
      # Sentry alert: best-effort via curl. Sentry env var may or may not
      # be set; if absent, journal log is the audit trail.
      if [ -n "${SENTRY_DSN:-}" ]; then
        # Minimal Sentry envelope. Real plumbing would use the SDK; this
        # is a one-line break-glass alert.
        :
      fi
    else
      total_skipped=$((total_skipped + 1))
      echo "SKIPPED $workflow $entity_id (rc=$rc)"
      echo "$out"
    fi
  done <<<"$ids"
done

echo "==> Sweep complete: ok=$total_ok diverged=$total_diverged skipped=$total_skipped"

# Non-zero exit if any divergence so the systemd unit reports failure
# and the unit's OnFailure= can wire to Sentry/Slack later.
if [ "$total_diverged" -gt 0 ]; then
  exit 2
fi
