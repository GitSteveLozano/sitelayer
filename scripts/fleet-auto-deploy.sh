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
#      tier's tracked branch (dev->`dev`, demo->`main`) against the tier's LIVE
#      build_sha reported by GET https://<host>/api/version.
#   3. If they differ, checks out the desired SHA in the dedicated repo and runs
#      `scripts/deploy.sh <tier>` from there.
#
# DEMO TRACKS MAIN (2026-06-02): demo is the PROSPECT-FACING line and now
# fast-follows `main` (the promoted/stable line), NOT `dev` (the agent
# churn/integration line). dev still tracks `dev`. This keeps prospects off the
# raw churn. See AUTODEPLOY_BRANCH_DEMO below + docs/AUTO_DEPLOY.md /
# docs/RELEASE_GATES.md for the full promotion model.
#
# INSTALLED-COPY NOTE: this committed script is the SOURCE OF TRUTH. The systemd
# unit runs it directly from the operator's checkout
# (~/projects/sitelayer/scripts/fleet-auto-deploy.sh). If the operator ALSO keeps
# a convenience copy on $PATH (e.g. ~/.local/bin/fleet-auto-deploy.sh), that copy
# is a stale snapshot and must be RE-COPIED after this change so the installed
# copy also tracks `main` for demo:
#   cp scripts/fleet-auto-deploy.sh ~/.local/bin/fleet-auto-deploy.sh
#
# LOCAL QUALITY GATE (2026-06-02): the single verification authority is
# `scripts/verify-local.sh` (`npm run verify`), which replaced quality.yml — no
# GitHub Actions in the path. The gate runs at LAND time (before pushing to
# main/dev) and on every MANUAL `scripts/deploy.sh` (the operator's checkout has
# node_modules). This watcher ships an ALREADY-GATED origin/dev SHA, so it passes
# SKIP_VERIFY=1 to deploy.sh by default — its dedicated checkout has no
# node_modules to run the gate, and re-gating an already-gated SHA is redundant.
#
# WHY SKIP_VERIFY=1 IS SAFE HERE (the land-time gate is now ENFORCED + AUTO-INSTALLED):
#   1. The repo-tracked pre-push hook (`.githooks/pre-push`) runs the STANDARD
#      gate (`npm run verify`) and BLOCKS any push to dev/main that fails it
#      (bypass: the explicit `git push --no-verify`).
#   2. The hook is installed AUTOMATICALLY: root package.json's `prepare` script
#      runs `scripts/install-git-hooks.sh` on every `npm install`, so a fresh
#      clone is gated by default (core.hooksPath = .githooks). It is no longer a
#      manual per-clone step that an operator can forget.
#   So the SHA this watcher picks up off origin/dev has actually passed the
#   deterministic gate at land time — the SKIP_VERIFY=1 premise is enforced by
#   construction, not by trust.
#
# OPT-IN INLINE RE-GATE (defense in depth): set AUTODEPLOY_INLINE_VERIFY=1 to run
# `npm run verify` (level AUTODEPLOY_VERIFY_LEVEL, default `fast`) in the
# dedicated checkout BEFORE shipping — catching the `--no-verify`-bypassed push
# or a divergent hook config. This requires node + npm on the unit PATH and a
# one-time `npm ci` in AUTODEPLOY_REPO_DIR; the watcher runs `npm ci` itself when
# node_modules is absent. Off by default to keep the 2-min poll fast.
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

# Repo remote URL (SITELAYER_REPO_URL) — shared convention with deploy.sh /
# deploy-production-local.sh / e2e-runner.sh. Exported by the lib, so the
# deploy.sh this watcher runs in its dedicated checkout resolves the SAME
# remote. May carry a deploy token: never log it raw (use
# sitelayer_repo_url_redacted).
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/repo-remote.sh"

# ---- Configuration (all overridable) ---------------------------------------
AUTODEPLOY_HOME="${AUTODEPLOY_HOME:-$HOME/.cache/sitelayer-autodeploy}"
AUTODEPLOY_REPO_DIR="${AUTODEPLOY_REPO_DIR:-$AUTODEPLOY_HOME/repo}"
AUTODEPLOY_STATE_FILE="${AUTODEPLOY_STATE_FILE:-$AUTODEPLOY_HOME/state}"
AUTODEPLOY_LOG_FILE="${AUTODEPLOY_LOG_FILE:-$AUTODEPLOY_HOME/auto-deploy.log}"
AUTODEPLOY_LOCK_FILE="${AUTODEPLOY_LOCK_FILE:-/tmp/sitelayer-autodeploy.lock}"
AUTODEPLOY_PAUSED_FILE="${AUTODEPLOY_PAUSED_FILE:-$AUTODEPLOY_HOME/PAUSED}"
# Remote to clone/fetch the dedicated deploy checkout from. This MUST use the
# SAME transport as the droplet-side checkout that scripts/deploy.sh's heredoc
# refreshes — both now resolve from the shared SITELAYER_REPO_URL
# (scripts/repo-remote.sh), which is exported, so the deploy.sh this watcher
# invokes passes the identical URL through to the droplet: the two sides
# cannot silently diverge. To change the remote everywhere (e.g. a
# token-bearing https URL or SSH deploy-key form after the private cutover),
# set SITELAYER_REPO_URL on the systemd unit. AUTODEPLOY_REMOTE_URL remains a
# watcher-local fetch override for isolated testing only.
AUTODEPLOY_REMOTE_URL="${AUTODEPLOY_REMOTE_URL:-$SITELAYER_REPO_URL}"

