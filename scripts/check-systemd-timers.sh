#!/usr/bin/env bash
# Check backup/restore systemd timers and send a Sentry event on failure.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/app/sitelayer/.env}"
TIMER_MONITOR_SPECS="${TIMER_MONITOR_SPECS:-sitelayer-postgres-backup.service:129600 sitelayer-postgres-offsite.service:129600 sitelayer-blueprint-backup.service:129600 sitelayer-restore-drill.service:691200}"
SENTRY_ENVIRONMENT="${SENTRY_ENVIRONMENT:-production}"

read_env_value() {
  local key="$1"
  local value

  if [ ! -f "$ENV_FILE" ]; then
    return 0
  fi

  value="$(grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
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

timestamp_to_epoch() {
  local timestamp="$1"
  if [ -z "$timestamp" ] || [ "$timestamp" = "n/a" ]; then
    return 1
  fi
  date -u -d "$timestamp" +%s 2>/dev/null
}

send_sentry_event() {
  local message="$1"
  local dsn
  dsn="${SENTRY_DSN:-$(read_env_value SENTRY_DSN)}"
  if [ -z "$dsn" ]; then
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
environment = os.environ.get("SENTRY_ENVIRONMENT", "production")
parsed = urllib.parse.urlparse(dsn)
project_id = parsed.path.strip("/").split("/")[-1]
if not parsed.scheme or not parsed.netloc or not project_id:
    print("WARN: invalid SENTRY_DSN; skipping timer monitor event", file=sys.stderr)
    raise SystemExit(0)

endpoint = f"{parsed.scheme}://{parsed.netloc}/api/{project_id}/envelope/"
now = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
event = {
    "event_id": secrets.token_hex(16),
    "timestamp": now,
    "level": "error",
    "platform": "other",
    "environment": environment,
    "logger": "sitelayer.timer-monitor",
    "message": message,
    "tags": {
        "service": "systemd-timer-monitor",
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
    print(f"WARN: failed to send Sentry timer monitor event: {exc}", file=sys.stderr)
PY
}

failures=()
now_epoch="$(date -u +%s)"

for spec in $TIMER_MONITOR_SPECS; do
  service="${spec%%:*}"
  max_age="${spec#*:}"
  timer="${service%.service}.timer"

  if ! systemctl is-active --quiet "$timer"; then
    failures+=("$timer is not active")
  fi

  if ! systemctl cat "$service" >/dev/null 2>&1; then
    failures+=("$service is missing")
    continue
  fi

  active_state="$(systemctl show "$service" -p ActiveState --value 2>/dev/null || true)"
  result="$(systemctl show "$service" -p Result --value 2>/dev/null || true)"
  if [ "$active_state" = "failed" ] || { [ -n "$result" ] && [ "$result" != "success" ]; }; then
    failures+=("$service last result is ${result:-unknown} (active_state=$active_state)")
  fi

  inactive_at="$(systemctl show "$service" -p InactiveEnterTimestamp --value 2>/dev/null || true)"
  if ! inactive_epoch="$(timestamp_to_epoch "$inactive_at")"; then
    failures+=("$service has never completed")
    continue
  fi

  age=$((now_epoch - inactive_epoch))
  if [ "$age" -gt "$max_age" ]; then
    failures+=("$service last completed ${age}s ago, over ${max_age}s threshold")
  fi
done

if [ "${#failures[@]}" -gt 0 ]; then
  message="Sitelayer timer monitor failed: ${failures[*]}"
  echo "FAIL: $message" >&2
  send_sentry_event "$message"
  exit 1
fi

echo "OK: systemd timer monitor passed"
