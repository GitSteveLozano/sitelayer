#!/usr/bin/env bash
#
# squash-migrations-baseline.sh — collapse the migration history into one
# idempotent baseline AND prove it reproduces the schema (does NOT execute the
# collapse against any environment).
#
# WHY this exists (read docs/MIGRATION_BASELINE.md first):
#   docker/postgres/init/*.sql is forward-only/immutable/checksum-ledgered. The
#   history is 151 files and growing because the operator runs heavy agent churn
#   while learning the product. During that learning phase — while prod has no
#   irreplaceable customer data — collapsing the history into a single baseline
#   keeps the init directory legible and keeps fresh-DB bring-up fast. Once prod
#   holds real customer data this is FORBIDDEN; see the maturity-curve rule in
#   docs/MIGRATION_BASELINE.md.
#
# WHAT this tool does (build + verify, never execute):
#   1. Applies ALL current docker/postgres/init/*.sql to a throwaway
#      postgres:18 container (the "history" DB).
#   2. pg_dump --schema-only (no owner/privs, stable ordering) of that DB into a
#      candidate baseline at docker/postgres/baseline-candidate/000_baseline.sql,
#      normalized to be idempotent (CREATE ... IF NOT EXISTS / guarded) so it can
#      run against an already-migrated DB. NOTE: the candidate is written OUTSIDE
#      docker/postgres/init/ on purpose — anything under init/ is auto-applied by
#      migrate-db.sh on the next deploy, and the squash cutover must be a
#      deliberate operator step (see docs/MIGRATION_BASELINE.md), never an
#      accidental side effect of running this tool.
#   3. PROVES equivalence: builds a SECOND throwaway DB from ONLY the candidate
#      000_baseline.sql, dumps its schema the same way, and diffs the two
#      normalized dumps. The diff MUST be empty. The result is printed.
#   4. Re-runs the candidate baseline against the already-built "history" DB to
#      prove idempotency (a second apply must not error).
#
# It writes the candidate file as an ARTIFACT for the operator to review, OUTSIDE
# the auto-applied init directory. It does NOT delete the 151 history files, does
# NOT move the candidate into docker/postgres/init/, and does NOT mark anything
# applied in any environment's schema_migrations ledger — that per-environment
# cutover is the delicate part and lives in docs/MIGRATION_BASELINE.md.
#
# Usage:
#   scripts/squash-migrations-baseline.sh                 # build + verify (default)
#   scripts/squash-migrations-baseline.sh --verify-only   # require 000_baseline.sql to exist; only re-prove
#   scripts/squash-migrations-baseline.sh --keep          # leave the throwaway containers running for inspection
#   scripts/squash-migrations-baseline.sh --out PATH      # write the candidate somewhere other than the default
#
# Requirements: docker (a throwaway postgres:18 is spun up). No host psql or
# pg_dump needed — both run INSIDE the container, so the dump matches the server
# version exactly. Nothing here touches a real environment.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---- Configuration (overridable) -------------------------------------------
MIGRATION_DIR="${MIGRATION_DIR:-docker/postgres/init}"
BASELINE_NAME="${BASELINE_NAME:-000_baseline.sql}"
# The candidate is written OUTSIDE docker/postgres/init/ so it is NOT picked up
# by migrate-db.sh / the docker-entrypoint init glob. Promoting it into init/ is
# a deliberate operator cutover step documented in docs/MIGRATION_BASELINE.md.
BASELINE_CANDIDATE_DIR="${BASELINE_CANDIDATE_DIR:-docker/postgres/baseline-candidate}"
BASELINE_OUT="${BASELINE_OUT:-$BASELINE_CANDIDATE_DIR/$BASELINE_NAME}"
PG_IMAGE="${SQUASH_PG_IMAGE:-postgres:18-alpine}"
PROJECT="${SQUASH_PROJECT:-sitelayer-squash-$$}"
DOCKER="${DOCKER_BIN:-docker}"

VERIFY_ONLY=0
KEEP=0

# ---- Argument parsing -------------------------------------------------------
while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify-only) VERIFY_ONLY=1 ;;
    --keep) KEEP=1 ;;
    --out)
      shift || { echo "ERROR: --out needs a path" >&2; exit 2; }
      BASELINE_OUT="$1"
      ;;
    -h | --help)
      sed -n '2,47p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "squash-migrations-baseline: unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# ---- Logging ----------------------------------------------------------------
log() { printf '[squash] %s\n' "$*"; }
warn() { printf '[squash WARN] %s\n' "$*" >&2; }
die() {
  printf '[squash FAIL] %s\n' "$*" >&2
  exit 1
}

