#!/usr/bin/env bash
#
# audit-pg-schema-parity.sh — prove a target DB's schema MATCHES the schema the
# committed baseline (docker/postgres/init/000_baseline.sql) builds.
#
# WHY this exists:
#   scripts/check-db-schema.sh is a PRESENCE check — it confirms a hand-curated
#   allowlist of tables/columns exists. It does NOT notice a column with the
#   wrong type, a missing index, a constraint that was never created, an RLS
#   policy that drifted, or a table whose RLS FORCE flag is off. After a squash
#   cutover (docs/MIGRATION_BASELINE.md) a BOTCHED or PARTIAL baseline apply —
#   e.g. a psql < 18 that choked on the pg_dump-18 \restrict markers and applied
#   only half the file — leaves a DB that PASSES the presence check but is
#   structurally wrong. This tool is the real PARITY check: it diffs the FULL
#   normalized schema (tables, columns + types, indexes, constraints, sequences,
#   functions, triggers, RLS ENABLE/FORCE, policies, comments) of a target DB
#   against the schema the baseline produces on a clean postgres:18.
#
# WHAT it does:
#   1. Builds the EXPECTED schema by applying docker/postgres/init/000_baseline.sql
#      (plus any post-baseline numbered migrations still in init/) to a throwaway
#      postgres:18 container, then schema-only pg_dumps it.
#   2. Schema-only pg_dumps the TARGET DB ($DATABASE_URL) using a postgres:18
#      pg_dump (run in a container) so the dump format matches the reference
#      exactly — this is what makes the diff meaningful AND what lets it run
#      against a least-privilege prod-like role (pg_dump --schema-only
#      --no-owner --no-privileges only needs catalog read access).
#   3. Normalizes both dumps (strips session chrome, owner/priv noise, the
#      \restrict markers, and the public-schema create/comment) and diffs them.
#      EMPTY diff => PARITY. NON-EMPTY => DRIFT, printed with '-' = expected
#      (baseline) only, '+' = target only.
#
# Usage:
#   DATABASE_URL=postgres://user:pass@host:5432/db scripts/audit-pg-schema-parity.sh
#   ENV_FILE=.env.prod scripts/audit-pg-schema-parity.sh        # read DATABASE_URL from a file
#   scripts/audit-pg-schema-parity.sh --keep                    # leave the reference container running
#   PSQL_DOCKER_NETWORK=sitelayer_default scripts/audit-pg-schema-parity.sh
#       # when the target DB is reachable only on a docker network (run the
#       # target pg_dump container attached to that network)
#
# It NEVER writes to the target DB — only pg_dump (read-only) touches it. Safe to
# run against prod with a read-only or app role.
#
# Requirements: docker (a throwaway postgres:18 is spun up; the target pg_dump
# also runs in a postgres:18 container so versions match). A target DATABASE_URL.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Reuse the shared env/url loader (DATABASE_URL, PREVIEW_DB_SCHEMA, PGOPTIONS).
source "$SCRIPT_DIR/db-common.sh"

# ---- Configuration (overridable) -------------------------------------------
MIGRATION_DIR="${MIGRATION_DIR:-docker/postgres/init}"
PG_IMAGE="${AUDIT_PG_IMAGE:-postgres:18-alpine}"
PROJECT="${AUDIT_PROJECT:-sitelayer-parity-$$}"
DOCKER="${DOCKER_BIN:-docker}"
TARGET_SCHEMA="${TARGET_SCHEMA:-public}"

KEEP=0

# ---- Argument parsing -------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    -h | --help)
      sed -n '2,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "audit-pg-schema-parity: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# ---- Logging ----------------------------------------------------------------
log() { printf '[parity] %s\n' "$*"; }
warn() { printf '[parity WARN] %s\n' "$*" >&2; }
die() {
  printf '[parity FAIL] %s\n' "$*" >&2
  exit 1
}

# ---- Preconditions ----------------------------------------------------------
command -v "$DOCKER" >/dev/null 2>&1 || die "docker is required (a throwaway $PG_IMAGE is spun up for the reference schema)"
"$DOCKER" info >/dev/null 2>&1 || die "docker daemon is not reachable"

[ -d "$MIGRATION_DIR" ] || die "migration directory not found: $MIGRATION_DIR"

# Load the target DATABASE_URL via the shared loader (ENV_FILE / env override).
load_database_url

# Collect the applied migration files (baseline + any post-baseline files).
mapfile -t migration_files < <(
  find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' | sort
)
[ "${#migration_files[@]}" -gt 0 ] || die "no migration files found in $MIGRATION_DIR"
log "reference schema source: ${#migration_files[@]} file(s) under $MIGRATION_DIR"

# ---- Container lifecycle ----------------------------------------------------
REF_CONTAINER="${PROJECT}-reference"

cleanup() {
  local code=$?
  set +e
  if [ "$KEEP" = "1" ]; then
    warn "--keep set; leaving reference container $REF_CONTAINER running"
    return $code
  fi
  "$DOCKER" rm -f "$REF_CONTAINER" >/dev/null 2>&1
  return $code
}
trap cleanup EXIT INT TERM

