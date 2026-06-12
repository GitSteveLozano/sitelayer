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
#   6. demo tier only (needs DEMO_ACCESS_CODE): SEED RESOLUTION follow-through.
#      Check 5 only proves the Clerk-side mint; a wiped steve-demo company /
#      company_memberships seed would stay green. So we mint a ticket for a
#      NON-admin role (default crew -> member), exchange it at the Clerk
#      Frontend API for a real session JWT (all curl — no browser), then call
#      GET /api/session with that JWT + x-sitelayer-company-slug and require a
#      membership row for the demo company with the EXPECTED role. Why the
#      non-admin role: the API's first-user auto-onboard grants `admin` to the
#      first authenticated user of a company with ZERO memberships, which
#      would otherwise mask a wiped seed — `member` can only come from the
#      seed itself. FAILS when the company 404s, the session is rejected, or
#      the membership row is missing/wrong-role.
#      The Clerk Frontend API base resolves from (first match wins):
#      SMOKE_CLERK_FAPI, a publishable key env (SMOKE_CLERK_PUBLISHABLE_KEY /
#      CLERK_PUBLISHABLE_KEY / VITE_CLERK_PUBLISHABLE_KEY — the FAPI host is
#      base64-encoded inside it), or scraping the served SPA bundle for its
#      inlined pk_test_/pk_live_ key (self-sufficient from the fleet).
#      Escape hatch: SMOKE_SKIP_SEED_CHECK=1 (loud skip).
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

# ---- Seed-resolution follow-through knobs (check 6) --------------------------
# Clerk Frontend API base: explicit URL/host wins; else derived from a
# publishable key env; else scraped from the served SPA bundle.
SMOKE_CLERK_FAPI="${SMOKE_CLERK_FAPI:-}"
SMOKE_CLERK_PUBLISHABLE_KEY="${SMOKE_CLERK_PUBLISHABLE_KEY:-${CLERK_PUBLISHABLE_KEY:-${VITE_CLERK_PUBLISHABLE_KEY:-}}}"
# Scheme for a derived/scraped FAPI host (tests point this at an http mock).
SMOKE_CLERK_FAPI_SCHEME="${SMOKE_CLERK_FAPI_SCHEME:-https}"
# Demo company + role expectations. The mint role must map to a NON-admin
# membership role so the first-user auto-onboard (which grants admin on a
# memberships-empty company) cannot mask a wiped seed.
SMOKE_DEMO_COMPANY_SLUG="${SMOKE_DEMO_COMPANY_SLUG:-steve-demo}"
SMOKE_DEMO_SEED_ROLE="${SMOKE_DEMO_SEED_ROLE:-crew}"
SMOKE_DEMO_SEED_EXPECT_ROLE="${SMOKE_DEMO_SEED_EXPECT_ROLE:-member}"
SMOKE_SKIP_SEED_CHECK="${SMOKE_SKIP_SEED_CHECK:-0}"

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

# ---- Check 6: demo seed resolution (demo tier only; needs DEMO_ACCESS_CODE) --
# Mint -> Clerk FAPI ticket exchange -> session JWT -> GET /api/session ->
# assert the seeded company membership resolves with the expected role.

# Decode the FAPI host out of a Clerk publishable key
# (pk_test_/pk_live_<base64("host$")>) on stdin-less argv. Empty on failure.
fapi_host_from_publishable_key() {
  local key="$1" encoded decoded
  encoded="${key#pk_test_}"
  encoded="${encoded#pk_live_}"
  [ "$encoded" = "$key" ] && { printf ''; return 0; }
  decoded="$(printf '%s' "$encoded" | base64 -d 2>/dev/null || printf '')"
  printf '%s' "${decoded%\$}"
}

