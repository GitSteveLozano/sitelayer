#!/usr/bin/env bash
#
# Sitelayer unified deploy — run from the FLEET, off GitHub Actions.
#
#   scripts/deploy.sh prod         # build image on fleet + ship to prod droplet
#   scripts/deploy.sh dev          # watch-mode dev stack on the preview droplet
#   scripts/deploy.sh demo         # watch-mode demo stack + idempotent demo seed
#
# prod  -> delegates to scripts/deploy-production-local.sh (cached image build,
#          push to registry, SSH deploy with backup+migrate+health).
# dev   -> dev.sitelayer.sandolab.xyz       (PREVIEW_TIER=dev)
# demo  -> demo.preview.sitelayer.sandolab.xyz (PREVIEW_TIER=demo, seeded)
#
# dev/demo use source-mounted watch-mode (tsx + vite HMR): NO image build,
# the source is git-checked-out on the preview droplet and rsynced into the
# stack — changes propagate in seconds. Runtime env stays on the droplet
# (/app/previews/.env.{dev,demo}.shared).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TIER="${1:-}"
case "$TIER" in
  prod) exec bash scripts/deploy-production-local.sh "${@:2}" ;;
  dev|demo) ;;
  *) echo "usage: scripts/deploy.sh <prod|dev|demo>"; exit 1 ;;
esac

PREVIEW_BOX="${PREVIEW_BOX:-159.203.53.218}"
PREVIEW_USER="${PREVIEW_USER:-sitelayer}"
ALLOW_DIRTY="${ALLOW_DIRTY_DEPLOY:-0}"

if [ "$ALLOW_DIRTY" != "1" ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "ERROR: tracked files have uncommitted changes (set ALLOW_DIRTY_DEPLOY=1 to override)."
  git status -s --untracked-files=no
  exit 1
fi

GIT_SHA="$(git rev-parse --short HEAD)"
FULL_SHA="$(git rev-parse HEAD)"
if ! git branch -r --contains "$FULL_SHA" 2>/dev/null | grep -q .; then
  echo "ERROR: HEAD ($GIT_SHA) is not on any origin branch — push it first (e.g. git push origin HEAD:$TIER)."
  exit 1
fi

if [ "$TIER" = dev ]; then
  SLUG=dev;  HOST=dev.sitelayer.sandolab.xyz;          SHARED=/app/previews/.env.dev.shared
else
  SLUG=demo; HOST=demo.preview.sitelayer.sandolab.xyz; SHARED=/app/previews/.env.demo.shared
fi

# --- local verification gate (NHL model: the fleet is the deploy authority) --
# Every deploy runs scripts/verify-local.sh on the SHA being deployed BEFORE
# we ship it — the same single gate that scripts/deploy-production-local.sh
# (prod, "standard" = static+build+unit+integration) uses. dev/demo default to
# VERIFY_LEVEL=fast (static+build+unit) so watch-mode iteration stays quick; set
# VERIFY_LEVEL=standard to add the DB-backed integration suite, or
# VERIFY_LEVEL=full to also run the (resource-heavy) e2e suite. Break-glass:
# SKIP_VERIFY=1 (loud warning).
if [ "${SKIP_VERIFY:-0}" = "1" ]; then
  echo "############################################################"
  echo "## WARNING: SKIP_VERIFY=1 — local verification gate SKIPPED."
  echo "## Shipping UNVERIFIED SHA $GIT_SHA to $TIER ($HOST)."
  echo "############################################################"
else
  DEPLOY_VERIFY_LEVEL="${VERIFY_LEVEL:-fast}"
  echo "==> Running local verification gate for $GIT_SHA (level=$DEPLOY_VERIFY_LEVEL) before $TIER deploy..."
  if ! VERIFY_LEVEL="$DEPLOY_VERIFY_LEVEL" bash scripts/verify-local.sh; then
    echo "ERROR: local verification gate FAILED for $GIT_SHA — not deploying $TIER."
    echo "       Fix the failures and redeploy, or set SKIP_VERIFY=1 to override."
    exit 1
  fi
  echo "==> Local verification gate passed for $GIT_SHA."
fi

echo "==> Deploying $GIT_SHA -> $TIER ($HOST) via preview droplet $PREVIEW_BOX"
START=$(date +%s)

ssh -o BatchMode=yes "$PREVIEW_USER@$PREVIEW_BOX" \
  "DEPLOY_SHA='$GIT_SHA' SLUG='$SLUG' HOST='$HOST' TIER='$TIER' SHARED='$SHARED' bash -s" <<'REMOTE'
set -euo pipefail
SRC="$HOME/sitelayer-deploy-src"
if [ ! -d "$SRC/.git" ]; then
  git clone https://github.com/GitSteveLozano/sitelayer.git "$SRC"
fi
cd "$SRC"
git remote set-url origin https://github.com/GitSteveLozano/sitelayer.git
git fetch origin
git reset --hard
git clean -fd
git checkout -B "${TIER}-deploy" "$DEPLOY_SHA"
git reset --hard "$DEPLOY_SHA"

PREVIEW_SLUG="$SLUG" PREVIEW_HOST="$HOST" PREVIEW_TIER="$TIER" \
  PREVIEW_SHARED_ENV="$SHARED" PREVIEW_MODE=dev PREVIEW_ENABLE_WORKER=1 \
  PREVIEW_DEPLOY_SKIP_REAP=1 NOTIFICATIONS_ENABLED=0 PREVIEW_SOURCE_DIR="$SRC" \
  bash scripts/deploy-preview.sh

# Demo seed (idempotent ON CONFLICT DO NOTHING — safe every deploy).
if [ "$TIER" = demo ]; then
  TARGET=/app/previews/demo
  [ -f "$TARGET/.env" ] || { echo "ERROR: $TARGET/.env missing — cannot seed"; exit 1; }
  cd "$TARGET"
  grep -q '^DATABASE_URL=' .env || { echo "ERROR: DATABASE_URL missing in $TARGET/.env"; exit 1; }
  migration_files="$(find docker/postgres/init -maxdepth 1 -type f -name '*.sql' \
    ! -name '087_constrained_role_for_rls_probe.sql' | sort | tr '\n' ' ')"
  env PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$TARGET/.env" \
    MIGRATION_FILES="$migration_files" scripts/migrate-db.sh
  env PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}" ENV_FILE="$TARGET/.env" \
    scripts/check-db-schema.sh
  docker compose --env-file .env -f docker-compose.preview.yml -p sitelayer-demo run --rm --no-deps api \
    sh -lc 'npm install --no-audit --no-fund --prefer-offline && npm run seed:demo'
fi
REMOTE

END=$(date +%s)
echo "==> $TIER on $GIT_SHA in $((END - START))s — https://$HOST"
HOME="${HOME:-/home/taylorsando}" curl -s -o /dev/null -w "version http %{http_code}\n" --max-time 15 "https://$HOST/api/version" || true
