#!/usr/bin/env bash
#
# Sitelayer post-deploy smoke for a dev/demo tier host.
#
#   scripts/smoke-tier.sh <host> [expected-sha]
#   scripts/smoke-tier.sh dev.sitelayer.sandolab.xyz            abc1234
#   SMOKE_HOST=demo.preview.sitelayer.sandolab.xyz scripts/smoke-tier.sh
#
# This is DETECTION, not a gate: it runs AFTER a successful dev/demo deploy
# (wired into the tail of scripts/fleet-auto-deploy.sh) to confirm the freshly
# shipped SHA is actually serving traffic. It mirrors scripts/verify-prod-deploy.sh
# (the prod smoke), but targets the public dev/demo hosts over real DNS/TLS and
# does NOT inspect docker/compose state (the preview droplet runs source-mounted
# watch-mode, not a prod compose stack).
#
# Checks (in order):
#   1. GET https://<host>/health            -> HTTP 200
#   2. GET https://<host>/api/version       -> HTTP 200, and (if an expected SHA
#      is supplied) its build_sha matches the just-deployed SHA (short-prefix).
#   3. GET https://<host>/api/session       -> 200 (or 401 = alive-but-Clerk-gated)
#   4. GET https://<host>/api/bootstrap      -> 200 (or 401 = alive-but-Clerk-gated)
#   5. demo tier only: POST /api/demo/sign-in-link with DEMO_ACCESS_CODE
#      -> 200 (mint works). If DEMO_ACCESS_CODE is unset, the check is SKIPPED
#      gracefully (we still assert the route is wired by confirming it does NOT
#      404 — it answers 401/503 instead). See scripts/demo-email.ts and
#      apps/api/src/routes/demo.ts for the contract.
#
# /api/session + /api/bootstrap run after auth+identity+company resolution
# (apps/api/src/routes/system.ts). On the dev tier the deployed env enables the
# header fallback so they answer 200 unauthenticated; the demo tier runs
# Clerk-ON, so unauthenticated they answer 401. A 401 there means the endpoint
# is ALIVE and correctly auth-gated — that is a PASS for a liveness smoke, not a
# regression. Any 5xx / connection failure / 404 there IS a failure.
#
# Exit code: 0 = all checks passed (or were gracefully skipped), 1 = a check
# failed. The watcher logs the failure loudly but does NOT crash on it (the
# deploy already happened — this only surfaces drift).
#
# Everything below is env-overridable so the smoke is testable in isolation
# (the deterministic gate drives it against a localhost mock — see
# apps/api/src/smoke-tier.test.ts).
#
set -euo pipefail

# ---- Configuration (all overridable) ---------------------------------------
HOST="${1:-${SMOKE_HOST:-}}"
EXPECTED_SHA="${2:-${SMOKE_EXPECTED_SHA:-${EXPECTED_SHA:-}}}"

# Tier is inferred from the host (demo hosts contain "demo"); override with
# SMOKE_TIER for tests / non-standard hostnames.
SMOKE_TIER="${SMOKE_TIER:-}"

# Scheme + curl knobs. SMOKE_SCHEME=http lets the test target a localhost mock
# without TLS; production callers leave it https.
SMOKE_SCHEME="${SMOKE_SCHEME:-https}"
CURL_MAX_TIME="${SMOKE_CURL_MAX_TIME:-15}"
# How many leading hex chars of build_sha to compare (git short default 7+).
SHA_COMPARE_LEN="${SMOKE_SHA_COMPARE_LEN:-7}"
# Demo access code for the sign-in-link mint check (skipped gracefully if empty).
DEMO_ACCESS_CODE="${DEMO_ACCESS_CODE:-}"

if [ -z "$HOST" ]; then
  echo "usage: scripts/smoke-tier.sh <host> [expected-sha]" >&2
  echo "       (or set SMOKE_HOST=<host>)" >&2
  exit 2
fi

if [ -z "$SMOKE_TIER" ]; then
  case "$HOST" in
    *demo*) SMOKE_TIER="demo" ;;
    *) SMOKE_TIER="dev" ;;
  esac
fi

BASE_URL="$SMOKE_SCHEME://$HOST"

# ---- Logging ----------------------------------------------------------------
log() { printf 'smoke[%s] %s\n' "$HOST" "$*"; }
fail() { printf 'smoke[%s] FAIL %s\n' "$HOST" "$*" >&2; }

FAILURES=0
note_fail() {
  fail "$*"
  FAILURES=$((FAILURES + 1))
}

# ---- HTTP helpers -----------------------------------------------------------
# Print the HTTP status code for a GET (empty string on connection failure).
http_status() {
  local url="$1"
  curl -sS -o /dev/null -w '%{http_code}' --max-time "$CURL_MAX_TIME" "$url" 2>/dev/null || printf ''
}

# Print the response body for a GET (empty on failure).
http_body() {
  local url="$1"
  curl -sS --max-time "$CURL_MAX_TIME" "$url" 2>/dev/null || printf ''
}

