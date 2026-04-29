#!/usr/bin/env bash
#
# Production droplet docker storage cleanup.
#
# Prod has no preview stacks, but accumulates the same docker debt
# (build cache from any local builds, unused image tags from each
# deploy, orphan volumes). The deploy workflow's prune step removes
# old registry tags but DO storage GC on the local docker layer is
# never triggered.
#
# Run as root via the sitelayer-prod-prune systemd timer (installed
# by scripts/install-prod-prune-systemd.sh).
#
# Behavior, in order:
#   1. docker image prune -af --filter until=72h
#      (drops untagged AND unused-tagged images > 72h old; running
#       containers' images are protected automatically)
#   2. docker builder prune -af --filter until=72h --keep-storage 2GB
#      (caps BuildKit cache at 2 GB so incremental rebuilds still
#       benefit from cache reuse)
#   3. docker volume prune -f
#      (removes volumes not referenced by any container)
#
# Tunable env vars:
#   IMAGE_PRUNE_UNTIL          (default 72h)
#   BUILDER_PRUNE_UNTIL        (default 72h)
#   BUILDER_PRUNE_KEEP_STORAGE (default 2GB)
#   DRY_RUN=1                  (skip mutating commands; print plan only)

set -euo pipefail

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN=1 — would run:"
  echo "  docker image prune -af --filter until=${IMAGE_PRUNE_UNTIL:-72h}"
  echo "  docker builder prune -af --filter until=${BUILDER_PRUNE_UNTIL:-72h} --keep-storage ${BUILDER_PRUNE_KEEP_STORAGE:-2GB}"
  echo "  docker volume prune -f"
  exit 0
fi

echo "==> docker image prune"
docker image prune -af --filter "label!=keep" --filter "until=${IMAGE_PRUNE_UNTIL:-72h}" || true

echo "==> docker builder prune"
docker builder prune -af --filter "until=${BUILDER_PRUNE_UNTIL:-72h}" \
  --keep-storage "${BUILDER_PRUNE_KEEP_STORAGE:-2GB}" || true

echo "==> docker volume prune"
docker volume prune -f || true

echo "==> docker system df:"
docker system df

echo "==> df -h /:"
df -h /
