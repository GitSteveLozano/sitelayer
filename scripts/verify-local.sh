#!/usr/bin/env bash
#
# Sitelayer local verification gate — the single, comprehensive quality
# authority that REPLACES .github/workflows/quality.yml.
#
# This script is the one place the full pre-deploy suite is defined. It runs
# the same stages the GitHub Actions Quality workflow ran (static analysis,
# build, unit tests, the Postgres-backed integration suite, and the
# Playwright e2e suite over the docker-compose app stack), with identical
# env (RATE_LIMIT_*=100000 for e2e, the act-as fixtures, etc.). Both
# scripts/deploy.sh and scripts/deploy-production-local.sh call THIS — so
# there is exactly one gate definition, run by the deploy path and the
# fleet auto-deploy watcher.
#
# Usage:
#   scripts/verify-local.sh                 # default: run EVERYTHING
#   scripts/verify-local.sh --fast          # static + build + unit only
#   scripts/verify-local.sh --full          # force ALL stages (default)
#   scripts/verify-local.sh --skip-e2e      # everything except e2e
#   scripts/verify-local.sh --skip-integration
#   scripts/verify-local.sh --keep-going    # run all stages, don't fail-fast
#
# Levels (also via VERIFY_LEVEL env; flag wins over env):
#   fast  -> static, build, unit                  (quick iteration)
#   full  -> static, build, unit, integration, e2e (default; the merge gate)
#
# Escapes (env or flag; LOUD when used):
#   --skip-e2e          / VERIFY_SKIP_E2E=1
#   --skip-integration  / VERIFY_SKIP_INTEGRATION=1
#
# Everything below is env-overridable so the gate is testable in isolation.
# Exit code is non-zero if any REQUIRED stage fails.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---- Configuration (all overridable) ---------------------------------------
VERIFY_LEVEL="${VERIFY_LEVEL:-full}"
KEEP_GOING="${VERIFY_KEEP_GOING:-0}"
SKIP_E2E="${VERIFY_SKIP_E2E:-0}"
SKIP_INTEGRATION="${VERIFY_SKIP_INTEGRATION:-0}"

# Distinct, high project name + ports so two runs (or a live local stack)
# never collide. PID-suffixed by default; overridable for determinism.
VERIFY_PROJECT="${VERIFY_PROJECT:-sitelayer-verify-$$}"
# Isolated postgres for the integration suite. The api integration tests
# hardcode postgres://sitelayer:sitelayer@localhost:5432/sitelayer, so the
# container must publish on this host port (default 5432). Override to run
# alongside a host postgres already on 5432.
VERIFY_PG_PORT="${VERIFY_PG_PORT:-5432}"
VERIFY_PG_IMAGE="${VERIFY_PG_IMAGE:-postgres:18-alpine}"
# e2e app-stack host ports (web/api). Non-conflicting with the local dev
# stack defaults (3000/3001) by default the e2e suite uses 3100/3001 in CI;
# we keep 3001 for api (the integration tests + specs assume it) and 3100
# for web, but allow override to dodge contention.
VERIFY_E2E_WEB_PORT="${VERIFY_E2E_WEB_PORT:-3100}"
VERIFY_E2E_API_PORT="${VERIFY_E2E_API_PORT:-3001}"

# Lockfile so two concurrent runs don't collide on ports / docker projects.
VERIFY_LOCK_FILE="${VERIFY_LOCK_FILE:-/tmp/sitelayer-verify.lock}"

DOCKER="${DOCKER_BIN:-docker}"

# ---- Argument parsing -------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --fast) VERIFY_LEVEL="fast" ;;
    --full) VERIFY_LEVEL="full" ;;
    --skip-e2e) SKIP_E2E="1" ;;
    --skip-integration) SKIP_INTEGRATION="1" ;;
    --keep-going) KEEP_GOING="1" ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "verify-local: unknown argument: $arg" >&2
      echo "  see: scripts/verify-local.sh --help" >&2
      exit 2
      ;;
  esac
