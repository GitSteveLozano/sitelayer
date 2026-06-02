#!/usr/bin/env bash
set -euo pipefail

# Deploys a preview stack.
#
# PREVIEW_MODE defaults to `dev` — a source-mounted, watch-mode stack that iterates
# in seconds. Subsequent commits to the same PR only rsync source; tsx + vite HMR
# pick the change up without rebuilding.
#
# PREVIEW_MODE=prod runs a full prod-bundle build via docker-compose.preview-prod.yml.
# Use this for a final pre-merge smoke test (slower; full `npm ci`, tsc, vite build).

PREVIEW_ROOT="${PREVIEW_ROOT:-/app/previews}"
SOURCE_DIR="${PREVIEW_SOURCE_DIR:-$(pwd)}"
SHARED_ENV="${PREVIEW_SHARED_ENV:-$PREVIEW_ROOT/.env.shared}"
PREVIEW_DOMAIN="${PREVIEW_DOMAIN:-preview.sitelayer.sandolab.xyz}"
PREVIEW_ENABLE_WORKER="${PREVIEW_ENABLE_WORKER:-0}"
PREVIEW_MODE="${PREVIEW_MODE:-dev}"
# PREVIEW_TIER selects the deployment shape:
#   preview (default) — per-PR stack with an isolated `sitelayer_<slug>` schema
#                       inside the shared sitelayer_preview database.
#   dev               — long-running named stack against a dedicated database
#                       (sitelayer_dev). No schema-per-slug; migrations land in
#                       `public`. Used by .github/workflows/deploy-dev.yml.
#   demo              — long-running named stack against a dedicated database
#                       (sitelayer_demo). Same shape as `dev` (public schema,
#                       no schema-per-slug). Used by
#                       .github/workflows/deploy-demo.yml.
PREVIEW_TIER="${PREVIEW_TIER:-preview}"

# PREVIEW_DB_BACKEND selects where the stack's Postgres lives:
#   managed — the DigitalOcean managed cluster (today's behavior). DATABASE_URL
#             comes from the shared env file; the `preview` tier isolates a
#             per-slug schema inside the shared sitelayer_preview database.
#   local   — a Postgres CONTAINER on the preview droplet (docker-compose.preview-db.yml).
#             DATABASE_URL is rewritten to point at it; migrations + (demo) reseed
#             run against the container. Non-prod data is disposable, so a
#             cutover is just point + migrate + reseed (no data move).
#
# Default is TIER-AWARE and conservative:
#   * preview         → local   (per-PR stacks are already ephemeral, so an
#                                throwaway per-stack container removes per-slug
#                                schema accumulation under heavy PR churn).
#   * dev / demo      → managed  (NO auto-cutover; the operator flips
#                                PREVIEW_DB_BACKEND=local deliberately after
#                                verifying). A managed fallback also stays
#                                available for preview as a safety valve.
#
# Resolution precedence: explicit env var > value persisted in the shared env
# file > tier default. The shared-env tier is what makes the documented durable
# per-tier cutover work (docs/PREVIEW_DEPLOYMENTS.md): neither the manual
# `scripts/deploy.sh dev|demo` path nor the fleet auto-deploy watcher passes
# PREVIEW_DB_BACKEND through to this script, so persisting it in
# /app/previews/.env.{dev,demo}.shared is the ONLY durable way to keep dev/demo
# on the local backend across redeploys.
if [ -z "${PREVIEW_DB_BACKEND:-}" ] && [ -f "$SHARED_ENV" ]; then
  shared_db_backend="$(sed -nE 's/^PREVIEW_DB_BACKEND=([A-Za-z]+).*$/\1/p' "$SHARED_ENV" | tail -n1)"
  if [ -n "$shared_db_backend" ]; then
    PREVIEW_DB_BACKEND="$shared_db_backend"
  fi
fi
if [ -z "${PREVIEW_DB_BACKEND:-}" ]; then
  if [ "$PREVIEW_TIER" = "preview" ]; then
    PREVIEW_DB_BACKEND="local"
  else
    PREVIEW_DB_BACKEND="managed"
  fi
fi

append_optional_env() {
  local name="$1"
  local value="${!name:-}"
  [ -n "$value" ] || return 0
  printf '%s=%s\n' "$name" "$value"
}