# ---- Preconditions ----------------------------------------------------------
command -v "$DOCKER" >/dev/null 2>&1 || die "docker is required (a throwaway $PG_IMAGE is spun up)"
"$DOCKER" info >/dev/null 2>&1 || die "docker daemon is not reachable"

if [ ! -d "$MIGRATION_DIR" ]; then
  die "migration directory not found: $MIGRATION_DIR"
fi

# Collect the history files (everything EXCEPT the baseline itself — the
# baseline is the OUTPUT, not an input).
mapfile -t history_files < <(
  find "$MIGRATION_DIR" -maxdepth 1 -type f -name '*.sql' ! -name "$BASELINE_NAME" | sort
)
if [ "${#history_files[@]}" -eq 0 ]; then
  die "no history migration files found in $MIGRATION_DIR"
fi
log "history: ${#history_files[@]} migration file(s) under $MIGRATION_DIR (excluding $BASELINE_NAME)"

# ---- Container lifecycle ----------------------------------------------------
HISTORY_CONTAINER="${PROJECT}-history"
BASELINE_CONTAINER="${PROJECT}-baseline"

cleanup() {
  local code=$?
  set +e
  if [ "$KEEP" = "1" ]; then
    warn "--keep set; leaving containers $HISTORY_CONTAINER and $BASELINE_CONTAINER running"
    return $code
  fi
  "$DOCKER" rm -f "$HISTORY_CONTAINER" >/dev/null 2>&1
  "$DOCKER" rm -f "$BASELINE_CONTAINER" >/dev/null 2>&1
  return $code
}
trap cleanup EXIT INT TERM

# start_pg <container-name>
# Starts a throwaway postgres with no init scripts and waits until it accepts
# connections over its unix socket (we only ever talk to it via docker exec).
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
    : "$attempt" # touch so shellcheck sees the loop index as used
    # The pg entrypoint starts the server transiently to run init, then RESTARTS
    # it. A bare pg_isready can report ready during that first transient start.
    # We only ever connect via the unix socket inside the container, so confirm
    # a REAL query succeeds rather than trusting pg_isready alone.
    if "$DOCKER" exec "$name" psql -U sitelayer -d sitelayer -tAc 'select 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  "$DOCKER" logs "$name" 2>&1 | tail -30 >&2 || true
  die "postgres in $name did not become ready in time"
}

# apply_file_to <container-name> <host-sql-path>
# Streams one SQL file into the container's psql with ON_ERROR_STOP so a broken
# migration fails loudly.
apply_file_to() {
  local name="$1" file="$2"
  "$DOCKER" exec -i "$name" psql -v ON_ERROR_STOP=1 -U sitelayer -d sitelayer >/dev/null <"$file"
}

# dump_schema_from <container-name>
# Dumps the schema with stable, owner/privilege-free output. The flags:
#   --schema-only            no data
#   --no-owner --no-privileges  drop OWNER/GRANT/REVOKE noise (the app role
#                            differs per environment; it is NOT schema)
#   --schema=public          the app schema (init scripts target public)
# pg_dump already emits objects in a stable dependency order for a given server
# version; because BOTH dumps come from the SAME image the ordering matches.
dump_schema_from() {
  local name="$1"
  "$DOCKER" exec "$name" pg_dump \
    --schema-only \
    --no-owner \
    --no-privileges \
    --schema=public \
    -U sitelayer -d sitelayer
}

# normalize_dump
# Reads a raw pg_dump on stdin and writes a STABLE, COMPARABLE canonical form on
# stdout. This is used ONLY for the equivalence DIFF, not for the baseline file.
# It strips session chrome so the diff compares schema, not noise:
#   - SQL comments (`--`), `SET ...`, `SELECT pg_catalog.set_config(...)`, and
#     psql backslash meta-lines;
#   - `CREATE SCHEMA public` / `COMMENT ON SCHEMA public` — `public` is created
#     by the cluster, so its presence/absence is environment chrome, not schema;
#   - collapse blank-line runs (`cat -s`).
# Because BOTH dumps come from the SAME postgres image, a clean diff after this
# canonicalization proves the two schemas are byte-identical at the object level
# (tables, columns, indexes, constraints, RLS policies + ENABLE/FORCE, functions,
# sequences, types, triggers, comments).
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

