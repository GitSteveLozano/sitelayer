#!/usr/bin/env bash
#
# Sitelayer fleet-side auto-deploy watcher — poll-once.
#
# Restores "merge to dev -> it's live in ~2min" WITHOUT GitHub Actions. Designed
# to be fired every ~2min by a user-level systemd timer
# (ops/systemd/sitelayer-auto-deploy.timer). Each run:
#
#   1. Refreshes a DEDICATED deploy checkout (never the operator's working tree).
#   2. For each managed tier (default: dev demo), compares the remote tip of that
#      tier's tracked branch (default: dev) against the tier's LIVE build_sha
#      reported by GET https://<host>/api/version.
#   3. If they differ, checks out the desired SHA in the dedicated repo and runs
#      `scripts/deploy.sh <tier>` from there.
#
# LOCAL QUALITY GATE (2026-06-02): the single verification authority is
# `scripts/verify-local.sh` (`npm run verify`), which replaced quality.yml — no
# GitHub Actions in the path. The gate runs at LAND time (before pushing to
# main/dev) and on every MANUAL `scripts/deploy.sh` (the operator's checkout has
# node_modules). This watcher ships an ALREADY-GATED origin/dev SHA, so it passes
# SKIP_VERIFY=1 below — its dedicated checkout has no node_modules to run the
# gate, and re-gating an already-gated SHA is redundant. To re-gate here instead,
# `npm ci` in AUTODEPLOY_REPO_DIR (ensure node/npm on the unit PATH) and drop the
# SKIP_VERIFY=1.
#
# LAND-TIME GATING IS NOW ENFORCED (2026-06-02): the SKIP_VERIFY=1 premise above
# — "the SHA was already gated at land time" — is no longer an unenforced
# assumption. The repo-tracked pre-push hook (`.githooks/pre-push`, installed via
# `scripts/install-git-hooks.sh` → core.hooksPath) runs the STANDARD gate
# (`npm run verify`) and BLOCKS any push to dev/main that fails it (bypass: the
# standard `git push --no-verify`). So the SHA this watcher picks up off
# origin/dev has actually passed the deterministic gate at land time.
#
# POST-DEPLOY SMOKE (detection, NOT a gate): after a SUCCESSFUL dev/demo deploy
# this watcher runs `scripts/smoke-tier.sh <host> <sha>` against the live host to
# confirm the freshly shipped SHA is actually serving (/health, /api/version SHA
# match, /api/session, /api/bootstrap, and the demo sign-in-link mint). A smoke
# FAILURE is logged LOUDLY and recorded, but does NOT crash the watcher or mark
# the deploy failed — the deploy already happened; the smoke only surfaces drift.
#
# SAFETY MODEL (read before changing anything):
#   - NEVER deploys prod. A tier literally named 'prod' is refused.
#   - Kill switch: `~/.cache/sitelayer-autodeploy/PAUSED` (or AUTODEPLOY_PAUSED=1)
#     => log "paused" and exit 0.
#   - Failed-sha backoff: a SHA that failed to deploy is recorded per tier; we
#     skip it until the remote tip moves, so a broken commit can't retry-storm.
#   - Concurrency: the whole run holds a non-blocking flock; a second invocation
#     while one is in flight exits 0 immediately.
#   - Exit code is non-zero ONLY on this watcher's own internal error, never on a
#     tier simply being already-current (the normal idle case).
#
# Everything below is env-overridable so the watcher is testable in isolation.
#
set -euo pipefail

# ---- Configuration (all overridable) ---------------------------------------
AUTODEPLOY_HOME="${AUTODEPLOY_HOME:-$HOME/.cache/sitelayer-autodeploy}"
AUTODEPLOY_REPO_DIR="${AUTODEPLOY_REPO_DIR:-$AUTODEPLOY_HOME/repo}"
AUTODEPLOY_STATE_FILE="${AUTODEPLOY_STATE_FILE:-$AUTODEPLOY_HOME/state}"
AUTODEPLOY_LOG_FILE="${AUTODEPLOY_LOG_FILE:-$AUTODEPLOY_HOME/auto-deploy.log}"
AUTODEPLOY_LOCK_FILE="${AUTODEPLOY_LOCK_FILE:-/tmp/sitelayer-autodeploy.lock}"
AUTODEPLOY_PAUSED_FILE="${AUTODEPLOY_PAUSED_FILE:-$AUTODEPLOY_HOME/PAUSED}"
AUTODEPLOY_REMOTE_URL="${AUTODEPLOY_REMOTE_URL:-https://github.com/GitSteveLozano/sitelayer.git}"