done

# ---- Logging ----------------------------------------------------------------
_C_RESET=""; _C_RED=""; _C_GRN=""; _C_YEL=""; _C_BLU=""
if [ -t 1 ] && [ "${VERIFY_NO_COLOR:-0}" != "1" ]; then
  _C_RESET="$(printf '\033[0m')"; _C_RED="$(printf '\033[31m')"
  _C_GRN="$(printf '\033[32m')"; _C_YEL="$(printf '\033[33m')"
  _C_BLU="$(printf '\033[34m')"
fi

log() { printf '%s[verify]%s %s\n' "$_C_BLU" "$_C_RESET" "$*"; }
warn() { printf '%s[verify WARN]%s %s\n' "$_C_YEL" "$_C_RESET" "$*" >&2; }
loud() {
  printf '%s############################################################%s\n' "$_C_YEL" "$_C_RESET" >&2
  while [ "$#" -gt 0 ]; do printf '%s## %s%s\n' "$_C_YEL" "$1" "$_C_RESET" >&2; shift; done
  printf '%s############################################################%s\n' "$_C_YEL" "$_C_RESET" >&2
}

FAILED_STAGES=()
PASSED_STAGES=()

# Run a named stage. On failure: record it and (unless --keep-going) abort.
run_stage() {
  local name="$1"; shift
  local start end dur
  log "── stage ${_C_BLU}${name}${_C_RESET} ──"
  start="$(date +%s)"
  if "$@"; then
    end="$(date +%s)"; dur=$((end - start))
    printf '%s[verify PASS]%s %s (%ss)\n' "$_C_GRN" "$_C_RESET" "$name" "$dur"
    PASSED_STAGES+=("$name")
    return 0
  fi
  end="$(date +%s)"; dur=$((end - start))
  printf '%s[verify FAIL]%s %s (%ss)\n' "$_C_RED" "$_C_RESET" "$name" "$dur" >&2
  FAILED_STAGES+=("$name")
  if [ "$KEEP_GOING" != "1" ]; then
    summary
    exit 1
  fi
  return 1
}

summary() {
  echo
  log "==================== verify-local summary ===================="
  local s
  for s in "${PASSED_STAGES[@]:-}"; do
    [ -n "$s" ] && printf '  %sPASS%s %s\n' "$_C_GRN" "$_C_RESET" "$s"
  done
  for s in "${FAILED_STAGES[@]:-}"; do
    [ -n "$s" ] && printf '  %sFAIL%s %s\n' "$_C_RED" "$_C_RESET" "$s"
  done
  log "============================================================="
}

# ---- Cleanup (trap EXIT) ----------------------------------------------------
# Tracks docker resources we create so we tear EVERYTHING down even on a
# mid-stage failure. Safe to call repeatedly.
CLEANUP_PG_CONTAINER=""
CLEANUP_E2E_PROJECT=""

cleanup() {
  local code=$?
  set +e
  if [ -n "$CLEANUP_PG_CONTAINER" ]; then
    log "cleanup: removing integration postgres container $CLEANUP_PG_CONTAINER"
    "$DOCKER" rm -f "$CLEANUP_PG_CONTAINER" >/dev/null 2>&1 || true
    CLEANUP_PG_CONTAINER=""
  fi
  if [ -n "$CLEANUP_E2E_PROJECT" ]; then
    log "cleanup: tearing down e2e stack (project $CLEANUP_E2E_PROJECT)"
    "$DOCKER" compose -p "$CLEANUP_E2E_PROJECT" -f docker-compose.yml down -v --remove-orphans >/dev/null 2>&1 || true
    CLEANUP_E2E_PROJECT=""
  fi
  return $code
}
trap cleanup EXIT INT TERM

require_docker() {
  command -v "$DOCKER" >/dev/null 2>&1 || return 1
  "$DOCKER" info >/dev/null 2>&1 || return 1
  return 0
}

