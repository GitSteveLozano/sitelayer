#!/usr/bin/env bash
# Idempotent installer for the postgres backup + off-site copy + restore drill
# systemd units. Re-run after editing this script — units are overwritten in
# place, daemon-reload + enable --now are idempotent.
set -euo pipefail

APP_DIR="${APP_DIR:-/app/sitelayer}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_DIR="${BACKUP_DIR:-/app/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
SERVICE_NAME="${SERVICE_NAME:-sitelayer-postgres-backup}"
BACKUP_TIME="${BACKUP_TIME:-03:17}"
PG_DUMP_DOCKER_IMAGE="${PG_DUMP_DOCKER_IMAGE:-postgres:18-alpine}"

# Off-site copy.
OFFSITE_SERVICE_NAME="${OFFSITE_SERVICE_NAME:-sitelayer-postgres-offsite}"
OFFSITE_TIME="${OFFSITE_TIME:-03:32}"
OFFSITE_HOST="${OFFSITE_HOST:-sitelayer@10.118.0.2}"
OFFSITE_DIR="${OFFSITE_DIR:-/app/offsite-backups/postgres-from-prod}"
OFFSITE_RETENTION_DAYS="${OFFSITE_RETENTION_DAYS:-30}"
SSH_KEY_PATH="${SSH_KEY_PATH:-/home/sitelayer/.ssh/id_ed25519}"

# Restore drill (weekly, log-only).
DRILL_SERVICE_NAME="${DRILL_SERVICE_NAME:-sitelayer-restore-drill}"
DRILL_TIME="${DRILL_TIME:-Sun *-*-* 04:00:00}"
DRILL_LOG_DIR="${DRILL_LOG_DIR:-/var/log/sitelayer}"
INSTALL_DRILL_TIMER="${INSTALL_DRILL_TIMER:-1}"

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

if [ ! -f "$APP_DIR/scripts/backup-postgres-offsite.sh" ]; then
  echo "ERROR: offsite backup script not found at $APP_DIR/scripts/backup-postgres-offsite.sh" >&2
  exit 1
fi

if [ ! -f "$APP_DIR/scripts/restore-drill.sh" ]; then
  echo "ERROR: restore drill script not found at $APP_DIR/scripts/restore-drill.sh" >&2
  exit 1
fi

install -d -m 700 -o sitelayer -g sitelayer "$BACKUP_DIR"
install -d -m 755 -o sitelayer -g sitelayer "$DRILL_LOG_DIR"

# --- Local logical backup unit ---
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
Environment=PG_DUMP_DOCKER_IMAGE=$PG_DUMP_DOCKER_IMAGE
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

# --- Off-site copy unit ---
cat >"/etc/systemd/system/$OFFSITE_SERVICE_NAME.service" <<EOF
[Unit]
Description=Sitelayer PostgreSQL off-site backup copy (rsync over SSH)
Wants=network-online.target
After=network-online.target $SERVICE_NAME.service

[Service]
Type=oneshot
User=sitelayer
Group=sitelayer
WorkingDirectory=$APP_DIR
Environment=BACKUP_DIR=$BACKUP_DIR
Environment=OFFSITE_HOST=$OFFSITE_HOST
Environment=OFFSITE_DIR=$OFFSITE_DIR
Environment=OFFSITE_RETENTION_DAYS=$OFFSITE_RETENTION_DAYS
Environment="SSH_OPTS=-o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -i $SSH_KEY_PATH"
ExecStart=$APP_DIR/scripts/backup-postgres-offsite.sh
EOF

cat >"/etc/systemd/system/$OFFSITE_SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run Sitelayer off-site backup copy daily (15min after local dump)

[Timer]
OnCalendar=*-*-* $OFFSITE_TIME:00
Persistent=true
RandomizedDelaySec=5m

[Install]
WantedBy=timers.target
EOF

# --- Restore drill unit (optional, log-only, weekly) ---
if [ "$INSTALL_DRILL_TIMER" = "1" ]; then
cat >"/etc/systemd/system/$DRILL_SERVICE_NAME.service" <<EOF
[Unit]
Description=Sitelayer PostgreSQL restore drill (scratch container)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=sitelayer
Group=sitelayer
WorkingDirectory=$APP_DIR
Environment=BACKUP_DIR=$BACKUP_DIR
StandardOutput=append:$DRILL_LOG_DIR/restore-drill.log
StandardError=append:$DRILL_LOG_DIR/restore-drill.log
ExecStart=$APP_DIR/scripts/restore-drill.sh
EOF

cat >"/etc/systemd/system/$DRILL_SERVICE_NAME.timer" <<EOF
[Unit]
Description=Run Sitelayer PostgreSQL restore drill weekly (Sunday)

[Timer]
OnCalendar=$DRILL_TIME
Persistent=true
RandomizedDelaySec=30m

[Install]
WantedBy=timers.target
EOF
fi

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME.timer"
systemctl enable --now "$OFFSITE_SERVICE_NAME.timer"
if [ "$INSTALL_DRILL_TIMER" = "1" ]; then
  systemctl enable --now "$DRILL_SERVICE_NAME.timer"
fi

systemctl list-timers \
  "$SERVICE_NAME.timer" \
  "$OFFSITE_SERVICE_NAME.timer" \
  "$DRILL_SERVICE_NAME.timer" \
  --no-pager || true