# Tiers this watcher manages (space-separated). prod is rejected by design.
AUTODEPLOY_TIERS="${AUTODEPLOY_TIERS:-dev demo}"

# Per-tier tracked branch. dev tracks the `dev` branch (the agent churn /
# integration line); demo tracks `main` (the PROMOTED / stable line) so
# prospects never see raw agent churn — the dev->main promotion is a deliberate
# gated step (pre-push standard gate + post-deploy smoke). See the PROMOTION
# MODEL note below and docs/AUTO_DEPLOY.md / docs/RELEASE_GATES.md.
#
# The default branch (for any tier WITHOUT an explicit override) stays `dev`.
# Each tier may override with AUTODEPLOY_BRANCH_<TIER>; demo's default is `main`.
AUTODEPLOY_DEFAULT_BRANCH="${AUTODEPLOY_DEFAULT_BRANCH:-dev}"

# Per-tier tracked-branch defaults (overridable). demo fast-follows `main` (the
# promoted/stable line), NOT `dev` (the churn line). Override with
# AUTODEPLOY_BRANCH_DEMO=<branch> if you ever need demo to track something else.
#
# PROMOTION MODEL:
#   dev  = agent churn / integration line: auto-everything, ephemeral previews,
#          a free playground. dev tracks `dev`.
#   main = the PROMOTED line: gated by the pre-push standard gate
#          (.githooks/pre-push -> `npm run verify`) at land time and confirmed by
#          the post-deploy smoke. The dev->main promotion is a deliberate gated
#          step (the operator / the gate promotes when dev is good).
#   demo + prod deploy from `main`, so prospects + customers stay OFF the raw
#   churn while dev remains a free playground.
AUTODEPLOY_BRANCH_DEMO="${AUTODEPLOY_BRANCH_DEMO:-main}"

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

# Post-deploy authenticated-MOUNT synthetic (gap #8). Runs AFTER the JSON smoke
# to confirm a few authenticated screens actually RENDER (catching a "blind
# port" the JSON-only smoke ships at HTTP 200). Detection only — never crashes
# the watcher or re-marks the deploy failed. Needs node + a Playwright chromium
# in the dedicated checkout; SKIPS gracefully when absent. AUTODEPLOY_SYNTHETIC=0
# disables it; the script defaults SYNTHETIC_ENABLED so the dedicated checkout
# (no browser/node_modules by default) skips rather than fails.
AUTODEPLOY_SYNTHETIC="${AUTODEPLOY_SYNTHETIC:-1}"
AUTODEPLOY_SYNTHETIC_SCRIPT="${AUTODEPLOY_SYNTHETIC_SCRIPT:-$AUTODEPLOY_REPO_DIR/scripts/render-synthetic.sh}"

# Opt-in inline re-gate (defense in depth on top of the enforced land-time hook).
# When AUTODEPLOY_INLINE_VERIFY=1, the watcher runs `npm run verify` (level
# AUTODEPLOY_VERIFY_LEVEL, default `fast`) in the dedicated checkout BEFORE
# calling deploy.sh — catching a `git push --no-verify` bypass or a checkout that
# never had the hook installed. Requires node + npm on the unit PATH; the watcher
# `npm ci`s the dedicated checkout when node_modules is absent. Off by default so
# the 2-min poll stays fast and the SKIP_VERIFY=1 fast-path is preserved.
AUTODEPLOY_INLINE_VERIFY="${AUTODEPLOY_INLINE_VERIFY:-0}"
AUTODEPLOY_VERIFY_LEVEL="${AUTODEPLOY_VERIFY_LEVEL:-fast}"

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
    log "clone $(sitelayer_repo_url_redacted "$AUTODEPLOY_REMOTE_URL") -> $AUTODEPLOY_REPO_DIR"
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

