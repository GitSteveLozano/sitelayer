#!/usr/bin/env bash
set -euo pipefail

# Reset a non-prod tier's database to a clean, freshly-migrated state.
#
# This is the disposable-DB lever: non-prod data is throwaway, so a "reset" is
# just recreate-from-empty + re-migrate (+ reseed for demo) — never a data move.
#
# Usage:
#   scripts/reset-tier-db.sh <dev|demo|preview> [slug]
#
#   dev     → the persistent `sitelayer-dev` stack
#   demo    → the persistent `sitelayer-demo` stack (re-migrate only; the demo
#             seed is applied by `scripts/deploy.sh demo` on the next deploy)
#   preview → a per-PR `sitelayer-pr-<n>` stack; pass the slug as the 2nd arg
#             (e.g. `scripts/reset-tier-db.sh preview pr-42`)
#
# Backend behavior (auto-detected from the stack's rendered .env):
#   local    → DROP + recreate the per-stack Postgres CONTAINER and its named
#              volume (preview_db_data). Instant; this is the end-state path.
#   managed  → fall back to the per-object public-schema drop against the
#              managed cluster (the same conservative DDL reset-dev-db.sh does).
#
# Refuses to touch anything whose resolved DATABASE_URL mentions sitelayer_prod.
#
# Env:
#   PREVIEW_ROOT          default /app/previews
#   RESET_TIER_DB_CONFIRM=1   skip the y/N prompt
#   PSQL_DOCKER_IMAGE=...      psql image for the managed-backend fallback

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PREVIEW_ROOT="${PREVIEW_ROOT:-/app/previews}"

tier="${1:-}"
slug_arg="${2:-}"

case "$tier" in
  dev)  slug="dev";  project="sitelayer-dev" ;;
  demo) slug="demo"; project="sitelayer-demo" ;;
  preview)
    if [ -z "$slug_arg" ]; then
      echo "ERROR: preview reset requires a slug, e.g. 'reset-tier-db.sh preview pr-42'" >&2
      exit 1
    fi
    slug="$(printf '%s' "$slug_arg" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
    project="sitelayer-${slug}"
    ;;
  *)
    echo "usage: scripts/reset-tier-db.sh <dev|demo|preview> [slug]" >&2
    exit 1
    ;;
esac

target_dir="$PREVIEW_ROOT/$slug"
env_file="$target_dir/.env"

if [ ! -d "$target_dir" ]; then
  echo "ERROR: stack directory not found: $target_dir" >&2
  echo "       Deploy the $tier stack first (scripts/deploy.sh $tier or scripts/deploy-preview.sh)." >&2
  exit 1
fi

cd "$REPO_ROOT"
source "$SCRIPT_DIR/db-common.sh"

backend="$(read_env_value "$env_file" PREVIEW_DB_BACKEND)"
backend="${backend:-managed}"

db_url="$(read_env_value "$env_file" DATABASE_URL)"
if [[ "$db_url" == *"sitelayer_prod"* ]]; then
  echo "ERROR: $env_file DATABASE_URL mentions sitelayer_prod — refusing to reset" >&2
  exit 1
fi

if [ "${RESET_TIER_DB_CONFIRM:-0}" != "1" ]; then
  echo "About to RESET the $tier database (stack $project, backend=$backend) to a clean migrated state."
  printf 'Type "reset %s" to continue: ' "$tier"
  read -r reply
  if [ "$reply" != "reset $tier" ]; then
    echo "Aborted."
    exit 1
  fi
fi

LOCAL_DB_SERVICE="preview-db"
LOCAL_DB_URL="postgres://sitelayer:sitelayer@${LOCAL_DB_SERVICE}:5432/sitelayer"