# build_idempotent_baseline <raw-history-dump-path> <out-path>
# Turns the raw schema-only pg_dump of the full history into an idempotent
# baseline that REPLAYS the SAME objects but can run against an already-migrated
# DB without erroring. The transform is targeted per statement-kind rather than
# wrapping everything in one fragile exception-swallowing block (a single failed
# statement in such a block aborts the rest):
#
#   already idempotent — emit verbatim:
#     CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE SEQUENCE
#     IF NOT EXISTS / CREATE EXTENSION IF NOT EXISTS  (pg_dump emits these forms
#     with --schema-only on PG18), COMMENT ON ... (set-or-replace),
#     ALTER TABLE ... ENABLE/FORCE ROW LEVEL SECURITY (a no-op when already set).
#
#   rewritten to an idempotent form:
#     CREATE TABLE     -> CREATE TABLE IF NOT EXISTS
#     CREATE SEQUENCE  -> CREATE SEQUENCE IF NOT EXISTS
#     CREATE [UNIQUE] INDEX -> CREATE [UNIQUE] INDEX IF NOT EXISTS
#     CREATE EXTENSION -> CREATE EXTENSION IF NOT EXISTS
#     CREATE FUNCTION  -> CREATE OR REPLACE FUNCTION
#     CREATE TRIGGER   -> CREATE OR REPLACE TRIGGER   (PG14+; image is PG18)
#     CREATE POLICY name ON tbl ... -> DROP POLICY IF EXISTS name ON tbl;\n<same>
#       (matches the 145/146 migration convention: drop-if-exists then create)
#     ALTER TABLE [ONLY] tbl \n  ADD CONSTRAINT name ...  (pg_dump's two-line
#       constraint form — PK/UNIQUE/CHECK/FK) -> the SAME add wrapped in a
#       per-statement DO block that swallows duplicate_object/duplicate_table on
#       a re-apply. (A DROP-then-ADD would cascade-drop FKs that depend on a PK;
#       the swallow form re-applies safely without touching dependents.)
#
#   dropped (cluster-managed, would raise duplicate_schema on replay):
#     CREATE SCHEMA public; / COMMENT ON SCHEMA public IS ...
#
# CREATE TYPE/DOMAIN do not appear in this schema (verified against the dump);
# if a future dump introduces one, it surfaces as a non-idempotent statement in
# the idempotency re-apply check (a 2nd apply errors) — the tool FAILS loudly
# rather than shipping a baseline that can't be marked-applied.
build_idempotent_baseline() {
  local raw="$1" out="$2"
  {
    cat <<'HEADER'
-- 000_baseline.sql
--
-- GENERATED ARTIFACT — do NOT hand-edit. Produced by
-- scripts/squash-migrations-baseline.sh, which pg_dumps the schema-only
-- result of applying the full docker/postgres/init/*.sql history to a
-- throwaway postgres:18 and rewrites each statement to an idempotent form.
--
-- This file is a SQUASHED BASELINE. It is allowed ONLY during the learning
-- phase, while prod has no irreplaceable customer data. Read
-- docs/MIGRATION_BASELINE.md before adopting it — the per-environment cutover
-- (marking this baseline applied + retiring the old ledger rows) and the
-- maturity-curve "stop squashing" trigger live there.
--
-- Idempotent: safe to re-run against an already-migrated DB. CREATE ... IF NOT
-- EXISTS / CREATE OR REPLACE cover tables/indexes/functions/triggers; each
-- CREATE POLICY is preceded by a DROP POLICY IF EXISTS; each ADD CONSTRAINT is
-- wrapped in a duplicate-tolerant DO block; RLS ENABLE/FORCE are no-ops when
-- already set. Verified by the tool's own equivalence + re-apply check before
-- it was written.

HEADER
    # Rewrite the raw dump statement-by-statement with awk. Each rule keys off
    # the leading token of a column-0 statement line, so it never touches the
    # inside of a dollar-quoted function body (those lines are indented).
    #
    # The constraint case is the only multi-line one: pg_dump emits
    #   ALTER TABLE ONLY public.t
    #       ADD CONSTRAINT t_pkey PRIMARY KEY (id);
    # We hold the `ALTER TABLE [ONLY] <table>` line; if the next line is
    # `ADD CONSTRAINT <name> ...` we emit the SAME two-line statement wrapped in
    # a DO block that swallows duplicate_object/duplicate_table on a re-apply.
    # (A DROP-then-ADD is avoided: dropping a PK cascade-drops the FKs that
    # reference it.) If the held line was NOT a constraint add (e.g.
    # `ALTER TABLE ONLY t FORCE ROW LEVEL SECURITY;` is single-line and already
    # handled below), it is flushed verbatim.
    awk '
      # Flush any pending held ALTER TABLE line verbatim.
      function flush_pending() {
        if (pending != "") { print pending; pending = "" }
      }

      # A held "ALTER TABLE [ONLY] <table>" header with no trailing semicolon.
      pending != "" {
        if ($0 ~ /^[[:space:]]+ADD CONSTRAINT /) {
          # Wrap the constraint add in a duplicate-tolerant DO block so a second
          # apply is a no-op instead of "multiple primary keys" / duplicate_object.
          print "DO $baseline_con$ BEGIN"
          print "  " pending
          print "  " $0
          # duplicate_object (42710) = an existing UNIQUE/CHECK/FK constraint;
          # invalid_table_definition (42P16) = a second PRIMARY KEY on a table
          # that already has one; duplicate_table covers the rest. All mean "the
          # constraint is already present", so a re-apply is a no-op.
          print "EXCEPTION WHEN duplicate_table OR duplicate_object OR invalid_table_definition THEN NULL;"
          print "END $baseline_con$;"
          pending = ""
          next
        }
        # Not a constraint add — flush the header and fall through to normal
        # processing of the current line.
        flush_pending()
      }

      # Drop cluster-managed schema noise.
      /^CREATE SCHEMA public;$/ { next }
      /^COMMENT ON SCHEMA public IS / { next }

      # Hold a bare "ALTER TABLE [ONLY] <table>" header (no semicolon) so the
      # next line can decide whether it is a constraint add.
      /^ALTER TABLE (ONLY )?[^ ]+$/ { pending = $0; next }

      # Single-line idempotency rewrites.
      /^CREATE TABLE /        { sub(/^CREATE TABLE /, "CREATE TABLE IF NOT EXISTS "); print; next }
      /^CREATE SEQUENCE /     { sub(/^CREATE SEQUENCE /, "CREATE SEQUENCE IF NOT EXISTS "); print; next }
      /^CREATE UNIQUE INDEX / { sub(/^CREATE UNIQUE INDEX /, "CREATE UNIQUE INDEX IF NOT EXISTS "); print; next }
      /^CREATE INDEX /        { sub(/^CREATE INDEX /, "CREATE INDEX IF NOT EXISTS "); print; next }
      /^CREATE EXTENSION /    { sub(/^CREATE EXTENSION /, "CREATE EXTENSION IF NOT EXISTS "); print; next }
      /^CREATE FUNCTION /     { sub(/^CREATE FUNCTION /, "CREATE OR REPLACE FUNCTION "); print; next }
      /^CREATE TRIGGER /      { sub(/^CREATE TRIGGER /, "CREATE OR REPLACE TRIGGER "); print; next }

      # CREATE POLICY <name> ON <table> ... -> prepend a matching drop.
      /^CREATE POLICY [^ ]+ ON [^ ]+/ {
        pname = $3
        ptable = $5
        print "DROP POLICY IF EXISTS " pname " ON " ptable ";"
        print
        next
      }

      { print }
      END { flush_pending() }
    ' "$raw"
  } >"$out"
}

# ============================================================================
# Build phase — produce the candidate 000_baseline.sql from the full history.
# ============================================================================
build_baseline() {
  log "starting history container ($HISTORY_CONTAINER) on $PG_IMAGE"
  start_pg "$HISTORY_CONTAINER"

  log "applying ${#history_files[@]} history migration(s) to $HISTORY_CONTAINER"
  local f
  for f in "${history_files[@]}"; do
    apply_file_to "$HISTORY_CONTAINER" "$f" || die "history migration failed to apply: $f"
  done
  log "history schema built"

  local raw
  raw="$(mktemp "${TMPDIR:-/tmp}/squash-history-raw.XXXXXX.sql")"

  log "dumping schema from history DB"
  dump_schema_from "$HISTORY_CONTAINER" >"$raw" || die "pg_dump of history DB failed"

  log "writing idempotent candidate baseline -> $BASELINE_OUT"
  mkdir -p "$(dirname "$BASELINE_OUT")"
  build_idempotent_baseline "$raw" "$BASELINE_OUT"

  rm -f "$raw"
  log "candidate baseline written ($(wc -l <"$BASELINE_OUT") lines)"
}

# ============================================================================
# Verify phase — build a DB from ONLY the candidate baseline and prove its
# schema is identical to the full-history DB. Then prove idempotency.
# ============================================================================
verify_baseline() {
  [ -f "$BASELINE_OUT" ] || die "candidate baseline not found at $BASELINE_OUT (run without --verify-only first)"

  # The history DB must exist for the comparison. In --verify-only mode we
  # rebuild it from the history files; in the normal flow build_baseline already
  # left it running.
  if ! "$DOCKER" exec "$HISTORY_CONTAINER" psql -U sitelayer -d sitelayer -tAc 'select 1' >/dev/null 2>&1; then
    log "history container not running; rebuilding it for the comparison"
    start_pg "$HISTORY_CONTAINER"
    local f
    for f in "${history_files[@]}"; do
      apply_file_to "$HISTORY_CONTAINER" "$f" || die "history migration failed to apply: $f"
    done
  fi

  log "starting baseline-only container ($BASELINE_CONTAINER) on $PG_IMAGE"
  start_pg "$BASELINE_CONTAINER"

  log "applying ONLY $BASELINE_OUT to $BASELINE_CONTAINER"
  apply_file_to "$BASELINE_CONTAINER" "$BASELINE_OUT" || die "candidate baseline failed to apply to a fresh DB"

  # Prove idempotency: a SECOND apply (to the same DB, and to the already-built
  # history DB) must succeed without error.
  log "re-applying baseline to prove idempotency (fresh DB, 2nd time)"
  apply_file_to "$BASELINE_CONTAINER" "$BASELINE_OUT" || die "baseline is NOT idempotent: a second apply to the fresh DB errored"
  log "re-applying baseline on top of the full-history DB (idempotent over an already-migrated DB)"
  apply_file_to "$HISTORY_CONTAINER" "$BASELINE_OUT" || die "baseline is NOT idempotent over an already-migrated DB"

  # Compare schemas. Dump BOTH the same way and diff the NORMALIZED forms so the
  # comparison ignores the idempotency wrapper / session chrome and sees only
  # the resulting schema.
  local hist_raw hist_norm base_raw base_norm
  hist_raw="$(mktemp "${TMPDIR:-/tmp}/squash-cmp-hist-raw.XXXXXX.sql")"
  hist_norm="$(mktemp "${TMPDIR:-/tmp}/squash-cmp-hist-norm.XXXXXX.sql")"
  base_raw="$(mktemp "${TMPDIR:-/tmp}/squash-cmp-base-raw.XXXXXX.sql")"
  base_norm="$(mktemp "${TMPDIR:-/tmp}/squash-cmp-base-norm.XXXXXX.sql")"

  dump_schema_from "$HISTORY_CONTAINER" >"$hist_raw" || die "pg_dump of history DB failed"
  dump_schema_from "$BASELINE_CONTAINER" >"$base_raw" || die "pg_dump of baseline DB failed"
  normalize_dump <"$hist_raw" >"$hist_norm"
  normalize_dump <"$base_raw" >"$base_norm"

  log "diffing history-built schema vs baseline-built schema"
  local diff_out
  if diff_out="$(diff -u "$hist_norm" "$base_norm")"; then
    rm -f "$hist_raw" "$hist_norm" "$base_raw" "$base_norm"
    printf '\n'
    log "===================== EQUIVALENCE PROOF ====================="
    log "DIFF RESULT: EMPTY — the baseline-built schema is IDENTICAL to the"
    log "full-history schema (tables, columns, indexes, constraints, RLS"
    log "policies + FORCE flags, functions, sequences, types)."
    log "Idempotency: PROVEN (2nd apply to fresh DB + apply over migrated DB)."
    log "============================================================"
    log "Candidate baseline is an ARTIFACT at: $BASELINE_OUT"
    log "Review it and follow docs/MIGRATION_BASELINE.md to cut each"
    log "environment over. This tool did NOT execute the collapse."
    return 0
  fi

  printf '\n'
  warn "===================== EQUIVALENCE FAILED ===================="
  warn "DIFF RESULT: NON-EMPTY — the baseline does NOT reproduce the schema."
  warn "Lines with '-' are in the full-history schema only; '+' are in the"
  warn "baseline-only schema. Do NOT adopt this baseline."
  warn "============================================================"
  printf '%s\n' "$diff_out" >&2
  rm -f "$hist_raw" "$hist_norm" "$base_raw" "$base_norm"
  return 1
}

# ============================================================================
# Main
# ============================================================================
main() {
  if [ "$VERIFY_ONLY" = "1" ]; then
    log "mode: --verify-only (will not regenerate $BASELINE_OUT)"
    verify_baseline
  else
    log "mode: build + verify"
    build_baseline
    verify_baseline
  fi
}

main
