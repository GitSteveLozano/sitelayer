#!/usr/bin/env bash
#
# Install the production droplet docker-storage cleanup as a systemd
# timer. Mirrors install-preview-prune-systemd.sh but targets prod
# layout (/app/sitelayer instead of /app/previews/main). Runs as root.
#
# Usage:
#   sudo APP_DIR=/app/sitelayer bash scripts/install-prod-prune-systemd.sh
#
# Default schedule: daily at 03:53 UTC (off-hours, before the
# preview-prune at 04:22 UTC and the registry-gc at 03:11 UTC).

set -euo pipefail

APP_DIR="${APP_DIR:-/app/sitelayer}"
SERVICE_NAME="${SERVICE_NAME:-sitelayer-prod-prune}"
PRUNE_TIME="${PRUNE_TIME:-03:53}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root" >&2
  exit 1
fi

if [ "${SKIP_PRUNE_SCRIPT_CHECK:-0}" != "1" ] && [ ! -f "$APP_DIR/scripts/prune-prod-docker.sh" ]; then
  echo "ERROR: prune script not found at $APP_DIR/scripts/prune-prod-docker.sh" >&2
  exit 1
fi

cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Sitelayer prod docker storage cleanup
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
User=root
Group=root
WorkingDirectory=$APP_DIR
Environment=APP_DIR=$APP_DIR
Environment=DRY_RUN=0
Environment=IMAGE_PRUNE_UNTIL=72h
Environment=BUILDER_PRUNE_UNTIL=72h
Environment=BUILDER_PRUNE_KEEP_STORAGE=2GB
ExecStart=/bin/bash -lc 'if [ -x "$APP_DIR/scripts/prune-prod-docker.sh" ]; then exec "$APP_DIR/scripts/prune-prod-docker.sh"; fi; echo "prune script missing: $APP_DIR/scripts/prune-prod-docker.sh"'
EOF

cat >"/etc/systemd/system/$SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run Sitelayer prod docker storage cleanup daily

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
