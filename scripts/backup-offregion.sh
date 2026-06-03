#!/usr/bin/env bash
# Off-region prod Postgres backup — stable entry point.
#
# WHY THIS IS A THIN WRAPPER:
#   The canonical off-region backup implementation already lives in
#   scripts/backup-to-offregion.sh (pg_dump | gzip -> DO Spaces in a non-tor1
#   region, with retention pruning). The systemd units
#   ops/systemd/sitelayer-offregion-backup.{service,timer} already invoke that
#   canonical script. Forking a second, divergent pg_dump->Spaces pipeline here
#   would be a maintenance hazard (two scripts, two retention policies, two
#   sets of env contracts that silently drift).
#
#   So scripts/backup-offregion.sh exists ONLY as the shorter, "obvious" name
#   referenced by ops docs/runbooks and muscle memory, and it delegates 1:1 to
#   the canonical script. All flags, env vars, and exit codes pass straight
#   through — see scripts/backup-to-offregion.sh for the full contract:
#
#     DATABASE_URL, DO_SPACES_OFFREGION_KEY / _SECRET / _BUCKET / _ENDPOINT,
#     RETAIN_DAYS, ENV_FILE, --retain-days N, --skip-prune, --skip-backup, ...
#
# Usage (identical to the canonical script):
#   bash scripts/backup-offregion.sh
#   bash scripts/backup-offregion.sh --retain-days 60
#   bash scripts/backup-offregion.sh --skip-backup        # retention-only sweep
#
# This repo provisions the off-region path that DR previously leaned on an
# UNTRACKED personal Google-Drive script for; everything is now in-repo:
#   scripts/backup-offregion.sh        -> scripts/backup-to-offregion.sh
#   ops/systemd/sitelayer-offregion-backup.service / .timer (daily 06:00 UTC)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CANONICAL="$SCRIPT_DIR/backup-to-offregion.sh"

if [ ! -f "$CANONICAL" ]; then
  echo "[backup-offregion] ERROR: canonical script not found: $CANONICAL" >&2
  exit 1
fi

# exec so the wrapper adds zero process overhead and the canonical script's
# exit code / signals propagate unchanged to the systemd unit or operator.
exec bash "$CANONICAL" "$@"
