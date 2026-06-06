#!/usr/bin/env bash
#
# Idempotent installer for the workstation-local Sitelayer capture media worker.
# This is a USER-level unit. It runs on Taylor's GPU workstation, pulls capture
# artifacts from Sitelayer DB/object storage, processes them through local
# Whisper + llama-swap, and writes derived analysis back to Sitelayer.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_ROOT/ops/systemd/sitelayer-capture-media-worker.service"
REAL_HOME="${REAL_HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
UNIT_DST_DIR="${SYSTEMD_USER_DIR:-$REAL_HOME/.config/systemd/user}"
SERVICE_UNIT="sitelayer-capture-media-worker.service"
ENV_FILE="${CAPTURE_MEDIA_WORKER_ENV_FILE:-$REAL_HOME/.config/sitelayer/capture-media-worker.env}"

if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: do not run as root — this is a USER-level unit for the GPU workstation." >&2
  exit 1
fi

if [ ! -f "$UNIT_SRC" ]; then
  echo "ERROR: unit file not found: $UNIT_SRC" >&2
  exit 1
fi

mkdir -p "$UNIT_DST_DIR" "$(dirname "$ENV_FILE")"
install -m 0644 "$UNIT_SRC" "$UNIT_DST_DIR/$SERVICE_UNIT"

DROPIN_DIR="$UNIT_DST_DIR/$SERVICE_UNIT.d"
mkdir -p "$DROPIN_DIR"
cat >"$DROPIN_DIR/10-local-checkout.conf" <<EOF
[Service]
WorkingDirectory=$REPO_ROOT
EnvironmentFile=-$ENV_FILE
EOF

if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<'EOF'
# Local-only Sitelayer capture media worker env.
# Do not commit this file.
#
# Required to start:
# DATABASE_URL=
# DO_SPACES_BUCKET=
# DO_SPACES_KEY=
# DO_SPACES_SECRET=
#
# Optional, depending on target environment:
# DATABASE_SSL_REJECT_UNAUTHORIZED=false
# DO_SPACES_ENDPOINT=
# DO_SPACES_REGION=tor1
# ACTIVE_COMPANY_SLUG=
# CAPTURE_MEDIA_WORKER_COMPANY_SLUG=
EOF
  chmod 0600 "$ENV_FILE"
fi

has_env_key() {
  local key="$1"
  [ -f "$ENV_FILE" ] && grep -Eq "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE"
}

systemctl --user daemon-reload

missing=()
for key in DATABASE_URL DO_SPACES_BUCKET DO_SPACES_KEY DO_SPACES_SECRET; do
  if ! has_env_key "$key"; then
    missing+=("$key")
  fi
done

echo "==> Installed $SERVICE_UNIT to $UNIT_DST_DIR"
echo "==> Env file: $ENV_FILE"

if [ "${#missing[@]}" -eq 0 ]; then
  systemctl --user enable --now "$SERVICE_UNIT"
  echo "==> Enabled + started $SERVICE_UNIT"
else
  systemctl --user enable "$SERVICE_UNIT"
  echo "==> Enabled $SERVICE_UNIT but did not start it; env file is missing: ${missing[*]}" >&2
fi

echo
systemctl --user status "$SERVICE_UNIT" --no-pager --lines=0 || true
echo
cat <<EOF
Useful commands:
  systemctl --user start $SERVICE_UNIT
  systemctl --user restart $SERVICE_UNIT
  systemctl --user stop $SERVICE_UNIT
  journalctl --user -u $SERVICE_UNIT -f
EOF
