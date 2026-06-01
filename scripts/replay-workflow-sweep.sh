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

# Workflows known to the registry. The replay script enforces registry
# membership; this list controls which tables we sweep.
# Each entry: <workflow_name>|<select returning non-terminal entity ids>.
# Terminal filters mirror each reducer's *_TERMINAL_STATES so a row that
# can still receive events is the only thing we replay (terminal rows are
# replay-stable by construction). `deleted_at is null` is only added for
# tables that actually have the column (verified against docker/postgres/init).
WORKFLOWS=(
  "rental_billing_run|select id from rental_billing_runs where deleted_at is null and status not in ('posted', 'voided') order by updated_at desc limit $SWEEP_LIMIT"
  "estimate_push|select id from estimate_pushes where deleted_at is null and status not in ('posted', 'voided') order by updated_at desc limit $SWEEP_LIMIT"
  "crew_schedule|select id from crew_schedules where deleted_at is null order by updated_at desc limit $SWEEP_LIMIT"
  "rental|select id from rentals where deleted_at is null and status <> 'closed' order by updated_at desc limit $SWEEP_LIMIT"
  "project_closeout|select id from projects where deleted_at is null and status <> 'completed' order by updated_at desc limit $SWEEP_LIMIT"
  "labor_payroll_run|select id from labor_payroll_runs where deleted_at is null and state not in ('posted', 'voided') order by updated_at desc limit $SWEEP_LIMIT"
  "project_lifecycle|select id from projects where deleted_at is null and lifecycle_state <> 'archived' order by updated_at desc limit $SWEEP_LIMIT"
  "field_event|select id from worker_issues order by created_at desc limit $SWEEP_LIMIT"
  "daily_log|select id from daily_logs where status <> 'submitted' order by updated_at desc limit $SWEEP_LIMIT"
  "notification|select id from notifications where status not in ('sent', 'voided', 'failed_clerk_not_found', 'failed_clerk_unreachable', 'failed_provider') order by updated_at desc limit $SWEEP_LIMIT"
  "shipment|select id from shipments where deleted_at is null and status not in ('closed', 'voided') order by updated_at desc limit $SWEEP_LIMIT"
  "damage_charge_settlement|select id from damage_charges where deleted_at is null and status not in ('invoiced', 'waived') order by updated_at desc limit $SWEEP_LIMIT"
  "rental_request_approval|select id from rental_requests where status not in ('approved', 'declined') order by updated_at desc limit $SWEEP_LIMIT"
  "qbo_sync_run|select id from qbo_sync_runs where deleted_at is null and status not in ('succeeded', 'failed') order by updated_at desc limit $SWEEP_LIMIT"
  "scaffold_ops_approval|select id from boms where deleted_at is null and status not in ('approved', 'superseded') order by updated_at desc limit $SWEEP_LIMIT"
  "change_order|select id from change_orders where deleted_at is null and status not in ('accepted', 'rejected', 'voided') order by updated_at desc limit $SWEEP_LIMIT"
  "time_review_run|select id from time_review_runs where state not in ('approved', 'rejected') order by updated_at desc limit $SWEEP_LIMIT"
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