case "$PREVIEW_TIER" in
  preview|dev|demo) ;;
  *)
    echo "ERROR: PREVIEW_TIER must be 'preview', 'dev', or 'demo' (got '$PREVIEW_TIER')" >&2
    exit 1
    ;;
esac

case "$PREVIEW_MODE" in
  dev)  compose_file="docker-compose.preview.yml"      ;;
  prod) compose_file="docker-compose.preview-prod.yml" ;;
  *)
    echo "ERROR: PREVIEW_MODE must be 'dev' or 'prod' (got '$PREVIEW_MODE')" >&2
    exit 1
    ;;
esac

case "$PREVIEW_DB_BACKEND" in
  managed|local) ;;
  *)
    echo "ERROR: PREVIEW_DB_BACKEND must be 'managed' or 'local' (got '$PREVIEW_DB_BACKEND')" >&2
    exit 1
    ;;
esac

# Local-backend connection facts. The db service (docker-compose.preview-db.yml)
# is named `preview-db` and listens on the project's `app` network. The container
# has no TLS, so the URL carries no sslmode.
LOCAL_DB_SERVICE="preview-db"
LOCAL_DB_URL="postgres://sitelayer:sitelayer@${LOCAL_DB_SERVICE}:5432/sitelayer"
local_db_compose="docker-compose.preview-db.yml"

raw_slug="${PREVIEW_SLUG:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-manual}}}"
preview_slug="$(printf '%s' "$raw_slug" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
if [ -z "$preview_slug" ]; then
  echo "ERROR: preview slug resolved to empty value" >&2
  exit 1
fi

preview_host="${PREVIEW_HOST:-$preview_slug.$PREVIEW_DOMAIN}"
project_name="sitelayer-${preview_slug}"
target_dir="$PREVIEW_ROOT/$preview_slug"