# ---- Post-deploy authenticated-mount synthetic (detection only) -------------
# Runs scripts/render-synthetic.sh against the live host after a successful
# deploy + smoke. It mounts a few AUTHENTICATED screens in a headless browser
# and asserts they render (no root error boundary / not blank) — the render
# check the JSON-only smoke is blind to (gap #8). Best-effort + non-fatal: a
# missing browser/node SKIPS gracefully (the script returns 0), and a real
# render failure is logged LOUDLY + recorded but never crashes the watcher (the
# deploy already happened). Returns 0 always.
run_post_deploy_synthetic() {
  local tier="$1" host="$2" sha="$3"

  if [ "$AUTODEPLOY_SYNTHETIC" != "1" ]; then
    log "SYNTHETIC-SKIP tier=$tier (AUTODEPLOY_SYNTHETIC=$AUTODEPLOY_SYNTHETIC)"
    return 0
  fi
  if [ ! -f "$AUTODEPLOY_SYNTHETIC_SCRIPT" ]; then
    log "SYNTHETIC-SKIP tier=$tier synthetic script not found at $AUTODEPLOY_SYNTHETIC_SCRIPT"
    return 0
  fi

  log "SYNTHETIC tier=$tier host=$host sha=$(short "$sha") — mounting authenticated screens"
  if ( bash "$AUTODEPLOY_SYNTHETIC_SCRIPT" "$host" ) >>"$AUTODEPLOY_LOG_FILE" 2>&1; then
    log "SYNTHETIC-OK tier=$tier host=$host sha=$(short "$sha")"
  else
    log "############################################################"
    log "## SYNTHETIC-FAILED tier=$tier host=$host sha=$(short "$sha")"
    log "## A screen did NOT render (root error boundary / blank page)."
    log "## This is DETECTION — investigate $host (see $AUTODEPLOY_LOG_FILE)."
    log "############################################################"
    set_smoke_failure "${tier}-synthetic" "$sha"
  fi
  return 0
}

# ---- Opt-in inline re-gate --------------------------------------------------
# Run `npm run verify` (level AUTODEPLOY_VERIFY_LEVEL) in the dedicated checkout
# BEFORE shipping. Returns 0 = passed (or disabled), non-zero = the gate FAILED
# (caller treats it as a deploy failure and records the failed-sha so the broken
# SHA can't retry-storm). Requires node + npm on the PATH; `npm ci`s the checkout
# if node_modules is absent. Off by default (AUTODEPLOY_INLINE_VERIFY=0).
inline_verify() {
  local tier="$1" sha="$2"

  if [ "$AUTODEPLOY_INLINE_VERIFY" != "1" ]; then
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    log "INLINE-VERIFY-SKIP tier=$tier npm not on PATH (set AUTODEPLOY_INLINE_VERIFY=0 or add npm); shipping on the enforced land-time gate"
    return 0
  fi

  if [ ! -d "$AUTODEPLOY_REPO_DIR/node_modules" ]; then
    log "INLINE-VERIFY tier=$tier installing deps (npm ci) in dedicated checkout"
    if ! ( cd "$AUTODEPLOY_REPO_DIR" && SITELAYER_SKIP_HOOKS=1 npm ci ) >>"$AUTODEPLOY_LOG_FILE" 2>&1; then
      log "INLINE-VERIFY-SKIP tier=$tier npm ci failed; shipping on the enforced land-time gate (see $AUTODEPLOY_LOG_FILE)"
      return 0
    fi
  fi

  log "INLINE-VERIFY tier=$tier sha=$(short "$sha") level=$AUTODEPLOY_VERIFY_LEVEL — re-gating before ship"
  if ( cd "$AUTODEPLOY_REPO_DIR" && VERIFY_LEVEL="$AUTODEPLOY_VERIFY_LEVEL" bash scripts/verify-local.sh ) >>"$AUTODEPLOY_LOG_FILE" 2>&1; then
    log "INLINE-VERIFY-OK tier=$tier sha=$(short "$sha")"
    return 0
  fi
  log "############################################################"
  log "## INLINE-VERIFY-FAILED tier=$tier sha=$(short "$sha")"
  log "## The desired SHA did NOT pass the inline gate (a --no-verify bypass"
  log "## or a checkout missing the pre-push hook). NOT shipping $tier."
  log "############################################################"
  return 1
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

  # Defense-in-depth re-gate (opt-in). On the enforced land-time gate this is a
  # no-op; when AUTODEPLOY_INLINE_VERIFY=1 it runs the gate against the
  # just-checked-out SHA and refuses to ship a SHA that fails (recording the
  # failed-sha so it can't retry-storm until the remote advances).
  if ! inline_verify "$tier" "$desired"; then
    set_failed_sha "$tier" "$desired"
    return 0
  fi

  # Run the existing deploy entrypoint from the dedicated checkout. SKIP_VERIFY=1:
  # the SHA is already gated at land time (the pre-push hook is auto-installed by
  # root package.json's `prepare`) and this checkout has no node_modules — see the
  # LOCAL QUALITY GATE note in the header. Set AUTODEPLOY_INLINE_VERIFY=1 to also
  # re-gate here (the check just above).
  if ( cd "$AUTODEPLOY_REPO_DIR" && SKIP_VERIFY=1 bash scripts/deploy.sh "$tier" ) >>"$AUTODEPLOY_LOG_FILE" 2>&1; then
    log "SUCCESS tier=$tier deployed $(short "$desired")"
    clear_failed_sha "$tier"
    # Post-deploy smoke: confirm the shipped SHA is actually serving. Detection
    # only — never crashes the watcher or re-marks the deploy failed.
    run_post_deploy_smoke "$tier" "$host" "$desired"
    # Post-deploy authenticated-mount synthetic: confirm a few authenticated
    # screens actually RENDER (the render check the JSON smoke is blind to).
    # Detection only — same non-fatal posture as the smoke.
    run_post_deploy_synthetic "$tier" "$host" "$desired"
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
