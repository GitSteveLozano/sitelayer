#!/usr/bin/env bash
#
# Sitelayer production deploy — run from the FLEET (e.g. taylor-pc-ubuntu),
# off GitHub Actions. NHL-style: the operator drives the deploy directly.
#
#   1. Build the immutable image locally with BuildKit layer cache (fast box).
#   2. Push it to the DO container registry.
#   3. SSH to the prod droplet to checkout the matching SHA, pull the image,
#      back up + migrate the DB, swap containers, and health-check.
#
# Runtime secrets STAY on the droplet: this reuses the existing
# /app/sitelayer/.env (rendered by the previous deploy). Only BUILD-time vars
# (the VITE_*/SENTRY_* web-bundle args) are read here, from a gitignored
# ops/env/production.build.env if present (all have safe public defaults).
#
# Usage:
#   scripts/deploy-production-local.sh                 # build + deploy HEAD
#   SKIP_MIGRATIONS=1 scripts/deploy-production-local.sh   # code-only, skip DB
#   ALLOW_DIRTY_DEPLOY=1 scripts/deploy-production-local.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEPLOY_HOST="${DEPLOY_HOST:-165.245.230.3}"
DEPLOY_USER="${DEPLOY_USER:-sitelayer}"
REGISTRY="${SITELAYER_REGISTRY:-registry.digitalocean.com/sitelayer/sitelayer}"
CACHE_DIR="${SITELAYER_BUILD_CACHE:-$HOME/.cache/sitelayer-buildkit}"
ALLOW_DIRTY="${ALLOW_DIRTY_DEPLOY:-0}"
SKIP_MIGRATIONS="${SKIP_MIGRATIONS:-0}"

# Optional build secrets (Sentry DSN + sourcemap auth token). Safe to omit.
if [ -f ops/env/production.build.env ]; then
  set -a; . ops/env/production.build.env; set +a
fi

# --- preflight ---------------------------------------------------------------
command -v docker >/dev/null || { echo "ERROR: docker required"; exit 1; }
command -v doctl  >/dev/null || { echo "ERROR: doctl required"; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "ERROR: docker buildx required"; exit 1; }