# Tiers this watcher manages (space-separated). prod is rejected by design.
AUTODEPLOY_TIERS="${AUTODEPLOY_TIERS:-dev demo}"

# Per-tier tracked branch. Both dev and demo track the dev branch today; override
# per tier with AUTODEPLOY_BRANCH_<TIER> (e.g. AUTODEPLOY_BRANCH_DEMO=main).
AUTODEPLOY_DEFAULT_BRANCH="${AUTODEPLOY_DEFAULT_BRANCH:-dev}"

# Per-tier live host. Override with AUTODEPLOY_HOST_<TIER> if a host moves.
AUTODEPLOY_HOST_DEV="${AUTODEPLOY_HOST_DEV:-dev.sitelayer.sandolab.xyz}"
AUTODEPLOY_HOST_DEMO="${AUTODEPLOY_HOST_DEMO:-demo.preview.sitelayer.sandolab.xyz}"

CURL_MAX_TIME="${AUTODEPLOY_CURL_MAX_TIME:-15}"
# How many hex chars to compare on (short-sha prefix). git's default short is 7+.
SHA_COMPARE_LEN="${AUTODEPLOY_SHA_COMPARE_LEN:-7}"

# Post-deploy smoke. Run after a SUCCESSFUL dev/demo deploy to confirm the
# shipped SHA is actually serving. AUTODEPLOY_SMOKE=0 disables it; AUTODEPLOY_
# SMOKE_SCRIPT overrides the smoke entrypoint (defaults to the one shipped in
# this checkout). DEMO smoke can mint a sign-in-link when AUTODEPLOY_DEMO_ACCESS
# _CODE is set (otherwise that one check skips gracefully).
AUTODEPLOY_SMOKE="${AUTODEPLOY_SMOKE:-1}"
AUTODEPLOY_SMOKE_SCRIPT="${AUTODEPLOY_SMOKE_SCRIPT:-$AUTODEPLOY_REPO_DIR/scripts/smoke-tier.sh}"
AUTODEPLOY_DEMO_ACCESS_CODE="${AUTODEPLOY_DEMO_ACCESS_CODE:-${DEMO_ACCESS_CODE:-}}"

# ---- Logging ----------------------------------------------------------------
# Structured, timestamped lines to both the log file and stdout (journald).
log() {
  local ts line
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  line="$ts auto-deploy $*"
  # Best-effort file append; never let a logging failure kill the run.
  printf '%s\n' "$line" >>"$AUTODEPLOY_LOG_FILE" 2>/dev/null || true
  printf '%s\n' "$line"
}

die() {
  log "FATAL $*"
  exit 1
}

# ---- /api/version build_sha extraction (jq, with grep/sed fallback) ---------
extract_build_sha() {
  # Reads JSON on stdin, prints build_sha (or empty).
  if command -v jq >/dev/null 2>&1; then
    jq -r '.build_sha // empty' 2>/dev/null
  else
    # Fallback: pull the build_sha string value out of the JSON with grep/sed.
    # Matches  "build_sha":"<value>"  tolerating optional whitespace.
    grep -o '"build_sha"[[:space:]]*:[[:space:]]*"[^"]*"' |
      sed -E 's/.*"build_sha"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/' |
      head -n1
  fi
}

live_sha_for_host() {
  # Best-effort; prints empty on any failure (treated as "unknown" -> deploy).
  local host="$1" body
  body="$(curl -fsS --max-time "$CURL_MAX_TIME" "https://$host/api/version" 2>/dev/null || true)"
  [ -n "$body" ] || { printf ''; return 0; }
  printf '%s' "$body" | extract_build_sha
}

# ---- Per-tier env lookups ---------------------------------------------------
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

branch_for_tier() {
  local tier="$1" var
  var="AUTODEPLOY_BRANCH_$(upper "$tier")"
  printf '%s' "${!var:-$AUTODEPLOY_DEFAULT_BRANCH}"
}

host_for_tier() {
  local tier="$1" var
  var="AUTODEPLOY_HOST_$(upper "$tier")"
  if [ -n "${!var:-}" ]; then
    printf '%s' "${!var}"
    return 0
  fi
  return 1
}

# ---- Failed-sha state (one "tier sha" line per failed tier) -----------------
# State file format: lines of "<tier> <full-sha>". Only failed shas are stored.
failed_sha_for_tier() {
  local tier="$1"
  [ -f "$AUTODEPLOY_STATE_FILE" ] || { printf ''; return 0; }
  awk -v t="$tier" '$1 == t { print $2; exit }' "$AUTODEPLOY_STATE_FILE" 2>/dev/null || printf ''
}