# start_pg <container-name>
# Throwaway postgres with no init scripts; wait until a real query succeeds.
start_pg() {
  local name="$1"
  "$DOCKER" rm -f "$name" >/dev/null 2>&1 || true
  "$DOCKER" run -d --name "$name" \
    -e POSTGRES_DB=sitelayer \
    -e POSTGRES_USER=sitelayer \
    -e POSTGRES_PASSWORD=sitelayer \
    "$PG_IMAGE" >/dev/null || die "failed to start container $name"

  local attempt
  for attempt in $(seq 1 60); do
    : "$attempt"
    if "$DOCKER" exec "$name" psql -U sitelayer -d sitelayer -tAc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  "$DOCKER" logs "$name" 2>&1 | tail -30 >&2 || true
  die "postgres in $name did not become ready in time"
}

# apply_file_to <container-name> <host-sql-path>
apply_file_to() {
  local name="$1" file="$2"
  "$DOCKER" exec -i "$name" psql -v ON_ERROR_STOP=1 -U sitelayer -d sitelayer >/dev/null <"$file"
}

# dump_schema_container <container-name>
# schema-only dump from a throwaway container (the reference DB).
dump_schema_container() {
  local name="$1"
  "$DOCKER" exec "$name" pg_dump \
    --schema-only \
    --no-owner \
    --no-privileges \
    --schema="$TARGET_SCHEMA" \
    -U sitelayer -d sitelayer
}

# dump_schema_target
# schema-only dump of the TARGET DB ($DATABASE_URL) using a postgres:18 pg_dump
# in a container so the output format matches the reference dump exactly. Runs
# read-only (pg_dump). Honors PSQL_DOCKER_NETWORK so a DB reachable only on a
# docker network can be dumped.
dump_schema_target() {
  local docker_args=("$DOCKER" run --rm)
  if [ -n "${PSQL_DOCKER_NETWORK:-}" ]; then
    docker_args+=(--network "$PSQL_DOCKER_NETWORK")
  fi
  docker_args+=("$PG_IMAGE" pg_dump
    --schema-only
    --no-owner
    --no-privileges
    --schema="$TARGET_SCHEMA"
    "$DATABASE_URL")
  "${docker_args[@]}"
}

# normalize_dump
# Canonicalize a raw pg_dump for a meaningful diff: drop SQL comments, SET lines,
# set_config calls, psql backslash meta-lines (incl. the PG18 \restrict /
# \unrestrict markers), the cluster-managed public-schema create/comment, and
# collapse blank-line runs. After this, an empty diff proves object-level schema
# identity (tables, columns + types, indexes, constraints, RLS ENABLE/FORCE,
# policies, functions, sequences, triggers, comments).
normalize_dump() {
  sed -E \
    -e '/^--/d' \
    -e '/^SET /d' \
    -e '/^SELECT pg_catalog\./d' \
    -e '/^\\/d' \
    -e '/^CREATE SCHEMA public;$/d' \
    -e "/^COMMENT ON SCHEMA public IS /d" \
    | cat -s
}

# ============================================================================
# Build the reference schema, dump the target, diff.
# ============================================================================
main() {
  log "starting reference container ($REF_CONTAINER) on $PG_IMAGE"
  start_pg "$REF_CONTAINER"

  log "applying ${#migration_files[@]} migration file(s) to build the reference schema"
  local f
  for f in "${migration_files[@]}"; do
    apply_file_to "$REF_CONTAINER" "$f" || die "reference migration failed to apply: $f"
  done
  log "reference schema built from the committed baseline"

  local ref_raw ref_norm tgt_raw tgt_norm
  ref_raw="$(mktemp "${TMPDIR:-/tmp}/parity-ref-raw.XXXXXX.sql")"
  ref_norm="$(mktemp "${TMPDIR:-/tmp}/parity-ref-norm.XXXXXX.sql")"
  tgt_raw="$(mktemp "${TMPDIR:-/tmp}/parity-tgt-raw.XXXXXX.sql")"
  tgt_norm="$(mktemp "${TMPDIR:-/tmp}/parity-tgt-norm.XXXXXX.sql")"
  # shellcheck disable=SC2064
  trap "rm -f '$ref_raw' '$ref_norm' '$tgt_raw' '$tgt_norm'; cleanup" EXIT INT TERM

  log "dumping reference (baseline-built) schema"
  dump_schema_container "$REF_CONTAINER" >"$ref_raw" || die "pg_dump of the reference DB failed"

  log "dumping TARGET schema from \$DATABASE_URL (read-only, via $PG_IMAGE pg_dump)"
  dump_schema_target >"$tgt_raw" || die "pg_dump of the target DB failed (check DATABASE_URL / network / role read access)"

  normalize_dump <"$ref_raw" >"$ref_norm"
  normalize_dump <"$tgt_raw" >"$tgt_norm"

  log "diffing target schema vs baseline-built reference schema"
  local diff_out
  if ! diff_out="$(diff -u "$ref_norm" "$tgt_norm")"; then
    printf '\n'
    warn "===================== SCHEMA PARITY FAILED (DRIFT) ====================="
    warn "The target DB schema does NOT match the schema the committed baseline"
    warn "builds. '-' lines are in the BASELINE (expected) only; '+' lines are in"
    warn "the TARGET only. A botched/partial baseline apply, a manual edit, or"
    warn "real drift produces these. Reconcile before treating the DB as correct."
    warn "======================================================================="
    printf '%s\n' "$diff_out" >&2
    return 1
  fi

  printf '\n'
  log "===================== SCHEMA PARITY: OK ====================="
  log "The target DB schema is IDENTICAL to the committed baseline schema"
  log "(tables, columns + types, indexes, constraints, sequences, functions,"
  log "triggers, RLS ENABLE/FORCE, policies, comments)."
  log "============================================================"
  return 0
}

main
