#!/usr/bin/env bash
# Idempotent installer for the blueprint volume off-host backup timer.
set -euo pipefail

APP_DIR="${APP_DIR:-/app/sitelayer}"
BACKUP_DIR="${BACKUP_DIR:-/app/backups/blueprints}"
SERVICE_NAME="${SERVICE_NAME:-sitelayer-blueprint-backup}"
BACKUP_TIME="${BACKUP_TIME:-03:47}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
BLUEPRINT_VOLUME_NAME="${BLUEPRINT_VOLUME_NAME:-sitelayer_blueprint_storage}"
OFFSITE_HOST="${OFFSITE_HOST:-sitelayer@10.118.0.2}"
OFFSITE_DIR="${OFFSITE_DIR:-/app/offsite-backups/blueprints-from-prod}"
OFFSITE_RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-30}"
SSH_KEY_PATH="${SSH_KEY_PATH:-/home/sitelayer/.ssh/id_ed25519}"
TAR_DOCKER_IMAGE="${TAR_DOCKER_IMAGE:-alpine:3.20}"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root" >&2
  exit 1
fi
if [ ! -f "$APP_DIR/scripts/backup-blueprints-offsite.sh" ]; then
  echo "ERROR: backup script not found at $APP_DIR/scripts/backup-blueprints-offsite.sh" >&2
  exit 1
fi

install -d -m 700 -o sitelayer -g sitelayer "$BACKUP_DIR"

cat >"/etc/systemd/system/$SERVICE_NAME.service" <<EOF
[Unit]
Description=Sitelayer blueprint storage off-site backup copy
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
User=sitelayer
Group=sitelayer
WorkingDirectory=$APP_DIR
Environment=BACKUP_DIR=$BACKUP_DIR
Environment=BLUEPRINT_VOLUME_NAME=$BLUEPRINT_VOLUME_NAME
Environment=RETENTION_DAYS=$RETENTION_DAYS
Environment=OFFSITE_HOST=$OFFSITE_HOST
Environment=OFFSITE_DIR=$OFFSITE_DIR
Environment=OFFSITE_RETENTION_DAYS=$OFFSITE_RETENTION_DAYS
Environment=TAR_DOCKER_IMAGE=$TAR_DOCKER_IMAGE
Environment="SSH_OPTS=-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i $SSH_KEY_PATH"
ExecStart=$APP_DIR/scripts/backup-blueprints-offsite.sh
EOF

cat >"/etc/systemd/system/$SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run Sitelayer blueprint storage off-site backup daily

[Timer]
OnCalendar=*-*-* $BACKUP_TIME:00
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.timer"
systemctl list-timers "$SERVICE_NAME.timer" --no-pager || true
