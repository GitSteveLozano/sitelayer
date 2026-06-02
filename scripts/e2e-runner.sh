#!/usr/bin/env bash
#
# Sitelayer deterministic e2e runner — run-once.
#
# Stands up the full app stack + a real browser and runs the Playwright e2e
# suite (`npm run verify:full`) on a QUIET, idle box (the preview droplet
# off-hours, or a $6/mo throwaway) — NOT taylor-pc. e2e is deterministic on an
# idle machine; it flakes (browser/page-closed) on a loaded one. That is exactly
# why e2e is OPT-IN (`--full`) and NOT in the deploy gate; this runner is the
# scheduled place it actually runs. See docs/E2E_RUNNER.md.
#
# Each run:
#   1. Refreshes a DEDICATED checkout under ~/.cache/sitelayer-e2e-runner/repo
#      (clone if absent, else fetch) — never the operator's working tree.
#   2. For each watched branch (default: dev main), checks out the remote tip and
#      runs `npm run verify:full` from there.
#   3. Short-circuits a branch whose tip SHA already PASSED on a prior run
#      (recorded per branch) so a frequent/per-dev-advance timer is cheap on an
#      idle tip. A new tip always re-runs.
#   4. On FAILURE: emits a Sentry event (same envelope shape as
#      scripts/check-systemd-timers.sh) AND a Pushover push (the fleet's
#      operator-alert route), so a red e2e on dev/main is loud.
#
# SAFETY / IDLE-IS-SUCCESS:
#   - Concurrency: the whole run holds a non-blocking flock; a second invocation
#     while one is in flight exits 0 immediately.
#   - Kill switch: ~/.cache/sitelayer-e2e-runner/PAUSED (or E2E_RUNNER_PAUSED=1).
#   - This runner NEVER deploys and NEVER touches prod — it only verifies.
#   - Exit non-zero ONLY when a verify run actually FAILED (so the timer goes red
#     and journald/Sentry/Pushover carry the signal). A branch already-passed or
#     simply up-to-date is a clean exit 0.
#
# Everything below is env-overridable so the runner is testable in isolation.
#
set -euo pipefail

# ---- Configuration (all overridable) ---------------------------------------
E2E_RUNNER_HOME="${E2E_RUNNER_HOME:-$HOME/.cache/sitelayer-e2e-runner}"
E2E_RUNNER_REPO_DIR="${E2E_RUNNER_REPO_DIR:-$E2E_RUNNER_HOME/repo}"
E2E_RUNNER_STATE_FILE="${E2E_RUNNER_STATE_FILE:-$E2E_RUNNER_HOME/passed-shas}"
E2E_RUNNER_LOG_FILE="${E2E_RUNNER_LOG_FILE:-$E2E_RUNNER_HOME/e2e-runner.log}"
E2E_RUNNER_LOCK_FILE="${E2E_RUNNER_LOCK_FILE:-/tmp/sitelayer-e2e-runner.lock}"
E2E_RUNNER_PAUSED_FILE="${E2E_RUNNER_PAUSED_FILE:-$E2E_RUNNER_HOME/PAUSED}"
E2E_RUNNER_REMOTE_URL="${E2E_RUNNER_REMOTE_URL:-https://github.com/GitSteveLozano/sitelayer.git}"

# Branches to verify (space-separated). dev is the integration tip; main is the
# release tip. Both are deterministic to verify on an idle box.
E2E_RUNNER_BRANCHES="${E2E_RUNNER_BRANCHES:-dev main}"

# Dependency install + verify commands. install = `npm ci` by default (the
# dedicated checkout has no node_modules); override to ':' (no-op) on a box where
# deps are pre-warmed, or to a faster installer. verify:full =
# static+build+unit+integration+e2e.
E2E_RUNNER_INSTALL_CMD="${E2E_RUNNER_INSTALL_CMD:-npm ci}"
E2E_RUNNER_VERIFY_LEVEL="${E2E_RUNNER_VERIFY_LEVEL:-full}"
E2E_RUNNER_VERIFY_CMD="${E2E_RUNNER_VERIFY_CMD:-npm run verify:full}"

# Alert config. Sentry reuses the same DSN as the rest of the fleet; Pushover is
# the operator-alert route. All optional — absent creds => that channel no-ops
# (best-effort), the run still fails loudly via exit code + journald.
ENV_FILE="${ENV_FILE:-/app/sitelayer/.env}"
SENTRY_ENVIRONMENT="${SENTRY_ENVIRONMENT:-e2e-runner}"
# Pushover: PUSHOVER_TOKEN (app) + PUSHOVER_USER (user/group key). The fleet's
# other timers alert via Pushover; this mirrors that route.
PUSHOVER_API_URL="${PUSHOVER_API_URL:-https://api.pushover.net/1/messages.json}"
CURL_MAX_TIME="${E2E_RUNNER_CURL_MAX_TIME:-15}"
SHA_SHORT_LEN="${E2E_RUNNER_SHA_SHORT_LEN:-7}"