set_failed_sha() {
  local tier="$1" sha="$2" tmp
  tmp="$(mktemp "${AUTODEPLOY_STATE_FILE}.XXXXXX")"
  # Drop any prior line for this tier, then append the new failure.
  if [ -f "$AUTODEPLOY_STATE_FILE" ]; then
    awk -v t="$tier" '$1 != t' "$AUTODEPLOY_STATE_FILE" >"$tmp" 2>/dev/null || true
  fi
  printf '%s %s\n' "$tier" "$sha" >>"$tmp"
  mv -f "$tmp" "$AUTODEPLOY_STATE_FILE"
}

clear_failed_sha() {
  local tier="$1" tmp
  [ -f "$AUTODEPLOY_STATE_FILE" ] || return 0
  tmp="$(mktemp "${AUTODEPLOY_STATE_FILE}.XXXXXX")"
  awk -v t="$tier" '$1 != t' "$AUTODEPLOY_STATE_FILE" >"$tmp" 2>/dev/null || true
  mv -f "$tmp" "$AUTODEPLOY_STATE_FILE"
}

# ---- Dedicated deploy checkout ----------------------------------------------
ensure_repo() {
  if [ -d "$AUTODEPLOY_REPO_DIR/.git" ]; then
    git -C "$AUTODEPLOY_REPO_DIR" remote set-url origin "$AUTODEPLOY_REMOTE_URL"
    git -C "$AUTODEPLOY_REPO_DIR" fetch --prune --quiet origin || die "git fetch failed in $AUTODEPLOY_REPO_DIR"
  else
    mkdir -p "$(dirname "$AUTODEPLOY_REPO_DIR")"
    log "clone $AUTODEPLOY_REMOTE_URL -> $AUTODEPLOY_REPO_DIR"
    git clone --quiet "$AUTODEPLOY_REMOTE_URL" "$AUTODEPLOY_REPO_DIR" || die "git clone failed"
  fi
}

desired_sha_for_branch() {
  # Authoritative desired SHA = remote tip of the tier's tracked branch.
  local branch="$1" out
  out="$(git -C "$AUTODEPLOY_REPO_DIR" ls-remote origin "refs/heads/$branch" 2>/dev/null | awk 'NR==1{print $1}')"
  printf '%s' "$out"
}

short() { printf '%s' "${1:0:$SHA_COMPARE_LEN}"; }

# ---- Post-deploy smoke (detection only; never crashes the watcher) ----------
# Runs scripts/smoke-tier.sh against the live host after a successful deploy.
# A smoke failure is logged LOUDLY and recorded as a smoke-failure marker, but
# returns 0 so the caller never treats it as a deploy failure (the deploy
# already happened — this only surfaces drift). Best-effort throughout.
run_post_deploy_smoke() {
  local tier="$1" host="$2" sha="$3"

  if [ "$AUTODEPLOY_SMOKE" != "1" ]; then
    log "SMOKE-SKIP tier=$tier (AUTODEPLOY_SMOKE=$AUTODEPLOY_SMOKE)"
    return 0
  fi
  if [ ! -f "$AUTODEPLOY_SMOKE_SCRIPT" ]; then
    log "SMOKE-SKIP tier=$tier smoke script not found at $AUTODEPLOY_SMOKE_SCRIPT"
    return 0
  fi

  log "SMOKE tier=$tier host=$host sha=$(short "$sha") — running post-deploy smoke"
  if ( DEMO_ACCESS_CODE="$AUTODEPLOY_DEMO_ACCESS_CODE" SMOKE_CURL_MAX_TIME="$CURL_MAX_TIME" \
       SMOKE_SHA_COMPARE_LEN="$SHA_COMPARE_LEN" \
       bash "$AUTODEPLOY_SMOKE_SCRIPT" "$host" "$sha" ) >>"$AUTODEPLOY_LOG_FILE" 2>&1; then
    log "SMOKE-OK tier=$tier host=$host sha=$(short "$sha")"
  else
    # LOUD, but non-fatal: the deploy already shipped. Record a smoke marker so
    # the failure is visible in state without blocking future deploys.
    log "############################################################"
    log "## SMOKE-FAILED tier=$tier host=$host sha=$(short "$sha")"
    log "## The deploy SHIPPED but post-deploy smoke did NOT pass."
    log "## This is DETECTION — investigate $host (see $AUTODEPLOY_LOG_FILE)."
    log "############################################################"
    set_smoke_failure "$tier" "$sha"
  fi
  return 0
}

