#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/app/sitelayer}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-/app/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
SERVICE_NAME="${SERVICE_NAME:-sitelayer-postgres-backup}"
BACKUP_TIME="${BACKUP_TIME:-03:17}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root" >&2
  exit 1
fi

if [ ! -d "$APP_DIR" ]; then
  echo "ERROR: app directory not found: $APP_DIR" >&2
  exit 1
fi

if [ ! -f "$APP_DIR/scripts/backup-postgres.sh" ]; then
  echo "ERROR: backup script not found at $APP_DIR/scripts/backup-postgres.sh" >&2
  exit 1
fi

install -d -m 700 -o sitelayer -g sitelayer "$BACKUP_DIR"

cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Sitelayer PostgreSQL logical backup
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=sitelayer
Group=sitelayer
WorkingDirectory=$APP_DIR
Environment=BACKUP_DIR=$BACKUP_DIR
Environment=RETENTION_DAYS=$RETENTION_DAYS
Environment=DATABASE_URL_FILE=$ENV_FILE
ExecStart=$APP_DIR/scripts/backup-postgres.sh
EOF

cat >"/etc/systemd/system/$SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run Sitelayer PostgreSQL logical backup daily

[Timer]
OnCalendar=*-*-* $BACKUP_TIME:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.timer"
systemctl list-timers "$SERVICE_NAME.timer" --no-pager
