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
#   scripts/verify-local.sh                 # default (standard): static+build+unit+integration
#   scripts/verify-local.sh --fast          # static + build + unit only
#   scripts/verify-local.sh --full          # standard + e2e (resource-heavy; run on a quiet/dedicated box)
#   scripts/verify-local.sh --skip-e2e      # full minus e2e
#   scripts/verify-local.sh --skip-integration
#   scripts/verify-local.sh --keep-going    # run all stages, don't fail-fast
#
# Levels (also via VERIFY_LEVEL env; flag wins over env):
#   fast      -> static, audit, build, unit                     (quick iteration)
#   standard  -> static, audit, build, unit, integration        (DEFAULT; the deploy/merge gate — deterministic + reliable)
#   full      -> standard + e2e (docker-compose stack + Playwright)
#
# Why e2e is NOT in the default gate: the e2e stage stands up the full app
# stack + a real browser and is resource-sensitive. On a clean dedicated runner
# it is reliable; on a shared/loaded box it flakes (browser/page-closed). So the
# deploy gate blocks on the deterministic stages (incl. real-DB integration) and
# e2e is an explicit `--full` opt-in to run when a quiet box is available.
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
VERIFY_LEVEL="${VERIFY_LEVEL:-standard}"
KEEP_GOING="${VERIFY_KEEP_GOING:-0}"
SKIP_E2E="${VERIFY_SKIP_E2E:-0}"
SKIP_INTEGRATION="${VERIFY_SKIP_INTEGRATION:-0}"

# Distinct, high project name + ports so two runs (or a live local stack)
# never collide. PID-suffixed by default; overridable for determinism.
VERIFY_PROJECT="${VERIFY_PROJECT:-sitelayer-verify-$$}"

# Pick the first free TCP port at/above a base. The gate must be robust on a
# SHARED box: the fleet runs this WITH a live dev stack already on 5432/3001/
# 3100. On a clean runner the base ports are free, so the chosen ports match
# CI. An explicit VERIFY_*_PORT env always wins (no auto-pick).
_free_port() {
  local p="$1" cap=$(( $1 + 400 ))
  while [ "$p" -lt "$cap" ]; do
    if ! ss -ltnH "sport = :$p" 2>/dev/null | grep -q .; then printf '%s' "$p"; return 0; fi
    p=$((p + 1))
  done
  printf '%s' "$1" # fall back to base; the stage then surfaces EADDRINUSE loudly
}
# Isolated postgres for the integration suite (tests honor DATABASE_URL).
VERIFY_PG_PORT="${VERIFY_PG_PORT:-$(_free_port 5432)}"
VERIFY_PG_IMAGE="${VERIFY_PG_IMAGE:-postgres:18-alpine}"
# e2e app-stack host ports (web/api), auto-picked free so the e2e stack can
# coexist with a developer's live stack. The specs honor E2E_API_PORT /
# E2E_WEB_PORT (which default to these).
VERIFY_E2E_API_PORT="${VERIFY_E2E_API_PORT:-$(_free_port 3001)}"
VERIFY_E2E_WEB_PORT="${VERIFY_E2E_WEB_PORT:-$(_free_port 3100)}"
# Host port the integration stage's api binds (server.test.ts drives it over
# HTTP and reads this via PORT). Distinct base from the e2e api so a lingering
# process can't collide.
VERIFY_INTEGRATION_API_PORT="${VERIFY_INTEGRATION_API_PORT:-$(_free_port 3401)}"

# Compose files for the e2e backing-service stack. The base compose's `db`
# publishes no host port and `minio` pins 9000/9001; the verify override
# (docker-compose.verify.yml) publishes `db` on an EPHEMERAL host port and
# remaps minio to ephemeral host ports so the isolated verify project never
# collides with a developer's live `sitelayer` stack. Override-able for
# environments that already expose the db port.
VERIFY_COMPOSE_OVERRIDE="${VERIFY_COMPOSE_OVERRIDE:-docker-compose.verify.yml}"
VERIFY_COMPOSE_FILES=(-f docker-compose.yml)
if [ -n "$VERIFY_COMPOSE_OVERRIDE" ] && [ -f "$VERIFY_COMPOSE_OVERRIDE" ]; then
  VERIFY_COMPOSE_FILES+=(-f "$VERIFY_COMPOSE_OVERRIDE")
