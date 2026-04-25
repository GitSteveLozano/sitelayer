#!/usr/bin/env bash
# Idempotent installer for the backup/restore timer monitor.
set -euo pipefail

APP_DIR="${APP_DIR:-/app/sitelayer}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
SERVICE_NAME="${SERVICE_NAME:-sitelayer-timer-monitor}"
CHECK_TIME="${CHECK_TIME:-*:07:00}"
TIMER_MONITOR_SPECS="${TIMER_MONITOR_SPECS:-sitelayer-postgres-backup.service:129600 sitelayer-postgres-offsite.service:129600 sitelayer-blueprint-backup.service:129600 sitelayer-restore-drill.service:691200}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/scripts/check-systemd-timers.sh" ]; then
  echo "ERROR: monitor script not found at $APP_DIR/scripts/check-systemd-timers.sh" >&2
  exit 1
fi

cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Sitelayer backup/restore timer monitor
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
Environment=ENV_FILE=$ENV_FILE
Environment=SENTRY_ENVIRONMENT=production
Environment="TIMER_MONITOR_SPECS=$TIMER_MONITOR_SPECS"
ExecStart=$APP_DIR/scripts/check-systemd-timers.sh
EOF

cat >"/etc/systemd/system/$SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run Sitelayer backup/restore timer monitor hourly

[Timer]
OnCalendar=$CHECK_TIME
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.timer"
systemctl list-timers "$SERVICE_NAME.timer" --no-pager || true
