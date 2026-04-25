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

validate_db_schema_name() {
  local schema="$1"

  if [[ ! "$schema" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "ERROR: invalid database schema name: $schema" >&2
    echo "Schema names must match ^[a-z_][a-z0-9_]*$" >&2
    exit 1
  fi
}

load_database_url() {
  local env_file="${ENV_FILE:-.env}"
  DATABASE_URL="${DATABASE_URL:-$(read_env_value "$env_file" DATABASE_URL)}"
  PREVIEW_DB_SCHEMA="${PREVIEW_DB_SCHEMA:-$(read_env_value "$env_file" PREVIEW_DB_SCHEMA)}"
  PGOPTIONS="${PGOPTIONS:-$(read_env_value "$env_file" PGOPTIONS)}"

  if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: set DATABASE_URL or provide ENV_FILE with DATABASE_URL (default: .env)" >&2
    exit 1
  fi

  if [ -n "${PREVIEW_DB_SCHEMA:-}" ]; then
    validate_db_schema_name "$PREVIEW_DB_SCHEMA"
    if [ -z "${PGOPTIONS:-}" ]; then
      PGOPTIONS="-c search_path=${PREVIEW_DB_SCHEMA},public"
    fi
  fi
}

load_database_schema() {
  local env_file="${ENV_FILE:-.env}"
  DB_SCHEMA="${DB_SCHEMA:-$(read_env_value "$env_file" DB_SCHEMA)}"

  if [ -z "${DB_SCHEMA:-}" ]; then
    DB_SCHEMA="${PREVIEW_DB_SCHEMA:-$(read_env_value "$env_file" PREVIEW_DB_SCHEMA)}"
  fi

  DB_SCHEMA="${DB_SCHEMA:-public}"
  validate_db_schema_name "$DB_SCHEMA"
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
  shift || true

  case "${PSQL_RUNNER:-}" in
    local)
      if [ -n "${PGOPTIONS:-}" ]; then
        PGOPTIONS="$PGOPTIONS" psql -v ON_ERROR_STOP=1 "$@" "$DATABASE_URL" -f "$file"
      else
        psql -v ON_ERROR_STOP=1 "$@" "$DATABASE_URL" -f "$file"
      fi
      ;;
    docker)
      local docker_args=(docker run --rm)
      if [ -n "${PSQL_DOCKER_NETWORK:-}" ]; then
        docker_args+=(--network "$PSQL_DOCKER_NETWORK")
      fi
      if [ -n "${PGOPTIONS:-}" ]; then
        docker_args+=(-e "PGOPTIONS=$PGOPTIONS")
      fi
      docker_args+=(-v "$PWD:/work:ro" -w /work "$PSQL_DOCKER_IMAGE" psql)
      "${docker_args[@]}" -v ON_ERROR_STOP=1 "$@" "$DATABASE_URL" -f "$file"
      ;;
    *)
      echo "ERROR: select_psql_runner must run before run_psql_file" >&2
      exit 1
      ;;
  esac
}

run_psql_file_with_vars() {
  local file="$1"
  shift || true
  local psql_args=()
  local assignment

  for assignment in "$@"; do
    psql_args+=(-v "$assignment")
  done

  run_psql_file "$file" "${psql_args[@]}"
}

run_psql_query() {
  local query="$1"

  case "${PSQL_RUNNER:-}" in
    local)
      if [ -n "${PGOPTIONS:-}" ]; then
        PGOPTIONS="$PGOPTIONS" psql -v ON_ERROR_STOP=1 -At "$DATABASE_URL" -c "$query"
      else
        psql -v ON_ERROR_STOP=1 -At "$DATABASE_URL" -c "$query"
      fi
      ;;
    docker)
      local docker_args=(docker run --rm)
      if [ -n "${PSQL_DOCKER_NETWORK:-}" ]; then
        docker_args+=(--network "$PSQL_DOCKER_NETWORK")
      fi
      if [ -n "${PGOPTIONS:-}" ]; then
        docker_args+=(-e "PGOPTIONS=$PGOPTIONS")
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