# ============================================================================
# Stage: static — shell syntax, migration immutability, dockerfile-import
#        guard, prettier --check, eslint, typecheck (all workspaces).
# ============================================================================
stage_static() {
  echo "  -> shell syntax (bash -n scripts/*.sh)"
  bash -n scripts/*.sh || return 1

  if [ -f scripts/check-migrations-immutable.sh ]; then
    echo "  -> migration immutability"
    # Same one-time override the CI job carried for the 087 fix.
    MIGRATION_GUARD_OVERRIDE="${MIGRATION_GUARD_OVERRIDE:-1}" \
      bash scripts/check-migrations-immutable.sh || return 1
  fi

  echo "  -> dockerfile-import guard"
  npm run check:dockerfile-imports || return 1

  echo "  -> prettier --check"
  npm run format || return 1

  echo "  -> eslint"
  npm run lint || return 1

  echo "  -> typecheck (all workspaces)"
  npm run typecheck || return 1
}

# ============================================================================
# Stage: build — full build chain + web bundle budget.
# ============================================================================
stage_build() {
  echo "  -> npm run build"
  npm run build || return 1
  echo "  -> web:bundle-budget"
  npm run web:bundle-budget || return 1
}

# ============================================================================
# Stage: unit — vitest unit suites (the workspace 'test' script).
# ============================================================================
stage_unit() {
  echo "  -> npm run test (vitest, all workspaces)"
  npm run test || return 1
}

# ============================================================================
# Stage: integration — RUN_API_INTEGRATION=1 suite against an ISOLATED
#        throwaway postgres. Mirrors quality.yml's test-integration job:
#        same DATABASE_URL, migrations applied, then the api vitest run.
# ============================================================================
wait_for_pg() {
  local container="$1" i
  for i in $(seq 1 30); do
    if "$DOCKER" exec "$container" pg_isready -U sitelayer >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "  postgres did not become ready in time; container logs:" >&2
  "$DOCKER" logs "$container" 2>&1 | tail -30 >&2 || true
  return 1
}

stage_integration() {
  if ! require_docker; then
    warn "docker is unavailable — integration stage cannot run."
    return 1
  fi

  local container="${VERIFY_PROJECT}-pg"
  CLEANUP_PG_CONTAINER="$container"

  echo "  -> starting isolated postgres ($container) on host port $VERIFY_PG_PORT"
  "$DOCKER" rm -f "$container" >/dev/null 2>&1 || true
  "$DOCKER" run -d --name "$container" \
    -e POSTGRES_DB=sitelayer \
    -e POSTGRES_USER=sitelayer \
    -e POSTGRES_PASSWORD=sitelayer \
    -p "127.0.0.1:${VERIFY_PG_PORT}:5432" \
    "$VERIFY_PG_IMAGE" >/dev/null || return 1

  wait_for_pg "$container" || return 1

  local db_url="postgres://sitelayer:sitelayer@localhost:${VERIFY_PG_PORT}/sitelayer"

  echo "  -> applying migrations"
  DATABASE_URL="$db_url" bash scripts/migrate-db.sh || return 1

  echo "  -> RUN_API_INTEGRATION=1 vitest (@sitelayer/api)"
  # The integration suite needs the package dist outputs on disk (same as
  # CI). If the build stage already ran this is a near no-op; run it
  # defensively so integration works even when invoked standalone.
  if [ ! -d packages/domain/dist ]; then
    echo "     (dist missing — building api deps first)"
    npm run build --workspace @sitelayer/config \
      && npm run build --workspace @sitelayer/domain \
      && npm run build --workspace @sitelayer/logger \
      && npm run build --workspace @sitelayer/workflows \
      && npm run build --workspace @sitelayer/queue \
      && npm run build --workspace @sitelayer/scenario \
      && npm run build --workspace @sitelayer/capture-schema \
      && npm run build --workspace @sitelayer/capture-catalog \
      && npm run build --workspace @sitelayer/formula-evaluator \
      && npm run build --workspace @sitelayer/pipe-blueprint \
      && npm run build --workspace @sitelayer/pipe-roomplan \
      && npm run build --workspace @sitelayer/pipe-photogrammetry \
      && npm run build --workspace @sitelayer/pipe-drone \
      && npm run build --workspace @sitelayer/api || return 1
  fi

  DATABASE_URL="$db_url" \
  RUN_API_INTEGRATION=1 \
  APP_TIER=local \
  ACTIVE_COMPANY_SLUG=la-operations \
  ACTIVE_USER_ID=demo-user \
  ALLOWED_ORIGINS="http://localhost:3000,http://localhost:5173" \
  AUTH_ALLOW_HEADER_FALLBACK=1 \
  PORT=3001 \
    npm run test --workspace @sitelayer/api || return 1

  # Tear the throwaway pg down now (trap is the backstop).
  "$DOCKER" rm -f "$container" >/dev/null 2>&1 || true
  CLEANUP_PG_CONTAINER=""
}

# ============================================================================
# Stage: e2e — replicate quality.yml's e2e job. Bring up the app stack via
#        docker compose (isolated project + non-conflicting ports), apply
#        migrations, seed e2e fixtures, ensure Playwright browsers, run the
#        Playwright suite with the SAME env CI uses (RATE_LIMIT_*=100000,
#        the e2e-fixtures act-as identity, etc.), then tear down (trap).
#
# NO silent skips: if docker or playwright is genuinely unavailable the
# stage FAILS unless explicitly skipped with --skip-e2e.
# ============================================================================
stage_e2e() {
  if ! require_docker; then
    warn "docker is unavailable — e2e stage FAILS (use --skip-e2e to bypass deliberately)."
    return 1
  fi

  local project="$VERIFY_PROJECT"
  CLEANUP_E2E_PROJECT="$project"

  # Bring up ONLY the backing services from the local compose stack
  # (postgres + MinIO). We run api/web/worker as host node processes so
  # Playwright (host-installed browsers) can reach them on localhost — the
  # same shape as the CI e2e job (services.postgres + host-run node).
  echo "  -> bringing up backing services (postgres + MinIO) via compose project $project"
  "$DOCKER" compose -p "$project" -f docker-compose.yml up -d db minio minio-init >/dev/null || return 1

  # Find the host port docker mapped for postgres (compose may remap if the
  # default 5432 is taken). The local compose's db service does NOT publish
  # a host port, so publish via an override is needed — instead we read it.
  local pg_host_port
  pg_host_port="$("$DOCKER" compose -p "$project" -f docker-compose.yml port db 5432 2>/dev/null | awk -F: 'NR==1{print $NF}')"
  if [ -z "$pg_host_port" ]; then
    # docker-compose.yml's db has no published port; fall back to exec-based
    # migration + a host-port publish requirement. Surface clearly.
    warn "compose db service exposes no host port; e2e needs DB reachable from host."
    warn "set VERIFY_PG_PORT and use a compose override, or run with a host postgres."
    return 1
  fi

  local db_url="postgres://sitelayer:sitelayer@localhost:${pg_host_port}/sitelayer"
  echo "  -> postgres reachable at $db_url"

  # Wait for db ready.
  local i
  for i in $(seq 1 30); do
    if "$DOCKER" compose -p "$project" -f docker-compose.yml exec -T db pg_isready -U sitelayer >/dev/null 2>&1; then
      break
    fi
    [ "$i" -eq 30 ] && { echo "  postgres not ready" >&2; return 1; }
    sleep 1
  done

  echo "  -> applying migrations"
  DATABASE_URL="$db_url" bash scripts/migrate-db.sh || return 1

  echo "  -> seeding e2e fixtures"
  DATABASE_URL="$db_url" APP_TIER=local ACTIVE_COMPANY_SLUG=e2e-fixtures \
    npm run seed:e2e || return 1

  echo "  -> building api + web + worker deps"
  npm run build || return 1

  # Ensure Playwright browsers (idempotent — a no-op if already installed).
  echo "  -> ensuring Playwright chromium (idempotent)"
  if ! npx playwright install --with-deps chromium; then
    warn "Playwright browser install failed — e2e stage FAILS (use --skip-e2e to bypass)."
    return 1
  fi

  # --- start host node processes (api, web, worker) ------------------------
  local api_pid web_pid worker_pid
  local logdir; logdir="$(mktemp -d "${TMPDIR:-/tmp}/sitelayer-verify-e2e.XXXXXX")"

  _e2e_stop() {
    set +e
    [ -n "${api_pid:-}" ] && kill "$api_pid" 2>/dev/null
    [ -n "${web_pid:-}" ] && kill "$web_pid" 2>/dev/null
    [ -n "${worker_pid:-}" ] && kill "$worker_pid" 2>/dev/null
  }

  echo "  -> starting api on :$VERIFY_E2E_API_PORT"
  DATABASE_URL="$db_url" APP_TIER=local \
  ACTIVE_COMPANY_SLUG=e2e-fixtures ACTIVE_USER_ID=e2e-admin \
  ALLOWED_ORIGINS="http://localhost:${VERIFY_E2E_WEB_PORT},http://localhost:5173" \
  AUTH_ALLOW_HEADER_FALLBACK=1 PORT="$VERIFY_E2E_API_PORT" \
  RATE_LIMIT_PER_USER_PER_MIN=100000 RATE_LIMIT_PER_IP_PER_MIN=100000 \
    npm run start --workspace @sitelayer/api >"$logdir/api.log" 2>&1 &
  api_pid=$!

  echo "  -> waiting for api health"
  for i in $(seq 1 30); do
    if curl -fsS "http://localhost:${VERIFY_E2E_API_PORT}/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$api_pid" 2>/dev/null; then echo "  api exited early:" >&2; tail -40 "$logdir/api.log" >&2; _e2e_stop; return 1; fi
    [ "$i" -eq 30 ] && { echo "  api health timeout:" >&2; tail -40 "$logdir/api.log" >&2; _e2e_stop; return 1; }
    sleep 1
  done

  echo "  -> starting worker"
  DATABASE_URL="$db_url" APP_TIER=local ACTIVE_COMPANY_SLUG=e2e-fixtures \
  NODE_ENV=test NOTIFICATIONS_ENABLED=0 \
    npm run start --workspace @sitelayer/worker >"$logdir/worker.log" 2>&1 &
  worker_pid=$!
  sleep 3
  if ! kill -0 "$worker_pid" 2>/dev/null; then echo "  worker failed to start:" >&2; tail -40 "$logdir/worker.log" >&2; _e2e_stop; return 1; fi

  echo "  -> starting web dev server on :$VERIFY_E2E_WEB_PORT"
  VITE_API_URL="http://localhost:${VERIFY_E2E_API_PORT}" \
  VITE_DEFAULT_COMPANY_SLUG=e2e-fixtures \
    npm --workspace @sitelayer/web run dev -- --port "$VERIFY_E2E_WEB_PORT" >"$logdir/web.log" 2>&1 &
  web_pid=$!

  echo "  -> waiting for web"
  for i in $(seq 1 60); do
    if curl -fsS "http://localhost:${VERIFY_E2E_WEB_PORT}" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$web_pid" 2>/dev/null; then echo "  web exited early:" >&2; tail -40 "$logdir/web.log" >&2; _e2e_stop; return 1; fi
    [ "$i" -eq 60 ] && { echo "  web timeout:" >&2; tail -40 "$logdir/web.log" >&2; _e2e_stop; return 1; }
    sleep 1
  done

  # --- run Playwright (host browsers reach the host-run stack) -------------
  # Same env the CI e2e job sets. E2E_SKIP_WEBSERVER=1 because WE started the
  # servers above; E2E_RUN=1 so the gating specs actually run.
  echo "  -> running Playwright e2e suite"
  local e2e_rc=0
  E2E_RUN=1 \
  E2E_SKIP_WEBSERVER=1 \
  E2E_BASE_URL="http://localhost:${VERIFY_E2E_WEB_PORT}" \
  E2E_WEB_PORT="$VERIFY_E2E_WEB_PORT" \
  E2E_API_PORT="$VERIFY_E2E_API_PORT" \
  VITE_API_URL="http://localhost:${VERIFY_E2E_API_PORT}" \
  VITE_DEFAULT_COMPANY_SLUG=e2e-fixtures \
  RATE_LIMIT_PER_USER_PER_MIN=100000 RATE_LIMIT_PER_IP_PER_MIN=100000 \
    npm run test:e2e || e2e_rc=$?

  if [ "$e2e_rc" -ne 0 ]; then
    echo "  --- api.log (tail) ---" >&2; tail -40 "$logdir/api.log" >&2 || true
    echo "  --- web.log (tail) ---" >&2; tail -40 "$logdir/web.log" >&2 || true
    echo "  --- worker.log (tail) ---" >&2; tail -40 "$logdir/worker.log" >&2 || true
  fi

  _e2e_stop
  rm -rf "$logdir" 2>/dev/null || true

  # Tear the compose stack down now (trap is the backstop).
  "$DOCKER" compose -p "$project" -f docker-compose.yml down -v --remove-orphans >/dev/null 2>&1 || true
  CLEANUP_E2E_PROJECT=""

  return "$e2e_rc"
}

# ============================================================================
# Main
# ============================================================================
main() {
  # Lockfile so two runs don't collide on ports / docker project names.
  exec 8>"$VERIFY_LOCK_FILE"
  if ! flock -n 8; then
    echo "verify-local: another verify run holds $VERIFY_LOCK_FILE — waiting..." >&2
    flock 8
  fi

  log "level=$VERIFY_LEVEL keep-going=$KEEP_GOING skip-integration=$SKIP_INTEGRATION skip-e2e=$SKIP_E2E"
  log "repo=$REPO_ROOT sha=$(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  local run_start; run_start="$(date +%s)"

  # Always: static, build, unit.
  run_stage "static" stage_static || true
  run_stage "build" stage_build || true
  run_stage "unit" stage_unit || true

  if [ "$VERIFY_LEVEL" = "fast" ]; then
    loud "VERIFY_LEVEL=fast — integration + e2e SKIPPED (static+build+unit only)." \
         "This is the quick-iteration level; the FULL gate runs all stages."
  else
    # integration
    if [ "$SKIP_INTEGRATION" = "1" ]; then
      loud "integration stage SKIPPED via --skip-integration / VERIFY_SKIP_INTEGRATION=1." \
           "The DB-backed integration suite did NOT run."
    else
      run_stage "integration" stage_integration || true
    fi

    # e2e
    if [ "$SKIP_E2E" = "1" ]; then
      loud "e2e stage SKIPPED via --skip-e2e / VERIFY_SKIP_E2E=1." \
           "The docker-compose Playwright suite did NOT run — this is a partial gate."
    else
      run_stage "e2e" stage_e2e || true
    fi
  fi

  local run_end; run_end="$(date +%s)"
  summary
  log "total $((run_end - run_start))s"

  if [ "${#FAILED_STAGES[@]}" -gt 0 ]; then
    printf '%s[verify] FAILED stages: %s%s\n' "$_C_RED" "${FAILED_STAGES[*]}" "$_C_RESET" >&2
    exit 1
  fi
  printf '%s[verify] ALL STAGES PASSED%s\n' "$_C_GRN" "$_C_RESET"
}

main