# Per-slug schema isolation only applies to the managed-backend `preview` tier.
# The `dev` tier targets a dedicated database (sitelayer_dev) and uses its public
# schema; the LOCAL backend gives every stack its own database container, so it
# uses `public` too. In both of those cases we skip schema-name derivation and
# the schema-create step.
if [ "$PREVIEW_TIER" = "preview" ] && [ "$PREVIEW_DB_BACKEND" = "managed" ]; then
  schema_slug="$(printf '%s' "$preview_slug" | tr '-' '_' | sed -E 's/[^a-z0-9_]+/_/g; s/^_+//; s/_+$//; s/_+/_/g')"
  preview_db_schema="${PREVIEW_DB_SCHEMA:-sitelayer_${schema_slug}}"
  if [[ ! "$preview_db_schema" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "ERROR: invalid preview database schema: $preview_db_schema" >&2
    exit 1
  fi
fi

if [ ! -f "$SOURCE_DIR/$compose_file" ]; then
  echo "ERROR: $compose_file not found in $SOURCE_DIR" >&2
  exit 1
fi

if [ ! -f "$SHARED_ENV" ]; then
  echo "ERROR: shared preview env missing at $SHARED_ENV" >&2
  exit 1
fi

# Pre-flight orphan reap. The preview droplet has 4GB of RAM; left unchecked,
# closed-PR stacks accumulate. Before provisioning a new stack, tear down any
# `sitelayer-pr-*` project whose corresponding PR is no longer open (we query
# GitHub via `gh pr list` only as the PR host, to learn which PRs are still
# open — not as a deploy trigger). Best-effort: never block the deploy on reap
# failures — the daily systemd prune timer (installed by
# scripts/install-preview-prune-systemd.sh) is the durable backstop.
if [ "${PREVIEW_DEPLOY_SKIP_REAP:-0}" != "1" ]; then
  open_prs_csv="${PREVIEW_OPEN_PRS:-}"
  if [ -z "$open_prs_csv" ] && command -v gh >/dev/null 2>&1; then
    open_prs_csv="$(gh pr list --state open --limit 500 --json number \
      --jq 'map(.number) | join(",")' 2>/dev/null || true)"
  fi

  if [ -z "$open_prs_csv" ]; then
    echo "Pre-flight reap: skipped (no open-PR list available; daily GC will catch this)"
  else
    open_list="$(printf '%s\n' "$open_prs_csv" | tr ',' '\n' | awk 'NF')"
    # Enumerate compose projects via container labels — invariant across the
    # `docker compose ls` schema churn between Compose v2 minor releases.
    mapfile -t reap_projects < <(
      docker ps -a --format '{{.Label "com.docker.compose.project"}}' \
        | awk 'NF' \
        | grep -E '^sitelayer-pr-[0-9]+$' \
        | sort -u
    )

    for stale in "${reap_projects[@]}"; do
      stale_pr="${stale#sitelayer-pr-}"
      [[ "$stale_pr" =~ ^[0-9]+$ ]] || continue
      # Never reap the stack we're about to redeploy.
      [ "$stale" = "$project_name" ] && continue
      if printf '%s\n' "$open_list" | grep -Fxq "$stale_pr"; then
        continue
      fi
      echo "Pre-flight reap: stale stack $stale (PR #$stale_pr is closed)"
      stale_dir="$PREVIEW_ROOT/pr-$stale_pr"
      stale_compose=""
      for candidate in docker-compose.preview.yml docker-compose.preview-prod.yml; do
        if [ -f "$stale_dir/$candidate" ]; then
          stale_compose="$candidate"
          break
        fi
      done
      # Local-backend stacks layer docker-compose.preview-db.yml; include it so
      # the per-stack Postgres volume (preview_db_data) is dropped by `down -v`.
      stale_db_args=()
      if [ -f "$stale_dir/.env" ] && grep -qE '^PREVIEW_DB_BACKEND=local$' "$stale_dir/.env" \
        && [ -f "$stale_dir/docker-compose.preview-db.yml" ]; then
        stale_db_args=(-f docker-compose.preview-db.yml)
      fi
      if [ -n "$stale_compose" ]; then
        env_args=()
        [ -f "$stale_dir/.env" ] && env_args=(--env-file "$stale_dir/.env")
        ( cd "$stale_dir" && \
          docker compose "${env_args[@]}" -f "$stale_compose" "${stale_db_args[@]}" -p "$stale" \
            down -v --remove-orphans \
        ) || echo "WARN: pre-flight reap failed for $stale (continuing deploy)"
      else
        docker compose -p "$stale" down -v --remove-orphans \
          || echo "WARN: pre-flight reap (project-only) failed for $stale (continuing deploy)"
      fi
    done
  fi
fi

mkdir -p "$target_dir"

t_start=$(date +%s)

rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'coverage/' \
  --exclude 'storage/' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude '.vite-cache/' \
  --exclude '.vite/' \
  "$SOURCE_DIR/" "$target_dir/"

{
  cat "$SHARED_ENV"
  printf '\n'
  printf 'PREVIEW_SLUG=%s\n' "$preview_slug"
  printf 'PREVIEW_HOST=%s\n' "$preview_host"
  printf 'PREVIEW_MODE=%s\n' "$PREVIEW_MODE"
  printf 'PREVIEW_DB_BACKEND=%s\n' "$PREVIEW_DB_BACKEND"
  if [ "$PREVIEW_DB_BACKEND" = "local" ]; then
    # Local backend: the app talks to the per-stack Postgres container instead
    # of the managed cluster. This DATABASE_URL line comes AFTER the shared env
    # (which may carry a managed URL), so it wins. No sslmode (no TLS on the
    # container); the search_path stays at the default `public`.
    printf 'DATABASE_URL=%s\n' "$LOCAL_DB_URL"
  elif [ "$PREVIEW_TIER" = "preview" ]; then
    printf 'PREVIEW_DB_SCHEMA=%s\n' "$preview_db_schema"
    printf 'DB_SCHEMA=%s\n' "$preview_db_schema"
    printf 'PGOPTIONS=-c search_path=%s,public\n' "$preview_db_schema"
  fi
  printf 'PREVIEW_IMAGE_TAG=%s\n' "${PREVIEW_IMAGE_TAG:-$preview_slug}"
  build_sha="$(git -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || printf '%s' "$preview_slug")"
  release_sha="${SENTRY_RELEASE:-$build_sha}"
  printf 'SITELAYER_BUILD_SHA=%s\n' "${SITELAYER_BUILD_SHA:-$build_sha}"
  printf 'APP_BUILD_SHA=%s\n' "${APP_BUILD_SHA:-$build_sha}"
  printf 'SENTRY_RELEASE=%s\n' "$release_sha"
  printf 'VITE_SENTRY_RELEASE=%s\n' "${VITE_SENTRY_RELEASE:-$release_sha}"
  printf 'ALLOWED_ORIGINS=https://%s\n' "$preview_host"
  printf 'QBO_REDIRECT_URI=https://%s/api/integrations/qbo/callback\n' "$preview_host"
  printf 'QBO_SUCCESS_REDIRECT_URI=https://%s/?qbo=connected\n' "$preview_host"
  printf 'VITE_API_URL=https://%s\n' "$preview_host"
  printf 'VITE_SENTRY_ENVIRONMENT=%s\n' "$PREVIEW_TIER"
  printf 'SITELAYER_PUBLIC_BASE=https://%s\n' "$preview_host"
  if [ "$PREVIEW_TIER" = "demo" ]; then
    printf 'DEMO_APP_ORIGIN=https://%s\n' "$preview_host"
  fi
  append_optional_env NOTIFICATIONS_ENABLED
  append_optional_env MESH_WORK_REQUEST_DISPATCH_URL
  append_optional_env MESH_WORK_REQUEST_DISPATCH_TOKEN
  printf 'WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS=%s\n' "${WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS:-72}"
  printf 'WORK_REQUEST_REVIEW_STALE_HOURS=%s\n' "${WORK_REQUEST_REVIEW_STALE_HOURS:-48}"
  printf 'WORK_REQUEST_AGENT_STALE_HOURS=%s\n' "${WORK_REQUEST_AGENT_STALE_HOURS:-24}"
  printf 'WORK_REQUEST_STALE_SWEEP_INTERVAL_MS=%s\n' "${WORK_REQUEST_STALE_SWEEP_INTERVAL_MS:-300000}"
  printf 'WORK_REQUEST_STALE_SWEEP_LIMIT=%s\n' "${WORK_REQUEST_STALE_SWEEP_LIMIT:-25}"
} >"$target_dir/.env"
chmod 600 "$target_dir/.env"

if [ "$(id -u)" -eq 0 ] && id sitelayer >/dev/null 2>&1; then
  chown -R sitelayer:sitelayer "$target_dir"
fi

cd "$target_dir"

compose_args=(--env-file .env -f "$compose_file")
if [ "$PREVIEW_DB_BACKEND" = "local" ]; then
  # Layer the per-stack Postgres container onto the stack. The named volume is
  # project-namespaced, so `docker compose down -v` (cleanup/reap) destroys it
  # with the stack — no per-slug-schema accumulation on the managed cluster.
  compose_args+=(-f "$local_db_compose")
fi
compose_args+=(-p "$project_name")
profile_args=()
services=(api web)
if [ "$PREVIEW_ENABLE_WORKER" = "1" ]; then
  profile_args=(--profile worker)
  services=(api web worker)
fi

preview_migration_files() {
  local skip_role_migration="${PREVIEW_SKIP_CONSTRAINED_ROLE_MIGRATION:-1}"
  local find_args=(-maxdepth 1 -type f -name '*.sql')

  # The constrained-role migration is local/CI-only in practice. Preview
  # deploys run as the managed-DB app role, which cannot CREATE ROLE, and
  # the preview app does not need the RLS runtime probe login role.
  if [ "$skip_role_migration" = "1" ]; then
    find_args+=(! -name '087_constrained_role_for_rls_probe.sql')
  fi

  find docker/postgres/init "${find_args[@]}" | sort | tr '\n' ' '
}

# Local backend: bring the per-stack Postgres container up BEFORE migrations so
# migrate-db.sh can reach it over the project's `app` network. (Managed backend
# connects straight to the cluster, so there is nothing to start here.)
local_db_network=""
if [ "$PREVIEW_DB_BACKEND" = "local" ]; then
  local_db_network="${project_name}_app"
  echo "Local DB backend: starting $LOCAL_DB_SERVICE container"
  docker compose "${compose_args[@]}" up -d "$LOCAL_DB_SERVICE"

  # Wait for the container to report healthy (its compose healthcheck runs
  # pg_isready). The named volume persists for dev/demo, so on a redeploy this
  # returns almost immediately.
  db_deadline=$(( $(date +%s) + 60 ))
  db_cid=""
  while :; do
    db_cid="$(docker compose "${compose_args[@]}" ps -q "$LOCAL_DB_SERVICE" 2>/dev/null || true)"
    if [ -n "$db_cid" ]; then
      db_state="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$db_cid" 2>/dev/null || true)"
      case "$db_state" in
        healthy|running) break ;;
      esac
    fi
    if [ "$(date +%s)" -ge "$db_deadline" ]; then
      echo "ERROR: $LOCAL_DB_SERVICE container did not become healthy within 60s" >&2
      if [ -n "$db_cid" ]; then
        docker logs --tail=50 "$db_cid" >&2 || true
      fi
      exit 1
    fi
    sleep 1
  done