# Record a per-tier smoke-failure marker in the state file (separate namespace
# from the deploy failed-sha lines: "<tier>:smoke <sha>"). Best-effort; a write
# failure here must never break the watcher.
set_smoke_failure() {
  local tier="$1" sha="$2" key tmp
  key="${tier}:smoke"
  tmp="$(mktemp "${AUTODEPLOY_STATE_FILE}.XXXXXX")" || return 0
  if [ -f "$AUTODEPLOY_STATE_FILE" ]; then
    awk -v k="$key" '$1 != k' "$AUTODEPLOY_STATE_FILE" >"$tmp" 2>/dev/null || true
  fi
  printf '%s %s\n' "$key" "$sha" >>"$tmp"
  mv -f "$tmp" "$AUTODEPLOY_STATE_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

# ---- Deploy one tier --------------------------------------------------------
deploy_tier() {
  local tier="$1"

  if [ "$tier" = "prod" ]; then
    log "REFUSE tier=prod — auto-deploy never touches production; skipping"
    return 0
  fi

  local host branch desired failed live
  if ! host="$(host_for_tier "$tier")"; then
    log "ERROR tier=$tier has no host mapping (set AUTODEPLOY_HOST_$(upper "$tier")); skipping"
    return 0
  fi
  branch="$(branch_for_tier "$tier")"

  desired="$(desired_sha_for_branch "$branch")"
  if [ -z "$desired" ]; then
    log "ERROR tier=$tier could not resolve remote tip of branch=$branch; skipping"
    return 0
  fi

  failed="$(failed_sha_for_tier "$tier")"
  if [ -n "$failed" ] && [ "$failed" = "$desired" ]; then
    log "SKIP tier=$tier desired=$(short "$desired") matches last-failed sha (backoff; waiting for remote to advance)"
    return 0
  fi

  live="$(live_sha_for_host "$host")"
  if [ -z "$live" ]; then
    log "WARN tier=$tier host=$host live build_sha unknown (treating as out-of-date)"
  fi

  if [ -n "$live" ] && [ "$(short "$desired")" = "$(short "$live")" ]; then
    log "OK tier=$tier branch=$branch current=$(short "$live") (no deploy)"
    return 0
  fi

  log "DEPLOY tier=$tier branch=$branch live=$(short "${live:-none}") -> desired=$(short "$desired")"

  # Check out the desired SHA in the DEDICATED repo (never the operator's tree).
  if ! git -C "$AUTODEPLOY_REPO_DIR" checkout --quiet --force --detach "$desired" 2>>"$AUTODEPLOY_LOG_FILE"; then
    log "ERROR tier=$tier checkout of $(short "$desired") failed; recording failed-sha"
    set_failed_sha "$tier" "$desired"
    return 0
  fi
  git -C "$AUTODEPLOY_REPO_DIR" clean -fdq || true

  # Run the existing deploy entrypoint from the dedicated checkout. SKIP_VERIFY=1:
  # the SHA is already gated at land time and this checkout has no node_modules
  # (see the LOCAL QUALITY GATE note in the header).
  if ( cd "$AUTODEPLOY_REPO_DIR" && SKIP_VERIFY=1 bash scripts/deploy.sh "$tier" ) >>"$AUTODEPLOY_LOG_FILE" 2>&1; then
    log "SUCCESS tier=$tier deployed $(short "$desired")"
    clear_failed_sha "$tier"
    # Post-deploy smoke: confirm the shipped SHA is actually serving. Detection
    # only — never crashes the watcher or re-marks the deploy failed.
    run_post_deploy_smoke "$tier" "$host" "$desired"
  else
    log "FAILED tier=$tier deploy of $(short "$desired") returned non-zero; recording failed-sha (will skip until remote advances)"
    set_failed_sha "$tier" "$desired"
  fi
  return 0
}

# ---- Main run (under flock) -------------------------------------------------
run() {
  mkdir -p "$AUTODEPLOY_HOME"

  if [ "${AUTODEPLOY_PAUSED:-0}" = "1" ] || [ -f "$AUTODEPLOY_PAUSED_FILE" ]; then
    log "paused (AUTODEPLOY_PAUSED=${AUTODEPLOY_PAUSED:-0}, pause-file=$AUTODEPLOY_PAUSED_FILE); exiting 0"
    return 0
  fi

  ensure_repo

  local tier
  for tier in $AUTODEPLOY_TIERS; do
    deploy_tier "$tier"
  done
}

main() {
  mkdir -p "$AUTODEPLOY_HOME"
  exec 9>"$AUTODEPLOY_LOCK_FILE"
  if ! flock -n 9; then
    log "another auto-deploy run holds the lock ($AUTODEPLOY_LOCK_FILE); exiting 0"
    exit 0
  fi
  run
}

main "$@"