fi

# Lockfile so two concurrent runs don't collide on ports / docker projects.
VERIFY_LOCK_FILE="${VERIFY_LOCK_FILE:-/tmp/sitelayer-verify.lock}"

DOCKER="${DOCKER_BIN:-docker}"

# ---- Argument parsing -------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --fast) VERIFY_LEVEL="fast" ;;
    --standard) VERIFY_LEVEL="standard" ;;
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
    "$DOCKER" compose -p "$CLEANUP_E2E_PROJECT" "${VERIFY_COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
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
# Check: package-lock is in sync with every package.json (catch lockfile
#        drift at PUSH, not at the Docker `npm ci` in the deploy build).
#
# `npm ci` is the install command the Dockerfile uses; it REFUSES to run
# (exit 1, code EUSAGE) when package.json and package-lock.json disagree —
# e.g. a dep bumped/added without `npm install --package-lock-only`, or a
# vendored `file:./operator-*.tgz` whose version string changed. That
# failure used to surface only mid-deploy (slow, post-build). `--dry-run`
# resolves the tree WITHOUT writing node_modules, so this is a fast,
# read-only, side-effect-free gate (~1s) that fails for the same reason
# the real deploy install would. `--ignore-scripts`/`--no-audit`/`--no-fund`
# keep it hermetic (no lifecycle scripts, no network for audit/fund).
# ============================================================================
check_lockfile_sync() {
  if [ ! -f package-lock.json ]; then
    warn "no package-lock.json at repo root — lockfile-sync check cannot run."
    return 1
  fi
  local out rc=0
  # Capture output so we can surface npm's own EUSAGE message on failure
  # (the bare exit code alone isn't actionable).
  out="$(npm ci --dry-run --ignore-scripts --no-audit --no-fund 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  package-lock.json is OUT OF SYNC with package.json — fix with:" >&2
    echo "    npm install --package-lock-only   # then commit package-lock.json" >&2
    echo "  (a vendored file:./operator-*.tgz dep also needs a VERSION bump on content change)" >&2
    echo "  --- npm output ---" >&2
    printf '%s\n' "$out" | sed -n '1,12p' >&2
    return 1
  fi
  return 0
}

# The merge verifier checks out a clean worktree, so node_modules may be
# absent even when package-lock.json is perfectly valid. Run a real install
# before npm-backed static/build/test stages, but avoid clobbering an already
# prepared developer checkout on every local verify run.
ensure_dependencies_installed() {
  if [ "${VERIFY_SKIP_NPM_CI:-0}" = "1" ]; then
    loud "VERIFY_SKIP_NPM_CI=1 set — assuming node_modules is already valid."
    return 0
  fi

  if [ -f node_modules/.package-lock.json ] \
    && [ -x node_modules/.bin/eslint ] \
    && [ -d node_modules/@eslint/js ] \
    && [ -x node_modules/.bin/tsc ]; then
    return 0
  fi

  echo "  -> dependency install (npm ci)"
  npm ci --ignore-scripts --no-audit --no-fund || return 1
}

