#!/usr/bin/env bash
# Reaper for stale `sitelayer-pr-*` docker compose stacks on the preview droplet.
# Driven by Preview Stack GC workflow (.github/workflows/preview-gc.yml). Reads
# OPEN_PRS_CSV from the environment (set on the SSH command line) — comma-
# separated list of open PR numbers. Anything not in that list gets reaped.
set -euo pipefail

open_csv="${OPEN_PRS_CSV:-}"
open_list="$(printf '%s\n' "$open_csv" | tr ',' '\n' | awk 'NF')"

# Safety belt: refuse to reap when the open-PR list is empty. An empty list
# can happen because of an API failure upstream, and the reaper would then
# tear down every sitelayer-pr-* stack — including currently-active ones.
# (This is exactly what happened on workflow run 24935177139.) The caller
# must explicitly set OPEN_PRS_ALLOW_EMPTY=1 to acknowledge the risk.
if [ -z "$open_list" ] && [ "${OPEN_PRS_ALLOW_EMPTY:-0}" != "1" ]; then
  echo "FATAL: OPEN_PRS_CSV is empty and OPEN_PRS_ALLOW_EMPTY is not set." >&2
  echo "Refusing to reap to avoid deleting active stacks. Investigate the upstream PR-list query." >&2
  exit 1
fi

mapfile -t projects < <(
  docker ps -a --format '{{.Label "com.docker.compose.project"}}' \
    | awk 'NF' \
    | grep -E '^sitelayer-pr-[0-9]+$' \
    | sort -u
)

if [ "${#projects[@]}" -eq 0 ]; then
  echo "No sitelayer-pr-* compose projects found on droplet."
  echo "Summary: 0 reaped, 0 retained."
  exit 0
fi

reaped=()
retained=()
for project in "${projects[@]}"; do
  pr_num="${project#sitelayer-pr-}"
  if [[ ! "$pr_num" =~ ^[0-9]+$ ]]; then
    echo "Skip (non-numeric suffix): $project"
    continue
  fi

  if [ -n "$open_list" ] && printf '%s\n' "$open_list" | grep -Fxq "$pr_num"; then
    retained+=("$project")
    continue
  fi

  echo "Reaping stale preview stack: $project (PR #$pr_num closed/missing)"
  target_dir="/app/previews/pr-${pr_num}"
  compose_file=""
  for candidate in docker-compose.preview.yml docker-compose.preview-prod.yml; do
    if [ -f "$target_dir/$candidate" ]; then
      compose_file="$candidate"
      break
    fi
  done

  if [ -n "$compose_file" ]; then
    env_args=()
    if [ -f "$target_dir/.env" ]; then
      env_args=(--env-file "$target_dir/.env")
    fi
    ( cd "$target_dir" && docker compose "${env_args[@]}" -f "$compose_file" -p "$project" down -v --remove-orphans ) \
      || echo "WARN: docker compose down failed for $project (continuing)"
  else
    docker compose -p "$project" down -v --remove-orphans \
      || echo "WARN: project-only down failed for $project (continuing)"
  fi
  reaped+=("$project")
done

echo
echo "Summary: ${#reaped[@]} reaped, ${#retained[@]} retained."
if [ "${#reaped[@]}" -gt 0 ]; then
  echo "Reaped:"
  printf '  - %s\n' "${reaped[@]}"
fi
if [ "${#retained[@]}" -gt 0 ]; then
  echo "Retained (PR still open):"
  printf '  - %s\n' "${retained[@]}"
fi
