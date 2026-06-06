#!/usr/bin/env bash
#
# Idempotent installer for the Sitelayer USER-level e2e-runner systemd timer.
# Mirrors scripts/install-auto-deploy-systemd.sh: installs a *user* unit
# (~/.config/systemd/user/), runs daemon-reload, and enable --now (all
# idempotent). Re-run after editing the unit files — they are overwritten in
# place.
#
# This runs `npm run verify:full` (the e2e suite + the deterministic stages) on
# a QUIET box. Install it on the preview droplet (off-hours) or a $6/mo throwaway
# — NOT taylor-pc, where a loaded machine flakes the browser stage. See
# docs/E2E_RUNNER.md.
#
# Cadence (default: nightly):
#   --nightly [HH:MM]   OnCalendar nightly at HH:MM (default 04:30). DEFAULT.
#   --poll [MINUTES]    OnUnitActiveSec every MINUTES (default 15) — per-dev-
#                       advance style; the runner short-circuits an unchanged
#                       tip so a frequent timer is cheap.
#   --run-now           run one verify pass immediately after install.
#
# Env overrides:
#   SYSTEMD_USER_DIR    unit install dir (default ~/.config/systemd/user)
#   E2E_RUNNER_HOME     runner state/cache dir (default ~/.cache/sitelayer-e2e-runner)
#   E2E_RUNNER_CADENCE  'nightly' (default) or 'poll' (same as --nightly/--poll)
#   E2E_RUNNER_NIGHTLY_TIME   HH:MM for nightly (default 04:30)
#   E2E_RUNNER_POLL_MINUTES   minutes for poll (default 15)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC_DIR="$REPO_ROOT/ops/systemd"
UNIT_DST_DIR="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
SERVICE_UNIT="sitelayer-e2e-runner.service"
TIMER_UNIT="sitelayer-e2e-runner.timer"
E2E_RUNNER_HOME="${E2E_RUNNER_HOME:-$HOME/.cache/sitelayer-e2e-runner}"

CADENCE="${E2E_RUNNER_CADENCE:-nightly}"
NIGHTLY_TIME="${E2E_RUNNER_NIGHTLY_TIME:-04:30}"
POLL_MINUTES="${E2E_RUNNER_POLL_MINUTES:-15}"
RUN_NOW=0

while [ $# -gt 0 ]; do
  case "$1" in
    --nightly)
      CADENCE="nightly"
      if [ $# -ge 2 ] && [[ "$2" =~ ^[0-2][0-9]:[0-5][0-9]$ ]]; then
        NIGHTLY_TIME="$2"
        shift
      fi
      shift
      ;;
    --poll)
      CADENCE="poll"
      if [ $# -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]]; then
        POLL_MINUTES="$2"
        shift
      fi
      shift
      ;;
    --run-now)
      RUN_NOW=1
      shift
      ;;
    -h | --help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "install-e2e-runner-systemd: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  echo "ERROR: do not run as root — this is a USER-level unit so the runner runs" >&2
  echo "       as the operator and reuses the operator's git creds + toolchain." >&2
  exit 1
fi

for unit in "$SERVICE_UNIT" "$TIMER_UNIT"; do
  if [ ! -f "$UNIT_SRC_DIR/$unit" ]; then
    echo "ERROR: unit file not found: $UNIT_SRC_DIR/$unit" >&2
    exit 1
  fi
done

if [ ! -x "$REPO_ROOT/scripts/e2e-runner.sh" ]; then
  echo "WARN: $REPO_ROOT/scripts/e2e-runner.sh is not executable; fixing." >&2
  chmod +x "$REPO_ROOT/scripts/e2e-runner.sh" || true
fi

mkdir -p "$UNIT_DST_DIR"
mkdir -p "$E2E_RUNNER_HOME"

install -m 0644 "$UNIT_SRC_DIR/$SERVICE_UNIT" "$UNIT_DST_DIR/$SERVICE_UNIT"
install -m 0644 "$UNIT_SRC_DIR/$TIMER_UNIT" "$UNIT_DST_DIR/$TIMER_UNIT"
echo "==> Installed unit files to $UNIT_DST_DIR"

# Apply the chosen cadence via a systemd drop-in so the shipped timer file stays
# the documented default and the operator's choice is an overlay (not an edit to
# the tracked unit). The drop-in fully replaces the [Timer] schedule keys.
DROPIN_DIR="$UNIT_DST_DIR/${TIMER_UNIT}.d"
mkdir -p "$DROPIN_DIR"
if [ "$CADENCE" = "poll" ]; then
  cat >"$DROPIN_DIR/cadence.conf" <<EOF
[Timer]
# Per-dev-advance: poll every ${POLL_MINUTES} min. Clear OnCalendar (set empty
# first to reset the shipped nightly schedule), then use OnUnitActiveSec.
OnCalendar=
OnBootSec=${POLL_MINUTES}min
OnUnitActiveSec=${POLL_MINUTES}min
EOF
  echo "==> Cadence: poll every ${POLL_MINUTES}min (per-dev-advance; runner short-circuits an unchanged tip)"
else
  cat >"$DROPIN_DIR/cadence.conf" <<EOF
[Timer]
# Nightly at ${NIGHTLY_TIME}. Reset OnUnitActiveSec (poll) in case a prior
# install set it, then pin the calendar schedule.
OnUnitActiveSec=
OnBootSec=
OnCalendar=*-*-* ${NIGHTLY_TIME}:00
EOF
  echo "==> Cadence: nightly at ${NIGHTLY_TIME}"
fi

systemctl --user daemon-reload
systemctl --user enable --now "$TIMER_UNIT"
echo "==> Enabled + started $TIMER_UNIT"

if [ "$RUN_NOW" = "1" ]; then
  echo "==> --run-now: starting one verify pass (this can take many minutes)"
  systemctl --user start "$SERVICE_UNIT" || true
fi

echo
echo "Timer status:"
systemctl --user list-timers "$TIMER_UNIT" --no-pager || true
echo
echo "Service status:"
systemctl --user status "$SERVICE_UNIT" --no-pager --lines=0 || true

cat <<EOF

------------------------------------------------------------------------------
e2e runner installed (USER timer). Meant for a QUIET box — NOT taylor-pc.

Watch logs (live):
  journalctl --user -u $SERVICE_UNIT -f
  tail -f $E2E_RUNNER_HOME/e2e-runner.log

Run once now (manual):
  systemctl --user start $SERVICE_UNIT
  # or directly: $REPO_ROOT/scripts/e2e-runner.sh

Pause WITHOUT uninstalling (survives reboots):
  touch $E2E_RUNNER_HOME/PAUSED      # resume: rm $E2E_RUNNER_HOME/PAUSED

Switch cadence:
  $REPO_ROOT/scripts/install-e2e-runner-systemd.sh --poll 15     # per-dev-advance
  $REPO_ROOT/scripts/install-e2e-runner-systemd.sh --nightly 04:30

Disable the timer entirely:
  systemctl --user disable --now $TIMER_UNIT

Alerts on failure: Sentry (SENTRY_DSN) + Pushover (PUSHOVER_TOKEN/PUSHOVER_USER),
read from the environment or the rendered /app/sitelayer/.env (ENV_FILE).
Absent creds => that channel silently no-ops; the run still fails loudly (exit
code + journald). See docs/E2E_RUNNER.md.

NOTE: for a user timer to keep firing while you are logged out, enable linger:
  loginctl enable-linger \$USER
------------------------------------------------------------------------------
EOF