# Best-effort scrape of the served SPA for its inlined Clerk publishable key:
# index.html first, then each referenced .js asset (Vite inlines
# VITE_CLERK_PUBLISHABLE_KEY into a chunk). Prints the key or nothing.
scrape_publishable_key() {
  local html key asset
  html="$(http_body "$BASE_URL/")"
  [ -z "$html" ] && { printf ''; return 0; }
  key="$(printf '%s' "$html" | grep -oE 'pk_(test|live)_[A-Za-z0-9=]+' | head -n1)"
  if [ -n "$key" ]; then printf '%s' "$key"; return 0; fi
  # Pull every same-origin .js asset reference and grep each until a key hits.
  while IFS= read -r asset; do
    [ -z "$asset" ] && continue
    key="$(http_body "$BASE_URL$asset" | grep -oE 'pk_(test|live)_[A-Za-z0-9=]+' | head -n1)"
    if [ -n "$key" ]; then printf '%s' "$key"; return 0; fi
  done < <(printf '%s' "$html" | grep -oE '(src|href)="[^"]+\.js"' | sed -E 's/^(src|href)="//; s/"$//' | grep '^/' | head -n8)
  printf ''
}

resolve_clerk_fapi_base() {
  local base="" key
  if [ -n "$SMOKE_CLERK_FAPI" ]; then
    base="$SMOKE_CLERK_FAPI"
  elif [ -n "$SMOKE_CLERK_PUBLISHABLE_KEY" ]; then
    base="$(fapi_host_from_publishable_key "$SMOKE_CLERK_PUBLISHABLE_KEY")"
  else
    key="$(scrape_publishable_key)"
    [ -n "$key" ] && base="$(fapi_host_from_publishable_key "$key")"
  fi
  [ -z "$base" ] && { printf ''; return 0; }
  case "$base" in
    http://* | https://*) ;;
    *) base="$SMOKE_CLERK_FAPI_SCHEME://$base" ;;
  esac
  printf '%s' "${base%/}"
}

# Extract a JSON string field (first match) from stdin: jq, grep/sed fallback.
extract_json_string() {
  local field="$1"
  if command -v jq >/dev/null 2>&1; then
    jq -r "[.. | objects | .${field}? // empty] | first // empty" 2>/dev/null
  else
    grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" |
      sed -E "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/" |
      head -n1
  fi
}