if [ "$backend" = "local" ]; then
  compose_file=""
  for candidate in docker-compose.preview.yml docker-compose.preview-prod.yml; do
    if [ -f "$target_dir/$candidate" ]; then
      compose_file="$target_dir/$candidate"
      break
    fi
  done
  if [ -z "$compose_file" ]; then
    echo "ERROR: no preview compose file found under $target_dir" >&2
    exit 1
  fi

  db_overlay="$target_dir/docker-compose.preview-db.yml"
  [ -f "$db_overlay" ] || db_overlay="$REPO_ROOT/docker-compose.preview-db.yml"

  # Absolute -f paths so the cwd does not matter. The named volume is
  # project-namespaced, so recreating from empty == an instant reset.
  compose_base=(-f "$compose_file" -f "$db_overlay" -p "$project")
  env_args=()
  [ -f "$env_file" ] && env_args=(--env-file "$env_file")

  echo "Local backend: recreating the $LOCAL_DB_SERVICE container + volume for $project…"
  # Stop the db service and drop ONLY its container. `down` would also stop the
  # app containers; `rm -fsv <service>` removes just the database container and
  # its anonymous deps. We then prune the named volume explicitly.
  docker compose "${env_args[@]}" "${compose_base[@]}" rm -fsv "$LOCAL_DB_SERVICE" \
    || echo "WARN: failed to remove $LOCAL_DB_SERVICE container (continuing)"

  # Drop the project-namespaced data volume so the recreate starts empty.
  vol="${project}_preview_db_data"
  docker volume rm "$vol" >/dev/null 2>&1 || true

  echo "Bringing a fresh $LOCAL_DB_SERVICE container up…"
  docker compose "${env_args[@]}" "${compose_base[@]}" up -d "$LOCAL_DB_SERVICE"

  net="${project}_app"
  echo "Applying migrations against the fresh container…"
  # 016_restore_constrained_role.sql replaced the squash-deleted 087; it is
  # local/verify-gate-only (and self-skips without CREATEROLE anyway).
  migration_files="$(find docker/postgres/init -maxdepth 1 -type f -name '*.sql' \
    ! -name '016_restore_constrained_role.sql' | sort | tr '\n' ' ')"
  env PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" \
    PSQL_DOCKER_NETWORK="$net" DATABASE_URL="$LOCAL_DB_URL" \
    MIGRATION_FILES="$migration_files" "$SCRIPT_DIR/migrate-db.sh"
  env PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" \
    PSQL_DOCKER_NETWORK="$net" DATABASE_URL="$LOCAL_DB_URL" \
    "$SCRIPT_DIR/check-db-schema.sh"

  echo "Done. $tier ($project) local database recreated + migrated."
  if [ "$tier" = "demo" ]; then
    echo "Note: re-run 'scripts/deploy.sh demo' to reapply the demo seed."
  fi
  exit 0
fi

# Managed backend: do the conservative, tier-correct drop against the managed
# cluster, then re-migrate. No data move — non-prod data is disposable.
psql_env=(PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-}" ENV_FILE="$env_file")

case "$tier" in
  preview)
    # Per-slug schema: drop it, recreate it, re-migrate into it.
    preview_schema="$(read_env_value "$env_file" PREVIEW_DB_SCHEMA)"
    if [ -z "$preview_schema" ]; then
      echo "ERROR: managed preview reset needs PREVIEW_DB_SCHEMA in $env_file" >&2
      exit 1
    fi
    echo "Managed backend: dropping + recreating preview schema $preview_schema…"
    env "${psql_env[@]}" "$SCRIPT_DIR/drop-preview-schema.sh"
    env "${psql_env[@]}" "$SCRIPT_DIR/ensure-preview-schema.sh"
    ;;
  dev)
    # Delegate to the dev-guarded per-object public-schema reset.
    echo "Managed backend: delegating to reset-dev-db.sh (per-object public drop)…"
    RESET_DEV_DB_CONFIRM=1 env "${psql_env[@]}" "$SCRIPT_DIR/reset-dev-db.sh"
    exit 0
    ;;
  demo)
    echo "Managed backend: managed demo reset is not automated here (no destructive" >&2
    echo "       managed-demo drop exists). Either flip the demo tier to the local" >&2
    echo "       backend (PREVIEW_DB_BACKEND=local) for an instant container reset, or" >&2
    echo "       reset the managed sitelayer_demo schema by hand with operator review." >&2
    exit 1
    ;;
esac

# 016_restore_constrained_role.sql replaced the squash-deleted 087; managed
# tiers can't CREATE ROLE (and the migration self-skips there anyway).
migration_files="$(find docker/postgres/init -maxdepth 1 -type f -name '*.sql' \
  ! -name '016_restore_constrained_role.sql' | sort | tr '\n' ' ')"
env "${psql_env[@]}" MIGRATION_FILES="$migration_files" "$SCRIPT_DIR/migrate-db.sh"
env "${psql_env[@]}" "$SCRIPT_DIR/check-db-schema.sh"
echo "Done. $tier ($project) managed database reset + re-migrated."
