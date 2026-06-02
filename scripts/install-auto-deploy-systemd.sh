#!/usr/bin/env bash
#
# Idempotent installer for the Sitelayer fleet-side auto-deploy USER-level
# systemd timer. Re-run after editing the unit files — they are overwritten in
# place, and daemon-reload + enable --now are idempotent.
#
# This installs a *user* unit (~/.config/systemd/user/), NOT a system unit, so
# the watcher runs as the operator and reuses the operator's ssh key + git
# credentials to reach the preview droplet. No root required.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC_DIR="$REPO_ROOT/ops/systemd"
UNIT_DST_DIR="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
SERVICE_UNIT="sitelayer-auto-deploy.service"
TIMER_UNIT="sitelayer-auto-deploy.timer"
AUTODEPLOY_HOME="${AUTODEPLOY_HOME:-$HOME/.cache/sitelayer-autodeploy}"

if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: do not run as root — this is a USER-level unit so the watcher runs" >&2
  echo "       as the operator and reuses the operator's ssh key + git creds." >&2
  exit 1
fi

for unit in "$SERVICE_UNIT" "$TIMER_UNIT"; do
  if [ ! -f "$UNIT_SRC_DIR/$unit" ]; then
    echo "ERROR: unit file not found: $UNIT_SRC_DIR/$unit" >&2
    exit 1
  fi
done

if [ ! -x "$REPO_ROOT/scripts/fleet-auto-deploy.sh" ]; then
  echo "WARN: $REPO_ROOT/scripts/fleet-auto-deploy.sh is not executable; fixing." >&2
  chmod +x "$REPO_ROOT/scripts/fleet-auto-deploy.sh" || true
fi

mkdir -p "$UNIT_DST_DIR"
mkdir -p "$AUTODEPLOY_HOME"

install -m 0644 "$UNIT_SRC_DIR/$SERVICE_UNIT" "$UNIT_DST_DIR/$SERVICE_UNIT"
install -m 0644 "$UNIT_SRC_DIR/$TIMER_UNIT" "$UNIT_DST_DIR/$TIMER_UNIT"
echo "==> Installed unit files to $UNIT_DST_DIR"

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER_UNIT"
echo "==> Enabled + started $TIMER_UNIT"

echo
echo "Timer status:"
systemctl --user list-timers "$TIMER_UNIT" --no-pager || true
echo
echo "Service status:"
systemctl --user status "$SERVICE_UNIT" --no-pager --lines=0 || true

cat <<EOF

------------------------------------------------------------------------------
Auto-deploy watcher installed (USER timer, every 2 min).

Watch logs (live):
  journalctl --user -u $SERVICE_UNIT -f
  tail -f $AUTODEPLOY_HOME/auto-deploy.log

Run once now (manual poll):
  systemctl --user start $SERVICE_UNIT
  # or directly: $REPO_ROOT/scripts/fleet-auto-deploy.sh

Pause WITHOUT uninstalling (kill switch — survives reboots):
  touch $AUTODEPLOY_HOME/PAUSED      # resume: rm $AUTODEPLOY_HOME/PAUSED

Disable the timer entirely:
  systemctl --user disable --now $TIMER_UNIT

NOTE: for a user timer to keep firing while you are logged out, enable linger:
  loginctl enable-linger \$USER
------------------------------------------------------------------------------
EOF
