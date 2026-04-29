#!/usr/bin/env bash
#
# Install the daily replay-workflow sweep as a systemd timer on prod.
# Mirrors install-prod-prune-systemd.sh.
#
# Usage:
#   sudo APP_DIR=/app/sitelayer bash scripts/install-replay-sweep-systemd.sh
#
# Default schedule: 04:42 UTC daily — after registry-gc (03:11),
# prod-prune (03:53), and preview-prune (04:22).

set -euo pipefail

APP_DIR="${APP_DIR:-/app/sitelayer}"
SERVICE_NAME="${SERVICE_NAME:-sitelayer-replay-sweep}"
SWEEP_TIME="${SWEEP_TIME:-04:42}"
SWEEP_LIMIT="${SWEEP_LIMIT:-100}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root" >&2
  exit 1
fi

if [ "${SKIP_SCRIPT_CHECK:-0}" != "1" ] && [ ! -f "$APP_DIR/scripts/replay-workflow-sweep.sh" ]; then
  echo "ERROR: sweep script not found at $APP_DIR/scripts/replay-workflow-sweep.sh" >&2
  exit 1
fi

# The sweep needs node + npx. Run as the deploy user (sitelayer) which
# has them on PATH. WorkingDirectory is the repo so npx tsx can resolve
# the workflows package.
cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Sitelayer deterministic-workflow replay sweep
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
User=sitelayer
Group=sitelayer
WorkingDirectory=$APP_DIR
Environment=APP_DIR=$APP_DIR
Environment=SWEEP_LIMIT=$SWEEP_LIMIT
ExecStart=/bin/bash -lc 'if [ -x "$APP_DIR/scripts/replay-workflow-sweep.sh" ]; then exec "$APP_DIR/scripts/replay-workflow-sweep.sh"; fi; echo "sweep script missing: $APP_DIR/scripts/replay-workflow-sweep.sh"; exit 1'
StandardOutput=journal
StandardError=journal
EOF

cat >"/etc/systemd/system/$SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run Sitelayer replay-workflow sweep daily

[Timer]
OnCalendar=*-*-* $SWEEP_TIME:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.timer"
systemctl list-timers "$SERVICE_NAME.timer" --no-pager