check_demo_seed_resolution() {
  if [ "$SMOKE_SKIP_SEED_CHECK" = "1" ]; then
    log "SKIP demo seed resolution (SMOKE_SKIP_SEED_CHECK=1) — seeded company/membership NOT verified"
    return 0
  fi
  if [ -z "$DEMO_ACCESS_CODE" ]; then
    log "SKIP demo seed resolution (DEMO_ACCESS_CODE unset — cannot mint a ticket)"
    return 0
  fi

  # 1. Mint a ticket for the NON-admin seed role.
  local mint_url="$BASE_URL/api/demo/sign-in-link" body code redirect ticket
  body="$(curl -sS -w $'\n%{http_code}' --max-time "$CURL_MAX_TIME" \
    -X POST -H 'content-type: application/json' \
    --data "{\"role\":\"$SMOKE_DEMO_SEED_ROLE\",\"accessCode\":\"$DEMO_ACCESS_CODE\"}" "$mint_url" 2>/dev/null || printf '\n')"
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$code" != "200" ]; then
    note_fail "seed resolution: mint for role '$SMOKE_DEMO_SEED_ROLE' returned HTTP ${code:-<no-response>} (expected 200 — demo user/seed regression?)"
    return 0
  fi
  redirect="$(printf '%s' "$body" | extract_json_string 'redirect_url')"
  ticket="$(printf '%s' "$redirect" | grep -o '__clerk_ticket=[^&"]*' | head -n1 | cut -d= -f2-)"
  if [ -z "$ticket" ]; then
    note_fail "seed resolution: mint response carried no __clerk_ticket (redirect_url=${redirect:-<missing>})"
    return 0
  fi

  # 2. Resolve the Clerk Frontend API base.
  local fapi
  fapi="$(resolve_clerk_fapi_base)"
  if [ -z "$fapi" ]; then
    note_fail "seed resolution: could not resolve the Clerk Frontend API base — set SMOKE_CLERK_FAPI or SMOKE_CLERK_PUBLISHABLE_KEY (scraping the SPA bundle also failed)"
    return 0
  fi

  # 3. Exchange the ticket for a session (native flow: the client JWT comes
  #    back in the `authorization` RESPONSE header; the created session id in
  #    the body).
  local headers_file exchange_body client_jwt session_id
  headers_file="$(mktemp "${TMPDIR:-/tmp}/sitelayer-smoke-clerk-hdrs.XXXXXX")"
  exchange_body="$(curl -sS -D "$headers_file" --max-time "$CURL_MAX_TIME" \
    -X POST "$fapi/v1/client/sign_ins?_is_native=1" \
    --data-urlencode 'strategy=ticket' \
    --data-urlencode "ticket=$ticket" 2>/dev/null || printf '')"
  client_jwt="$(tr -d '\r' <"$headers_file" | awk 'tolower($1) == "authorization:" { print $2; exit }')"
  rm -f "$headers_file" 2>/dev/null || true
  session_id="$(printf '%s' "$exchange_body" | extract_json_string 'created_session_id')"
  if [ -z "$client_jwt" ] || [ -z "$session_id" ]; then
    note_fail "seed resolution: Clerk ticket exchange at $fapi failed (client_jwt=${client_jwt:+set}${client_jwt:-missing} session_id=${session_id:-missing})"
    return 0
  fi

  # 4. Mint a session JWT for the API call.
  local token_body session_jwt
  token_body="$(curl -sS --max-time "$CURL_MAX_TIME" \
    -X POST "$fapi/v1/client/sessions/$session_id/tokens?_is_native=1" \
    -H "authorization: $client_jwt" 2>/dev/null || printf '')"
  session_jwt="$(printf '%s' "$token_body" | extract_json_string 'jwt')"
  if [ -z "$session_jwt" ]; then
    note_fail "seed resolution: Clerk session-token mint failed (no jwt in response)"
    return 0
  fi

  # 5. The authoritative call: /api/session runs auth + company + membership
  #    resolution (apps/api/src/routes/system.ts). A wiped company 404s; a
  #    wiped membership either 404s or resolves WITHOUT the expected
  #    seed-granted role (auto-onboard grants admin, never '$SMOKE_DEMO_SEED_EXPECT_ROLE').
  local session_url="$BASE_URL/api/session" session_body session_code matched
  session_body="$(curl -sS -w $'\n%{http_code}' --max-time "$CURL_MAX_TIME" \
    -H "authorization: Bearer $session_jwt" \
    -H "x-sitelayer-company-slug: $SMOKE_DEMO_COMPANY_SLUG" \
    "$session_url" 2>/dev/null || printf '\n')"
  session_code="${session_body##*$'\n'}"
  session_body="${session_body%$'\n'*}"
  if [ "$session_code" != "200" ]; then
    note_fail "seed resolution: /api/session as seeded '$SMOKE_DEMO_SEED_ROLE' returned HTTP ${session_code:-<no-response>} (company '$SMOKE_DEMO_COMPANY_SLUG' or its memberships are missing)"
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    matched="$(printf '%s' "$session_body" | jq -r --arg slug "$SMOKE_DEMO_COMPANY_SLUG" --arg role "$SMOKE_DEMO_SEED_EXPECT_ROLE" \
      '[.memberships[]? | select(.slug == $slug and .role == $role)] | length' 2>/dev/null || printf '0')"
  else
    # Degraded (no jq): require both the slug and the role to appear in the
    # memberships payload.
    if printf '%s' "$session_body" | grep -q "\"slug\"[[:space:]]*:[[:space:]]*\"$SMOKE_DEMO_COMPANY_SLUG\"" &&
      printf '%s' "$session_body" | grep -q "\"role\"[[:space:]]*:[[:space:]]*\"$SMOKE_DEMO_SEED_EXPECT_ROLE\""; then
      matched=1
    else
      matched=0
    fi
  fi
  if [ "${matched:-0}" -ge 1 ] 2>/dev/null; then
    log "OK  demo seed resolution: '$SMOKE_DEMO_COMPANY_SLUG' membership resolved with role '$SMOKE_DEMO_SEED_EXPECT_ROLE'"
  else
    note_fail "seed resolution: /api/session 200 but NO '$SMOKE_DEMO_COMPANY_SLUG' membership with role '$SMOKE_DEMO_SEED_EXPECT_ROLE' (seed regression — auto-onboard masking or memberships wiped)"
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
    check_demo_seed_resolution
  fi

  if [ "$FAILURES" -gt 0 ]; then
    fail "$FAILURES check(s) failed"
    exit 1
  fi
  log "all checks passed"
}

main