# ============================================================================
# Stage: static — shell syntax, lockfile-sync, migration immutability,
#        dockerfile-import guard, prettier --check, eslint, typecheck
#        (all workspaces).
# ============================================================================
stage_static() {
  echo "  -> shell syntax (bash -n scripts/*.sh)"
  bash -n scripts/*.sh || return 1

  echo "  -> package-lock sync (npm ci --dry-run)"
  check_lockfile_sync || return 1

  if [ -f scripts/check-migrations-immutable.sh ]; then
    echo "  -> migration immutability"
    # The immutability check MUST default to ON. Defaulting the override to 1
    # made the check a no-op in every path (gate, pre-push hook, deploy), so a
    # mutated/removed already-applied migration would have sailed through. The
    # sanctioned squash escape is to EXPLICITLY export MIGRATION_GUARD_OVERRIDE=1
    # for the one run that intentionally rewrites migration history
    # (see docs/MIGRATION_BASELINE.md); it must never be the default. We pass the
    # caller's value through verbatim (0 when unset) so the check itself
    # enforces "anything but 1 blocks".
    MIGRATION_GUARD_OVERRIDE="${MIGRATION_GUARD_OVERRIDE:-0}" \
      bash scripts/check-migrations-immutable.sh || return 1
  fi

  ensure_dependencies_installed || return 1

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
# Stage: audit — npm audit over PRODUCTION dependencies only.
#
# The install paths everywhere else run --no-audit (deliberately: hermetic,
# fast), which means NOTHING scans the dependency tree for known vulns. This
# stage is that scan, as its own named gate: high/critical advisories in the
# prod dependency graph (--omit=dev) FAIL the gate. Dev-only advisories do
# not block (the shipped image carries only prod deps — the Dockerfile runs
# npm ci --omit=dev).
#
# Needs registry network access (like the lockfile-sync check / docker pulls
# elsewhere in this gate). VERIFY_AUDIT_LEVEL is overridable for a temporary,
# explicit loosening — never silently.
# ============================================================================
stage_audit() {
  local audit_level="${VERIFY_AUDIT_LEVEL:-high}"
  echo "  -> npm audit --omit=dev --audit-level=$audit_level"
  npm audit --omit=dev --audit-level="$audit_level" || return 1
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
  # Hermetic node:test suites for the ops shell scripts (no DB / Docker / network
  # — they stub external commands). Covers render-production-env.mjs and the
  # PREVIEW_DB_BACKEND abstraction in deploy-preview.sh.
  echo "  -> npm run test:scripts (node:test, scripts/*.test.mjs)"
  npm run test:scripts || return 1
}

# ============================================================================
# Stage: conformance — projectkit CONTRACT conformance, asserted EXPLICITLY.
#
# The @sitelayer/projectkit-bridge test validates sitelayer's emitted
# Concern / WorkRequest / callback snapshots against the PUBLISHED
# @operator/projectkit JSON schema (schemas/project-event.schema.json) loaded
# from the installed package — i.e. the same cross-language contract a Go
# subscriber (mesh) would hold us to. This stage runs JUST that test, as a
# named, unmissable gate, so a projectkit version bump (e.g. 0.5.x -> 0.7.x)
# or a drift in the snapshot shape fails LOUD and on its own line, instead of
# being buried in the ~1700-test workspace run. (It also runs inside the unit
# stage; this is the deliberate, isolated assertion the operator asked for.)
# ============================================================================
stage_conformance() {
  echo "  -> projectkit contract conformance (@sitelayer/projectkit-bridge)"
  npm run test:conformance --workspace=@sitelayer/projectkit-bridge || return 1
}

# ============================================================================
# Stage: integration — RUN_API_INTEGRATION=1 suite against an ISOLATED
#        throwaway postgres. This is the same shape the removed
#        quality.yml test-integration job used to run (deleted 2026-06-02):
#        same DATABASE_URL, migrations applied, then the api vitest run.
# ============================================================================
wait_for_pg() {
  local container="$1" host_port="$2" i
  # The postgres entrypoint starts the server transiently on a unix socket to
  # run init, then RESTARTS it to listen on TCP. `pg_isready` inside the
  # container can report ready during that first transient start, before the
  # TCP listener is up — a host connection in that window gets "server closed
  # the connection unexpectedly". So we wait for a REAL host-side TCP query to
  # succeed, which is what migrate-db.sh / the tests actually do.
  local have_psql=0
  command -v psql >/dev/null 2>&1 && have_psql=1
  for i in $(seq 1 60); do
    if "$DOCKER" exec "$container" pg_isready -U sitelayer >/dev/null 2>&1; then
      if [ "$have_psql" = "1" ]; then
        # Confirm the TCP listener is really up from the host's perspective.
        if PGPASSWORD=sitelayer psql -h localhost -p "$host_port" -U sitelayer \
             -d sitelayer -tAc 'select 1' >/dev/null 2>&1; then
          return 0
        fi
      else
        # No host psql; pg_isready is the best signal. Give the entrypoint a
        # moment past its init restart, then trust it.
        sleep 2
        return 0
      fi
    fi
    sleep 1
  done
  echo "  postgres did not become ready on host port $host_port in time; container logs:" >&2
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
  # Ephemeral throwaway test DB: data dir on tmpfs (RAM) + durability knobs off.
  # The DB is destroyed at the end of every run, so fsync/full_page_writes/
  # synchronous_commit buy nothing but cost wall-clock on the migrate + insert
  # heavy integration suite. (tmpfs covers PG18's /var/lib/postgresql/<ver> dir.)
  "$DOCKER" run -d --name "$container" \
    -e POSTGRES_DB=sitelayer \
    -e POSTGRES_USER=sitelayer \
    -e POSTGRES_PASSWORD=sitelayer \
    -p "127.0.0.1:${VERIFY_PG_PORT}:5432" \
    --tmpfs /var/lib/postgresql \
    "$VERIFY_PG_IMAGE" \
    -c fsync=off -c full_page_writes=off -c synchronous_commit=off >/dev/null || return 1

  wait_for_pg "$container" "$VERIFY_PG_PORT" || return 1

  local db_url="postgres://sitelayer:sitelayer@localhost:${VERIFY_PG_PORT}/sitelayer"

  echo "  -> applying migrations"
  DATABASE_URL="$db_url" bash scripts/migrate-db.sh || return 1

  # --- RLS runtime probe plumbing (restored 2026-06-12) ---------------------
  # Migration 016_restore_constrained_role.sql provisions the NOBYPASSRLS
  # login role `sitelayer_constrained` (the throwaway pg's `sitelayer` user is
  # the superuser, so CREATE ROLE always succeeds here). Verify it landed with
  # the attributes the probes depend on, then export CONSTRAINED_DB_URL into
  # the api vitest run so the runtime RLS probes
  # (rls-phase3-audit.test.ts / rls-force-close-gaps.test.ts /
  # company-settings.test.ts) RUN instead of describe.skip-ing. This restores
  # the gate the removed quality.yml:326 used to provide — without it,
  # cross-tenant RLS enforcement has ZERO runtime verification.
  echo "  -> verifying sitelayer_constrained role (RLS runtime probe prerequisite)"
  local role_attrs
  role_attrs="$("$DOCKER" exec "$container" psql -U sitelayer -d sitelayer -tAc \
    "select rolcanlogin || '|' || rolbypassrls || '|' || rolsuper from pg_roles where rolname = 'sitelayer_constrained'")" || return 1
  if [ "$role_attrs" != "true|false|false" ]; then
    echo "  ERROR: sitelayer_constrained role is missing or misconfigured (got '${role_attrs:-<absent>}', want 'true|false|false' = LOGIN, NOBYPASSRLS, NOSUPERUSER)." >&2
    echo "  The RLS runtime probes cannot run without it. Check docker/postgres/init/016_restore_constrained_role.sql." >&2
    return 1
  fi
  local constrained_db_url="postgres://sitelayer_constrained:sitelayer_constrained@localhost:${VERIFY_PG_PORT}/sitelayer"
  echo "  -> CONSTRAINED_DB_URL exported (runtime RLS probes ACTIVE)"

  # The integration suite needs the package dist outputs on disk (same as
  # CI). If the build stage already ran this is a near no-op; run it
  # defensively so integration works even when invoked standalone.
  if [ ! -d packages/domain/dist ]; then
    echo "  -> (dist missing — building api deps first)"
    npm run build --workspace @sitelayer/config \
      && npm run build --workspace @sitelayer/domain \
      && npm run build --workspace @sitelayer/logger \
      && npm run build --workspace @sitelayer/workflows \
      && npm run build --workspace @sitelayer/projectkit-bridge \
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

  # The integration suite's server.test.ts drives a LIVE api over HTTP on
  # :3001 (the rest self-host an in-process server). CI started the api server
  # before running the vitest; mirror that here, pointed at the throwaway pg.
  local api_pid="" ilog
  local api_port="$VERIFY_INTEGRATION_API_PORT"
  ilog="$(mktemp "${TMPDIR:-/tmp}/sitelayer-verify-int-api.XXXXXX.log")"
  echo "  -> starting api on :$api_port (for the HTTP-driven integration specs)"
  DATABASE_URL="$db_url" APP_TIER=local \
  ACTIVE_COMPANY_SLUG=la-operations ACTIVE_USER_ID=demo-user \
  ALLOWED_ORIGINS="http://localhost:3000,http://localhost:5173" \
  AUTH_ALLOW_HEADER_FALLBACK=1 PORT="$api_port" \
  RATE_LIMIT_PER_USER_PER_MIN=100000 RATE_LIMIT_PER_IP_PER_MIN=100000 \
    npm run start --workspace @sitelayer/api >"$ilog" 2>&1 &
  api_pid=$!

  _int_stop() { [ -n "${api_pid:-}" ] && kill "$api_pid" 2>/dev/null; }

  local i
  for i in $(seq 1 30); do
    if curl -fsS "http://localhost:${api_port}/health" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$api_pid" 2>/dev/null; then
      echo "  api exited early:" >&2; tail -40 "$ilog" >&2; rm -f "$ilog"; return 1
    fi
    [ "$i" -eq 30 ] && { echo "  api health timeout:" >&2; tail -40 "$ilog" >&2; _int_stop; rm -f "$ilog"; return 1; }
    sleep 1
  done

  echo "  -> RUN_API_INTEGRATION=1 vitest (@sitelayer/api)"
  # RLS_PHASE3_FAIL_ON_LEAK=1 turns the RLS audits into BLOCKING gates: the
  # static route audit fails on any raw pool.query leak, and the live-schema
  # forced-coverage audit (rls-force-audit.ts) fails when a company_id table
  # ships without FORCE ROW LEVEL SECURITY and isn't allowlisted — the
  # asset_deployments-style gap the deploy gate must catch.
  # CONSTRAINED_DB_URL un-skips the runtime RLS probes (non-BYPASSRLS role
  # proving the policies actually scope rows) — a probe violation FAILS the
  # gate like any other test failure.
  local int_rc=0
  DATABASE_URL="$db_url" \
  RUN_API_INTEGRATION=1 \
  RLS_PHASE3_FAIL_ON_LEAK=1 \
  CONSTRAINED_DB_URL="$constrained_db_url" \
  APP_TIER=local \
  ACTIVE_COMPANY_SLUG=la-operations \
  ACTIVE_USER_ID=demo-user \
  ALLOWED_ORIGINS="http://localhost:3000,http://localhost:5173" \
  AUTH_ALLOW_HEADER_FALLBACK=1 \
  PORT="$api_port" \
  RATE_LIMIT_PER_USER_PER_MIN=100000 RATE_LIMIT_PER_IP_PER_MIN=100000 \
    npm run test --workspace @sitelayer/api || int_rc=$?

  if [ "$int_rc" -ne 0 ]; then
    echo "  --- integration api.log (tail) ---" >&2; tail -40 "$ilog" >&2 || true
  fi
  _int_stop
  rm -f "$ilog" 2>/dev/null || true
  [ "$int_rc" -ne 0 ] && return "$int_rc"

  # Multi-tenant worker integration suite against the SAME migrated throwaway
  # pg. multitenant-drain.integration.test.ts is gated on RUN_API_INTEGRATION=1
  # (it self-skips in the unit stage where there is no DB) and needs migration
  # 144 (integration_connections.qbo_live_enabled) applied — proving the worker
  # drains MULTIPLE companies in one tick, never crosses tenant scope, and the
  # per-company QBO-live flag gates correctly with the global kill switch.
  echo "  -> RUN_API_INTEGRATION=1 vitest (@sitelayer/worker — multitenant drain)"
  local worker_int_rc=0
  DATABASE_URL="$db_url" \
  RUN_API_INTEGRATION=1 \
  APP_TIER=local \
    npm run test --workspace @sitelayer/worker || worker_int_rc=$?
  [ "$worker_int_rc" -ne 0 ] && return "$worker_int_rc"

  # Tear the throwaway pg down now (trap is the backstop).
  "$DOCKER" rm -f "$container" >/dev/null 2>&1 || true
  CLEANUP_PG_CONTAINER=""
}

# ============================================================================
# Stage: e2e — the e2e job the removed quality.yml used to run (deleted
#        2026-06-02), now an opt-in --full level here. Bring up the app stack
#        via docker compose (isolated project + non-conflicting ports), apply
#        migrations, seed e2e fixtures, ensure Playwright browsers, run the
#        Playwright suite with the SAME env that job used (RATE_LIMIT_*=100000,
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
  "$DOCKER" compose -p "$project" "${VERIFY_COMPOSE_FILES[@]}" up -d db minio minio-init >/dev/null || return 1

  # Find the host port docker mapped for postgres. The base compose's `db`
  # publishes no host port; docker-compose.verify.yml adds an ephemeral
  # publish so this resolves. If it's still empty the override is missing —
  # FAIL loudly rather than silently skip a real DB.
  local pg_host_port
  pg_host_port="$("$DOCKER" compose -p "$project" "${VERIFY_COMPOSE_FILES[@]}" port db 5432 2>/dev/null | awk -F: 'NR==1{print $NF}')"
  if [ -z "$pg_host_port" ]; then
    warn "compose db service exposes no host port; e2e needs DB reachable from host."
    warn "ensure $VERIFY_COMPOSE_OVERRIDE publishes the db port (or set VERIFY_COMPOSE_OVERRIDE)."
    return 1
  fi

  local db_url="postgres://sitelayer:sitelayer@localhost:${pg_host_port}/sitelayer"
  echo "  -> postgres reachable at $db_url"

  # Wait for db ready — container pg_isready PLUS a real host TCP query (the
  # postgres entrypoint restarts between its init phase and the TCP listener,
  # so pg_isready alone races "server closed the connection unexpectedly").
  local i have_psql=0
  command -v psql >/dev/null 2>&1 && have_psql=1
  for i in $(seq 1 60); do
    if "$DOCKER" compose -p "$project" "${VERIFY_COMPOSE_FILES[@]}" exec -T db pg_isready -U sitelayer >/dev/null 2>&1; then
      if [ "$have_psql" = "1" ]; then
        if PGPASSWORD=sitelayer psql -h localhost -p "$pg_host_port" -U sitelayer \
             -d sitelayer -tAc 'select 1' >/dev/null 2>&1; then break; fi
      else
        sleep 2; break
      fi
    fi
    [ "$i" -eq 60 ] && { echo "  postgres not ready on host port $pg_host_port" >&2; return 1; }
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
  # `--with-deps` apt-installs system libraries and needs root; on a non-root
  # box it fails even though the browser download itself would succeed (and
  # the system libs are usually already present). Try --with-deps first, then
  # fall back to the plain browser download. Only FAIL if neither lands a
  # usable chromium.
  echo "  -> ensuring Playwright chromium (idempotent)"
  if ! npx playwright install --with-deps chromium >/dev/null 2>&1; then
    warn "playwright install --with-deps failed (likely needs root for system deps); retrying browser-only download."
    if ! npx playwright install chromium; then
      warn "Playwright browser install failed — e2e stage FAILS (use --skip-e2e to bypass)."
      return 1
    fi
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
  "$DOCKER" compose -p "$project" "${VERIFY_COMPOSE_FILES[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
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

  # Always: static, audit, build, unit, conformance (the projectkit contract gate).
  run_stage "static" stage_static || true
  run_stage "audit" stage_audit || true
  run_stage "build" stage_build || true
  run_stage "unit" stage_unit || true
  run_stage "conformance" stage_conformance || true

  if [ "$VERIFY_LEVEL" = "fast" ]; then
    loud "VERIFY_LEVEL=fast — integration + e2e SKIPPED (static+build+unit only)." \
         "This is the quick-iteration level; the standard gate also runs integration."
  else
    # integration (standard + full)
    if [ "$SKIP_INTEGRATION" = "1" ]; then
      loud "integration stage SKIPPED via --skip-integration / VERIFY_SKIP_INTEGRATION=1." \
           "The DB-backed integration suite did NOT run."
    else
      run_stage "integration" stage_integration || true
    fi

    # e2e (full ONLY — opt-in, resource-heavy; not part of the default deploy gate)
    if [ "$VERIFY_LEVEL" != "full" ]; then
      loud "VERIFY_LEVEL=standard — e2e SKIPPED (the default deploy gate is static+build+unit+integration)." \
           "Run 'verify-local.sh --full' (npm run verify:full) on a quiet/dedicated box for the Playwright e2e suite."
    elif [ "$SKIP_E2E" = "1" ]; then
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