fi

# Apply migrations on a fresh schema. If the SHA hasn't moved since last deploy,
# skip — the schema is already current.
current_sha="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || printf '')"
migrations_marker="$target_dir/.migrations-applied-sha"
if [ -n "$current_sha" ] && [ -f "$migrations_marker" ] && [ "$(cat "$migrations_marker")" = "$current_sha" ]; then
  echo "Migrations already applied for $current_sha — skipping"
else
  psql_env=(PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$target_dir/.env")
  if [ "$PREVIEW_DB_BACKEND" = "local" ]; then
    # Reach the container over the project network with the rewritten URL; the
    # .env already carries that DATABASE_URL, but PSQL_DOCKER_NETWORK must be set
    # so the psql runner joins the same network as `preview-db`.
    psql_env+=(PSQL_DOCKER_NETWORK="$local_db_network" DATABASE_URL="$LOCAL_DB_URL")
  fi
  if [ "$PREVIEW_TIER" = "preview" ] && [ "$PREVIEW_DB_BACKEND" = "managed" ]; then
    env "${psql_env[@]}" "$target_dir/scripts/ensure-preview-schema.sh"
  fi
  env "${psql_env[@]}" MIGRATION_FILES="$(preview_migration_files)" "$target_dir/scripts/migrate-db.sh"
  env "${psql_env[@]}" "$target_dir/scripts/check-db-schema.sh"
  [ -n "$current_sha" ] && printf '%s' "$current_sha" >"$migrations_marker"
fi

docker compose "${compose_args[@]}" config >/dev/null

if [ "$PREVIEW_MODE" = "prod" ]; then
  docker compose "${compose_args[@]}" "${profile_args[@]}" up -d --build --remove-orphans "${services[@]}"
else
  # Install workspace dependencies once before services start. Running npm
  # install concurrently from api/web/worker against the shared node_modules
  # volume creates noisy tar ENOENT warnings and can leave a partial install.
  docker compose "${compose_args[@]}" run --rm --no-deps api \
    npm install --no-audit --no-fund --prefer-offline

  # Dev-mode: no --build (images are node:20-alpine pulled once). Containers stay up
  # across deploys; rsync + tsx watch + vite HMR propagate changes in seconds.
  docker compose "${compose_args[@]}" "${profile_args[@]}" up -d --remove-orphans "${services[@]}"
fi

# Fast health-check poll. Tight loop for first ~30s, then back off.
deadline=$(( $(date +%s) + 120 ))
while :; do
  if curl -fsS --max-time 5 "https://$preview_host/health" >/dev/null 2>&1 &&
    curl -fsSI --max-time 5 "https://$preview_host/" >/dev/null 2>&1; then
    date -u +%Y-%m-%dT%H:%M:%SZ >"$target_dir/.last_deployed_at"
    elapsed=$(( $(date +%s) - t_start ))
    echo "Preview ready: https://$preview_host (mode=$PREVIEW_MODE, ${elapsed}s)"
    exit 0
  fi
  now=$(date +%s)
  [ "$now" -ge "$deadline" ] && break
  remaining=$(( deadline - now ))
  # 1s poll for the first 30s, 3s after.
  if [ $(( deadline - now )) -gt 90 ]; then
    sleep 1
  else
    sleep 3
  fi
done

echo "ERROR: preview did not pass health check within 120s: https://$preview_host/health" >&2
docker compose "${compose_args[@]}" logs --tail=120 api web >&2
exit 1