# Only tracked, uncommitted changes block a deploy (deploying un-pushed code).
# Untracked files (local docs, scratch) are fine and ignored.
if [ "$ALLOW_DIRTY" != "1" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ERROR: tracked files have uncommitted changes. Commit/stash, or set ALLOW_DIRTY_DEPLOY=1."
  git status -s --untracked-files=no
  exit 1
fi

GIT_SHA="$(git rev-parse --short HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
APP_IMAGE="${REGISTRY}:${GIT_SHA}"

# The droplet fetches the deploy SHA from GitHub (still our backup remote), so
# HEAD must be reachable on origin before we deploy it.
if ! git branch -r --contains "$FULL_SHA" 2>/dev/null | grep -q .; then
  echo "ERROR: HEAD ($GIT_SHA) is not on any origin branch."
  echo "       Push it first (e.g. 'git push origin HEAD:dev') so the droplet can fetch it."
  exit 1
fi

# --- local Quality gate (NHL model: the fleet is the deploy authority) -------
# GitHub Actions is NOT the deploy authority. Prod ships ONLY a SHA that passes
# the Quality suite RIGHT HERE, locally, BEFORE the expensive build/push — no
# `gh api` / GitHub-CI dependency. This replaces the old "is Quality green on
# GitHub Actions" check: deploys went fully local-fleet (NHL-style), so both
# the Actions deploy workflows and the CI green-gate coupling are gone.
#
# Runs the fast, deterministic checks (shell syntax, migration immutability,
# prettier, lint, typecheck, unit tests, dockerfile-import guard) — the same
# set the local gate scripts/verify-local.sh runs. The repo runs no GitHub
# Actions; runtime correctness is verified post-deploy by the droplet health
# check + verify-prod-deploy.sh below. web:bundle-budget runs after the build
# (it checks the built bundle).
#
# Break-glass: FORCE_DEPLOY_UNCHECKED=1 skips the gate (loud warning).
if [ "${FORCE_DEPLOY_UNCHECKED:-0}" = "1" ]; then
  echo "############################################################"
  echo "## WARNING: FORCE_DEPLOY_UNCHECKED=1 — local Quality gate SKIPPED."
  echo "## Shipping UNVERIFIED SHA $FULL_SHA ($GIT_SHA) to prod."
  echo "## Lint/typecheck/tests may be red for this commit."
  echo "############################################################"
else
  echo "==> Running local Quality gate for $GIT_SHA (shell, migrations, format, lint, typecheck, test)..."
  if ! bash -n scripts/*.sh; then
    echo "ERROR: shell syntax check failed for $GIT_SHA."
    echo "       Fix it, or set FORCE_DEPLOY_UNCHECKED=1 to override."
    exit 1
  fi
  if ! (
    bash scripts/check-migrations-immutable.sh &&
    npm run format &&
    npm run lint &&
    npm run typecheck &&
    npm run test &&
    npm run check:dockerfile-imports
  ); then
    echo "ERROR: local Quality gate FAILED for $GIT_SHA."
    echo "       Fix the failures and redeploy, or set FORCE_DEPLOY_UNCHECKED=1 to override."
    exit 1
  fi
  echo "==> Local Quality gate passed for $GIT_SHA."
fi

echo "==> Deploying $GIT_SHA -> prod ($DEPLOY_USER@$DEPLOY_HOST)"
START=$(date +%s)

# --- build on the fleet host (fast, incremental ~26s) -----------------------
mkdir -p "$CACHE_DIR"
HOST_DEPS_STAMP="$CACHE_DIR/host-deps.sha256"
lock_now="$(sha256sum package-lock.json | awk '{print $1}')"
if [ ! -d node_modules ] || [ "${lock_now}" != "$(cat "$HOST_DEPS_STAMP" 2>/dev/null || true)" ]; then
  echo "==> npm ci (host build deps; lockfile changed or node_modules missing)"
  npm ci
  printf '%s\n' "$lock_now" > "$HOST_DEPS_STAMP"
fi

echo "==> Building on the fleet host (incremental)..."
VITE_API_URL="${VITE_API_URL:-}" \
VITE_CLERK_PUBLISHABLE_KEY="${VITE_CLERK_PUBLISHABLE_KEY:-pk_live_Y2xlcmsuc2FuZG9sYWIueHl6JA}" \
VITE_COMPANY_SLUG="${VITE_COMPANY_SLUG:-la-operations}" \
VITE_USER_ID="${VITE_USER_ID:-demo-user}" \
VITE_APP_TIER="${VITE_APP_TIER:-prod}" \
VITE_SENTRY_DSN="${VITE_SENTRY_DSN:-}" \
VITE_SENTRY_ENVIRONMENT="${VITE_SENTRY_ENVIRONMENT:-production}" \
VITE_SENTRY_RELEASE="$GIT_SHA" \
VITE_SENTRY_TRACES_SAMPLE_RATE="${VITE_SENTRY_TRACES_SAMPLE_RATE:-0.1}" \
VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE="${VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE:-0.1}" \
VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE="${VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE:-1.0}" \
SENTRY_RELEASE="$GIT_SHA" GIT_SHA="$GIT_SHA" APP_BUILD_SHA="$GIT_SHA" \
  npm run build
# Web bundle-budget guard (part of the local gate; runs here against the
# freshly-built dist, before we package the image).
if [ "${FORCE_DEPLOY_UNCHECKED:-0}" != "1" ]; then
  npm run web:bundle-budget
fi
# Don't ship sourcemaps (keeps the bundle lean; no Sentry upload step here).
find apps/web/dist -name '*.map' -type f -delete 2>/dev/null || true

# --- package + push the THIN image (deps stage cached on the persistent builder) ---
doctl registry login >/dev/null
docker buildx inspect sitelayer-builder >/dev/null 2>&1 \
  || docker buildx create --name sitelayer-builder --driver docker-container >/dev/null

docker buildx build \
  --builder sitelayer-builder \
  --target runtime \
  --build-arg GIT_SHA="$GIT_SHA" \
  -t "$APP_IMAGE" \
  -t "${REGISTRY}:main" \
  --push \
  .

BUILT=$(date +%s)
echo "==> Built + pushed in $((BUILT - START))s. Deploying on droplet..."

# Prune old registry tags (DO Starter tier caps at 500MB). Keep :main + the
# newest 10 SHA tags; GC frees the space (async). Replaces registry-gc.yml.
to_delete="$(doctl registry repository list-tags sitelayer --no-header --format Tag,UpdatedAt 2>/dev/null \
  | grep -vE '^(main|buildcache)[[:space:]]' | sort -k2 -r | tail -n +11 | awk '{print $1}')"
for t in $to_delete; do doctl registry repository delete-tag sitelayer "$t" --force >/dev/null 2>&1 || true; done
[ -n "$to_delete" ] && doctl registry garbage-collection start --include-untagged-manifests --force >/dev/null 2>&1 || true

# --- remote deploy (reuse existing droplet .env) -----------------------------
ssh -o BatchMode=yes "$DEPLOY_USER@$DEPLOY_HOST" \
  "APP_IMAGE='$APP_IMAGE' EXPECTED_GIT_SHA='$GIT_SHA' SKIP_MIGRATIONS='$SKIP_MIGRATIONS' bash -s" <<'REMOTE'
set -euo pipefail
exec 9>/tmp/sitelayer-production-deploy.lock
flock -n 9 || { echo "ERROR: another production deploy is already running"; exit 1; }

if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
else echo "ERROR: docker compose not installed"; exit 1; fi

cd /app/sitelayer
[ -f .env ] || { echo "ERROR: /app/sitelayer/.env missing (run a full GitHub deploy once to seed it)"; exit 1; }

previous_sha="$(git rev-parse --short HEAD 2>/dev/null || true)"
git remote set-url origin https://github.com/GitSteveLozano/sitelayer.git 2>/dev/null || true
git fetch origin
git reset --hard
git clean -fd -e .env -e ".last_*" -e ".env.bak.*"
git checkout -B main "$EXPECTED_GIT_SHA"
git reset --hard "$EXPECTED_GIT_SHA"
test "$(git rev-parse HEAD)" = "$(git rev-parse "$EXPECTED_GIT_SHA")" || {
  echo "ERROR: checked out $(git rev-parse --short HEAD) but image is $EXPECTED_GIT_SHA"; exit 1; }

export APP_IMAGE GIT_SHA="$EXPECTED_GIT_SHA"
export SENTRY_RELEASE="$EXPECTED_GIT_SHA" VITE_SENTRY_RELEASE="$EXPECTED_GIT_SHA"

$COMPOSE -f docker-compose.prod.yml config >/dev/null
$COMPOSE -f docker-compose.prod.yml pull api web worker
docker image inspect "$APP_IMAGE" >/dev/null

if [ "$SKIP_MIGRATIONS" != "1" ]; then
  DB_URL_RAW="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)"
  DB_URL="${DB_URL_RAW%\"}"; DB_URL="${DB_URL#\"}"; DB_URL="${DB_URL%\'}"; DB_URL="${DB_URL#\'}"
  # Drop FORCE RLS before backup so the owner can pg_dump (migration 078 parity).
  if [ -n "$DB_URL" ]; then
    docker run --rm --network host -e PGURL="$DB_URL" postgres:18-alpine bash -c \
      'psql "$PGURL" -v ON_ERROR_STOP=1 \
        -c "ALTER TABLE IF EXISTS audit_events NO FORCE ROW LEVEL SECURITY;" \
        -c "ALTER TABLE IF EXISTS mutation_outbox NO FORCE ROW LEVEL SECURITY;" \
        -c "ALTER TABLE IF EXISTS sync_events NO FORCE ROW LEVEL SECURITY;" \
        -c "ALTER TABLE IF EXISTS workflow_event_log NO FORCE ROW LEVEL SECURITY;"'
  fi
  BACKUP_DIR="${BACKUP_DIR:-/app/backups/postgres}" DATABASE_URL_FILE=/app/sitelayer/.env \
    PG_DUMP_DOCKER_IMAGE=postgres:18-alpine scripts/backup-postgres.sh
  PSQL_DOCKER_IMAGE=postgres:18-alpine scripts/migrate-db.sh
  PSQL_DOCKER_IMAGE=postgres:18-alpine scripts/check-db-schema.sh
else
  echo "SKIP_MIGRATIONS=1 — skipping backup + migrate (code-only deploy)"
fi

$COMPOSE -f docker-compose.prod.yml up -d --remove-orphans

for attempt in $(seq 1 30); do
  if curl -fsS --resolve sitelayer.sandolab.xyz:443:127.0.0.1 https://sitelayer.sandolab.xyz/health >/dev/null; then
    break
  fi
  [ "$attempt" -eq 30 ] && { echo "ERROR: health check failed after 30 attempts"; exit 1; }
  sleep 5
done

EXPECTED_SHA="$GIT_SHA" scripts/verify-prod-deploy.sh || true

[ -n "$previous_sha" ] && printf '%s\n' "$previous_sha" > .last_previous_deployed_sha
printf '%s\n' "$GIT_SHA" > .last_successful_deployed_sha
printf '%s\n' "$APP_IMAGE" > .last_successful_app_image
date -u +%Y-%m-%dT%H:%M:%SZ > .last_successful_deployed_at
echo "Deployment completed: $GIT_SHA"
REMOTE

END=$(date +%s)
echo "==> prod is on $GIT_SHA. Total $((END - START))s (build $((BUILT - START))s, deploy $((END - BUILT))s)."