# Extract build_sha from /api/version JSON on stdin (jq, grep/sed fallback).
extract_build_sha() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.build_sha // empty' 2>/dev/null
  else
    grep -o '"build_sha"[[:space:]]*:[[:space:]]*"[^"]*"' |
      sed -E 's/.*"build_sha"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' |
      head -n1
  fi
}

short() { printf '%s' "${1:0:$SHA_COMPARE_LEN}"; }

# ---- Check 1: /health -------------------------------------------------------
check_health() {
  local code
  code="$(http_status "$BASE_URL/health")"
  if [ "$code" = "200" ]; then
    log "OK  /health 200"
  else
    note_fail "/health returned HTTP ${code:-<no-response>} (expected 200)"
  fi
}

# ---- Check 2: /api/version (+ optional SHA match) ---------------------------
check_version() {
  local body code live
  code="$(http_status "$BASE_URL/api/version")"
  if [ "$code" != "200" ]; then
    note_fail "/api/version returned HTTP ${code:-<no-response>} (expected 200)"
    return
  fi
  body="$(http_body "$BASE_URL/api/version")"
  live="$(printf '%s' "$body" | extract_build_sha)"
  if [ -z "$EXPECTED_SHA" ]; then
    log "OK  /api/version 200 (live build_sha=${live:-unknown}; no expected SHA to compare)"
    return
  fi
  if [ -z "$live" ]; then
    note_fail "/api/version 200 but build_sha missing; expected $(short "$EXPECTED_SHA")"
    return
  fi
  if [ "$(short "$live")" = "$(short "$EXPECTED_SHA")" ]; then
    log "OK  /api/version 200 build_sha=$(short "$live") matches deployed SHA"
  else
    note_fail "/api/version build_sha=$(short "$live") does NOT match deployed $(short "$EXPECTED_SHA")"
  fi
}

# ---- Check 3+4: /api/session, /api/bootstrap (200, or 401 = auth-gated) -----
check_authed_endpoint() {
  local path="$1" code
  code="$(http_status "$BASE_URL$path")"
  case "$code" in
    200) log "OK  $path 200" ;;
    401) log "OK  $path 401 (alive, Clerk-gated — acceptable on demo tier)" ;;
    *) note_fail "$path returned HTTP ${code:-<no-response>} (expected 200, or 401 if auth-gated)" ;;
  esac
}

# ---- Check 5: demo sign-in-link mint (demo tier only) -----------------------
check_demo_sign_in_link() {
  local url="$BASE_URL/api/demo/sign-in-link" code body

  if [ -z "$DEMO_ACCESS_CODE" ]; then
    # No access code: we can't mint. Still confirm the route is WIRED (i.e. it
    # is NOT a 404 — the demo surface exists). It should answer 401 (bad/empty
    # code) or 503 (DEMO_ACCESS_CODE unset on the server). A 404 means the demo
    # route is structurally absent (wrong tier / not deployed) -> fail.
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$CURL_MAX_TIME" \
      -X POST -H 'content-type: application/json' \
      --data '{"role":"owner","accessCode":""}' "$url" 2>/dev/null || printf '')"
    case "$code" in
      401 | 503) log "SKIP /api/demo/sign-in-link mint (DEMO_ACCESS_CODE unset); route wired (HTTP $code)" ;;
      404 | '') note_fail "/api/demo/sign-in-link not wired (HTTP ${code:-<no-response>}; expected 401/503)" ;;
      *) log "SKIP /api/demo/sign-in-link mint (DEMO_ACCESS_CODE unset); route answered HTTP $code" ;;
    esac
    return
  fi

  # Full mint: a valid access code should return 200 with a redirect_url.
  body="$(curl -sS -w $'\n%{http_code}' --max-time "$CURL_MAX_TIME" \
    -X POST -H 'content-type: application/json' \
    --data "{\"role\":\"owner\",\"accessCode\":\"$DEMO_ACCESS_CODE\"}" "$url" 2>/dev/null || printf '\n')"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$code" = "200" ] && printf '%s' "$body" | grep -q '"redirect_url"'; then
    log "OK  /api/demo/sign-in-link 200 (mint returned redirect_url)"
  elif [ "$code" = "404" ]; then
    # The demo users may not be seeded for this role yet — that's a seeding gap,
    # not a deploy regression. Surface it but don't fail the deploy smoke.
    log "SKIP /api/demo/sign-in-link mint (HTTP 404 — demo user not seeded for role 'owner')"
  else
    note_fail "/api/demo/sign-in-link returned HTTP ${code:-<no-response>} (expected 200 with redirect_url)"
  fi
}

# ---- Main -------------------------------------------------------------------
main() {
  log "tier=$SMOKE_TIER base=$BASE_URL expected-sha=${EXPECTED_SHA:+$(short "$EXPECTED_SHA")}"
  check_health
  check_version
  check_authed_endpoint "/api/session"
  check_authed_endpoint "/api/bootstrap"
  if [ "$SMOKE_TIER" = "demo" ]; then
    check_demo_sign_in_link
  fi

  if [ "$FAILURES" -gt 0 ]; then
    fail "$FAILURES check(s) failed"
    exit 1
  fi
  log "all checks passed"
}

main
