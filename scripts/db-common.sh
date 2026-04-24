#!/usr/bin/env bash

read_env_value() {
  local file="$1"
  local key="$2"
  local value

  if [ ! -f "$file" ]; then
    return 0
  fi

  value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true)"
  value="${value%$'\r'}"

  case "$value" in
    \"*\")
      value="${value#\"}"
      value="${value%\"}"
      ;;
    \'*\')
      value="${value#\'}"
      value="${value%\'}"
      ;;
  esac

  printf '%s' "$value"
}

load_database_url() {
  local env_file="${ENV_FILE:-.env}"
  DATABASE_URL="${DATABASE_URL:-$(read_env_value "$env_file" DATABASE_URL)}"

  if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: set DATABASE_URL or provide ENV_FILE with DATABASE_URL (default: .env)" >&2
    exit 1
  fi
}

select_psql_runner() {
  if [ -n "${PSQL_DOCKER_IMAGE:-}" ] || [ -n "${PSQL_DOCKER_NETWORK:-}" ]; then
    PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}"
    if ! command -v docker >/dev/null 2>&1; then
      echo "ERROR: docker is required when PSQL_DOCKER_IMAGE or PSQL_DOCKER_NETWORK is set" >&2
      exit 1
    fi
    PSQL_RUNNER="docker"
    return
  fi

  if command -v psql >/dev/null 2>&1; then
    PSQL_RUNNER="local"
    return
  fi

  PSQL_DOCKER_IMAGE="${PSQL_DOCKER_IMAGE:-postgres:18-alpine}"
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: psql is required, or docker must be installed for PSQL_DOCKER_IMAGE fallback" >&2
    exit 1
  fi
  PSQL_RUNNER="docker"
}

run_psql_file() {
  local file="$1"

  case "${PSQL_RUNNER:-}" in
    local)
      psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$file"
      ;;
    docker)
      local docker_args=(docker run --rm)
      if [ -n "${PSQL_DOCKER_NETWORK:-}" ]; then
        docker_args+=(--network "$PSQL_DOCKER_NETWORK")
      fi
      docker_args+=(-v "$PWD:/work:ro" -w /work "$PSQL_DOCKER_IMAGE" psql)
      "${docker_args[@]}" -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$file"
      ;;
    *)
      echo "ERROR: select_psql_runner must run before run_psql_file" >&2
      exit 1
      ;;
  esac
}

run_psql_query() {
  local query="$1"

  case "${PSQL_RUNNER:-}" in
    local)
      psql -v ON_ERROR_STOP=1 -At "$DATABASE_URL" -c "$query"
      ;;
    docker)
      local docker_args=(docker run --rm)
      if [ -n "${PSQL_DOCKER_NETWORK:-}" ]; then
        docker_args+=(--network "$PSQL_DOCKER_NETWORK")
      fi
      docker_args+=("$PSQL_DOCKER_IMAGE" psql)
      "${docker_args[@]}" -v ON_ERROR_STOP=1 -At "$DATABASE_URL" -c "$query"
      ;;
    *)
      echo "ERROR: select_psql_runner must run before run_psql_query" >&2
      exit 1
      ;;
  esac
}
