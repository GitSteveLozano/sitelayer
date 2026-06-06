#!/usr/bin/env bash
set -euo pipefail

PREVIEW_ROOT="${PREVIEW_ROOT:-/app/previews}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-14}"
APP_DIR="${APP_DIR:-/app/previews/main}"
SERVICE_NAME="${SERVICE_NAME:-sitelayer-preview-prune}"
PRUNE_TIME="${PRUNE_TIME:-04:09}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root" >&2
  exit 1
fi

if [ "${SKIP_PRUNE_SCRIPT_CHECK:-0}" != "1" ] && [ ! -f "$APP_DIR/scripts/prune-preview-stacks.sh" ]; then
  echo "ERROR: prune script not found at $APP_DIR/scripts/prune-preview-stacks.sh" >&2
  exit 1
fi

cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Sitelayer preview stack TTL cleanup
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=$APP_DIR
Environment=APP_DIR=$APP_DIR
Environment=PREVIEW_ROOT=$PREVIEW_ROOT
Environment=MAX_AGE_DAYS=$MAX_AGE_DAYS
Environment=DRY_RUN=0
ExecStart=/bin/bash -lc 'if [ -x "$APP_DIR/scripts/prune-preview-stacks.sh" ]; then exec "$APP_DIR/scripts/prune-preview-stacks.sh"; fi; echo "prune script missing: $APP_DIR/scripts/prune-preview-stacks.sh"'
EOF

cat >"/etc/systemd/system/$SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run Sitelayer preview stack TTL cleanup daily

[Timer]
OnCalendar=*-*-* $PRUNE_TIME:00
Persistent=true
RandomizedDelaySec=15m

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.timer"
systemctl list-timers "$SERVICE_NAME.timer" --no-pager