# ---- Logging ----------------------------------------------------------------
log() {
  local ts line
  ts="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  line="$ts e2e-runner $*"
  printf '%s\n' "$line" >>"$E2E_RUNNER_LOG_FILE" 2>/dev/null || true
  printf '%s\n' "$line"
}

die() {
  log "FATAL $*"
  exit 1
}

short() { printf '%s' "${1:0:$SHA_SHORT_LEN}"; }

# ---- Read a value out of the rendered prod .env (no secrets to stdout) ------
read_env_value() {
  local key="$1" value
  [ -f "$ENV_FILE" ] || return 0
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"
  case "$value" in
    \"*\")
      value="${value#\"}"
      value="${value%\"}"
      ;;
    \'*\')
      value="${value#\'}"
      value="${value%\'}"
      ;;
  esac
  printf '%s' "$value"
}

# ---- Alerting ---------------------------------------------------------------
# Sentry: same envelope shape as scripts/check-systemd-timers.sh so the events
# land in the same project with consistent tags.
send_sentry_event() {
  local message="$1" dsn
  dsn="${SENTRY_DSN:-$(read_env_value SENTRY_DSN)}"
  [ -n "$dsn" ] || {
    log "sentry: no DSN configured; skipping"
    return 0
  }
  if ! command -v python3 >/dev/null 2>&1; then
    log "sentry: python3 not on PATH; skipping"
    return 0
  fi
  SENTRY_DSN="$dsn" \
    SENTRY_MESSAGE="$message" \
    SENTRY_ENVIRONMENT="$SENTRY_ENVIRONMENT" \
    python3 - <<'PY'
import datetime as dt
import json
import os
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

dsn = os.environ["SENTRY_DSN"]
message = os.environ["SENTRY_MESSAGE"]
environment = os.environ.get("SENTRY_ENVIRONMENT", "e2e-runner")
parsed = urllib.parse.urlparse(dsn)
project_id = parsed.path.strip("/").split("/")[-1]
if not parsed.scheme or not parsed.netloc or not project_id:
    print("WARN: invalid SENTRY_DSN; skipping e2e-runner event", file=sys.stderr)
    raise SystemExit(0)

endpoint = f"{parsed.scheme}://{parsed.netloc}/api/{project_id}/envelope/"
now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
event = {
    "event_id": secrets.token_hex(16),
    "timestamp": now,
    "level": "error",
    "platform": "other",
    "environment": environment,
    "logger": "sitelayer.e2e-runner",
    "message": message,
    "tags": {
        "service": "e2e-runner",
        "app": "sitelayer",
    },
}
body = "\n".join([
    json.dumps({"dsn": dsn, "sent_at": now}, separators=(",", ":")),
    json.dumps({"type": "event"}, separators=(",", ":")),
    json.dumps(event, separators=(",", ":")),
])
req = urllib.request.Request(
    endpoint,
    data=body.encode("utf-8"),
    headers={"Content-Type": "application/x-sentry-envelope"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=10) as response:
        response.read()
except urllib.error.URLError as exc:
    print(f"WARN: failed to send Sentry e2e-runner event: {exc}", file=sys.stderr)
PY
}

# Pushover: the fleet's operator-alert route. Best-effort; absent creds => no-op.
send_pushover() {
  local message="$1" token user
  token="${PUSHOVER_TOKEN:-$(read_env_value PUSHOVER_TOKEN)}"
  user="${PUSHOVER_USER:-$(read_env_value PUSHOVER_USER)}"
  if [ -z "$token" ] || [ -z "$user" ]; then
    log "pushover: PUSHOVER_TOKEN/PUSHOVER_USER not configured; skipping"
    return 0
  fi
  if ! command -v curl >/dev/null 2>&1; then
    log "pushover: curl not on PATH; skipping"
    return 0
  fi
  # priority=1 (high) so a red e2e on dev/main breaks through quiet hours rules.
  curl -fsS --max-time "$CURL_MAX_TIME" \
    --form-string "token=${token}" \
    --form-string "user=${user}" \
    --form-string "title=Sitelayer e2e FAILED" \
    --form-string "priority=1" \
    --form-string "message=${message}" \
    "$PUSHOVER_API_URL" >/dev/null 2>&1 ||
    log "pushover: send failed (best-effort)"
}

alert_failure() {
  local message="$1"
  log "ALERT $message"
  send_sentry_event "$message"
  send_pushover "$message"
}

# ---- Passed-SHA state (one "branch sha" line per branch) --------------------
passed_sha_for_branch() {
  local branch="$1"
  [ -f "$E2E_RUNNER_STATE_FILE" ] || {
    printf ''
    return 0
  }
  awk -v b="$branch" '$1 == b { print $2; exit }' "$E2E_RUNNER_STATE_FILE" 2>/dev/null || printf ''
}

set_passed_sha() {
  local branch="$1" sha="$2" tmp
  tmp="$(mktemp "${E2E_RUNNER_STATE_FILE}.XXXXXX")"
  if [ -f "$E2E_RUNNER_STATE_FILE" ]; then
    awk -v b="$branch" '$1 != b' "$E2E_RUNNER_STATE_FILE" >"$tmp" 2>/dev/null || true
  fi
  printf '%s %s\n' "$branch" "$sha" >>"$tmp"
  mv -f "$tmp" "$E2E_RUNNER_STATE_FILE"
}

# ---- Dedicated checkout -----------------------------------------------------
ensure_repo() {
  if [ -d "$E2E_RUNNER_REPO_DIR/.git" ]; then
    git -C "$E2E_RUNNER_REPO_DIR" remote set-url origin "$E2E_RUNNER_REMOTE_URL"
    git -C "$E2E_RUNNER_REPO_DIR" fetch --prune --quiet origin || die "git fetch failed in $E2E_RUNNER_REPO_DIR"
  else
    mkdir -p "$(dirname "$E2E_RUNNER_REPO_DIR")"
    log "clone $E2E_RUNNER_REMOTE_URL -> $E2E_RUNNER_REPO_DIR"
    git clone --quiet "$E2E_RUNNER_REMOTE_URL" "$E2E_RUNNER_REPO_DIR" || die "git clone failed"
  fi
}

remote_tip() {
  local branch="$1" out
  out="$(git -C "$E2E_RUNNER_REPO_DIR" ls-remote origin "refs/heads/$branch" 2>/dev/null | awk 'NR==1{print $1}')"
  printf '%s' "$out"
}

# ---- Verify one branch ------------------------------------------------------
# Returns 0 if the branch is OK (passed now, or already-passed/up-to-date),
# 1 if a verify run FAILED.
verify_branch() {
  local branch="$1" desired passed rc=0

  desired="$(remote_tip "$branch")"
  if [ -z "$desired" ]; then
    log "WARN branch=$branch could not resolve remote tip; skipping"
    return 0
  fi

  passed="$(passed_sha_for_branch "$branch")"
  if [ -n "$passed" ] && [ "$passed" = "$desired" ]; then
    log "SKIP branch=$branch tip=$(short "$desired") already passed verify:$E2E_RUNNER_VERIFY_LEVEL"
    return 0
  fi

  log "VERIFY branch=$branch tip=$(short "$desired") level=$E2E_RUNNER_VERIFY_LEVEL"

  if ! git -C "$E2E_RUNNER_REPO_DIR" checkout --quiet --force --detach "$desired" 2>>"$E2E_RUNNER_LOG_FILE"; then
    log "ERROR branch=$branch checkout of $(short "$desired") failed"
    alert_failure "e2e-runner: checkout of $branch@$(short "$desired") failed"
    return 1
  fi
  git -C "$E2E_RUNNER_REPO_DIR" clean -fdq || true

  # Install deps in the dedicated checkout (verify:full needs node_modules).
  log "  install deps ($E2E_RUNNER_INSTALL_CMD)"
  if ! (cd "$E2E_RUNNER_REPO_DIR" && $E2E_RUNNER_INSTALL_CMD) >>"$E2E_RUNNER_LOG_FILE" 2>&1; then
    log "ERROR branch=$branch dependency install failed"
    alert_failure "e2e-runner: dependency install failed for $branch@$(short "$desired")"
    return 1
  fi

  log "  $E2E_RUNNER_VERIFY_CMD"
  if (cd "$E2E_RUNNER_REPO_DIR" && VERIFY_LEVEL="$E2E_RUNNER_VERIFY_LEVEL" $E2E_RUNNER_VERIFY_CMD) >>"$E2E_RUNNER_LOG_FILE" 2>&1; then
    log "PASS branch=$branch tip=$(short "$desired") verify:$E2E_RUNNER_VERIFY_LEVEL"
    set_passed_sha "$branch" "$desired"
    return 0
  fi

  rc=1
  log "FAIL branch=$branch tip=$(short "$desired") verify:$E2E_RUNNER_VERIFY_LEVEL — see $E2E_RUNNER_LOG_FILE"
  alert_failure "e2e-runner: verify:$E2E_RUNNER_VERIFY_LEVEL FAILED on $branch@$(short "$desired")"
  return "$rc"
}

# ---- Main run (under flock) -------------------------------------------------
run() {
  mkdir -p "$E2E_RUNNER_HOME"

  if [ "${E2E_RUNNER_PAUSED:-0}" = "1" ] || [ -f "$E2E_RUNNER_PAUSED_FILE" ]; then
    log "paused (E2E_RUNNER_PAUSED=${E2E_RUNNER_PAUSED:-0}, pause-file=$E2E_RUNNER_PAUSED_FILE); exiting 0"
    return 0
  fi

  ensure_repo

  local branch any_fail=0
  for branch in $E2E_RUNNER_BRANCHES; do
    if ! verify_branch "$branch"; then
      any_fail=1
    fi
  done

  if [ "$any_fail" -ne 0 ]; then
    return 1
  fi
  return 0
}

main() {
  mkdir -p "$E2E_RUNNER_HOME"
  exec 9>"$E2E_RUNNER_LOCK_FILE"
  if ! flock -n 9; then
    log "another e2e-runner run holds the lock ($E2E_RUNNER_LOCK_FILE); exiting 0"
    exit 0
  fi
  run
}

main "$@"
