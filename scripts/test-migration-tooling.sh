#!/usr/bin/env bash
#
# test-migration-tooling.sh — focused tests for the migration-baseline tooling
# behavior added/changed alongside docs/MIGRATION_BASELINE.md:
#
#   1. scripts/db-common.sh psql-version gate (psql_local_major_version +
#      select_psql_runner): a psql < MIN_PSQL_MAJOR must NOT be chosen for the
#      apply path (the squashed baseline uses pg_dump-18 \restrict markers).
#   2. scripts/squash-migrations-baseline.sh tier-gating helpers
#      (filter_tier_gated_rows): seed-data rows tied to a tier-gated tenant UUID
#      are dropped; with no gated ids the stream passes through unchanged.
#
# These are pure-shell unit tests — no docker / no real DB. `psql` and `docker`
# are mocked via shell functions so the version-gate branches are exercised
# deterministically. Run: bash scripts/test-migration-tooling.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0
fail=0
note() { printf '[test] %s\n' "$*"; }
ok() {
  pass=$((pass + 1))
  printf '  PASS: %s\n' "$1"
}
bad() {
  fail=$((fail + 1))
  printf '  FAIL: %s\n' "$1" >&2
}

# assert_eq <label> <expected> <actual>
assert_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else
    bad "$1 (expected [$2], got [$3])"
  fi
}

# --------------------------------------------------------------------------
# 1. db-common.sh psql-version gate
# --------------------------------------------------------------------------
# We run each scenario in a clean subshell so the mocks + sourced state do not
# leak between cases. Each subshell prints a single result token.

# run_runner_case <psql-version-string-or-empty> <docker-available 1|0> <min-major>
# Echoes one of: local | docker | reject. `select_psql_runner` calls `exit 1` on
# the reject path, which terminates the subshell — so we run it in a nested
# subshell and map a non-zero exit (with no runner printed) to "reject".
run_runner_case() {
  local psql_ver="$1" have_docker="$2" min="$3"
  local out
  out="$(
    (
      # Mock command -v so only the tools we want appear "installed".
      command() {
        if [ "${1:-}" = "-v" ]; then
          case "${2:-}" in
            psql) [ -n "$psql_ver" ] && return 0 || return 1 ;;
            docker) [ "$have_docker" = "1" ] && return 0 || return 1 ;;
            *) builtin command "$@" ;;
          esac
        fi
        builtin command "$@"
      }
      psql() {
        if [ "${1:-}" = "--version" ]; then
          printf 'psql (PostgreSQL) %s\n' "$psql_ver"
          return 0
        fi
        return 0
      }
      # shellcheck disable=SC1091
      source "$SCRIPT_DIR/db-common.sh"
      MIN_PSQL_MAJOR="$min"
      select_psql_runner 2>/dev/null
      printf '%s\n' "$PSQL_RUNNER"
    ) 2>/dev/null
  )"
  if [ -z "$out" ]; then
    printf 'reject\n'
  else
    printf '%s\n' "$out"
  fi
}

note "db-common.sh: select_psql_runner version gate"
assert_eq "psql v18 + docker -> local"            local  "$(run_runner_case 18.1 1 18)"
assert_eq "psql v16 + docker -> docker fallback"  docker "$(run_runner_case 16.14 1 18)"
assert_eq "psql v16 + NO docker -> reject"        reject "$(run_runner_case 16.14 0 18)"
assert_eq "psql v16 + MIN=16 override -> local"   local  "$(run_runner_case 16.14 1 16)"
assert_eq "no psql + docker -> docker"            docker "$(run_runner_case '' 1 18)"

# psql_local_major_version parses the first dotted token's major.
note "db-common.sh: psql_local_major_version parsing"
maj="$(
  (
    psql() { printf 'psql (PostgreSQL) 18.3 (Debian 18.3-1)\n'; }
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/db-common.sh"
    psql_local_major_version
  )
)"
assert_eq "parses major 18 from '18.3 (Debian ...)'" 18 "$maj"

# --------------------------------------------------------------------------
# 2. squash-migrations-baseline.sh tier-gating: filter_tier_gated_rows
# --------------------------------------------------------------------------
# Source only the helper. The script's `main` runs at the bottom, so we guard by
# extracting the function via `source` in a subshell with mocks that make the
# preflight short-circuit before main does any docker work. Simpler + robust:
# define a tiny harness that re-implements nothing — we eval just the function
# body by sourcing the file with `main` neutralized.
note "squash-migrations-baseline.sh: filter_tier_gated_rows"

# Load a helper from the squash script in a subshell. The script runs top-level
# preflight + `main` when sourced, so we: (a) mock `docker` to satisfy the
# `docker info` precondition, (b) point MIGRATION_DIR at a temp dir holding one
# .sql file so the "no history" precondition passes, and (c) override `main` to a
# no-op AFTER sourcing is set up — but since the real `main` is invoked at the
# bottom of the file, we instead let it run with a stubbed build/verify by
# pre-defining `main` is not possible; simplest is to source with a temp
# MIGRATION_DIR and a `main` that the script's own definition will overwrite,
# then call the target helper. To stop the real `main` from doing work, we stub
# the two phase entry points it calls.
SQUASH_TMP_MIGDIR="$(mktemp -d "${TMPDIR:-/tmp}/squash-fn-mig.XXXXXX")"
printf -- '-- dummy\n' >"$SQUASH_TMP_MIGDIR/001_dummy.sql"

load_squash_fn() {
  (
    docker() {
      # Satisfy `docker info`; everything else is a harmless no-op for unit use.
      return 0
    }
    # Neutralize the build/verify phases so the script's own `main` is a no-op.
    build_baseline() { :; }
    verify_baseline() { :; }
    MIGRATION_DIR="$SQUASH_TMP_MIGDIR"
    set +e
    # Capture the helper + its args, then CLEAR positional params before
    # sourcing — `source` inherits $@, and the squash script parses $@ as CLI
    # flags at top level (an unknown one exits 2). After sourcing with no args,
    # invoke the captured helper.
    local -a call=("$@")
    set --
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/squash-migrations-baseline.sh" >/dev/null 2>&1
    "${call[@]}"
  )
}

sample_dump='INSERT INTO public.companies VALUES ('"'"'KEEP-ID'"'"', '"'"'la-operations'"'"');
INSERT INTO public.companies VALUES ('"'"'GATED-ID'"'"', '"'"'e2e-fixtures'"'"');
INSERT INTO public.company_memberships VALUES ('"'"'m1'"'"', '"'"'GATED-ID'"'"', '"'"'e2e-admin'"'"');
INSERT INTO public.divisions VALUES ('"'"'d1'"'"', '"'"'KEEP-ID'"'"', '"'"'Framing'"'"');'

# With a gated id, lines referencing GATED-ID are dropped.
filtered="$(printf '%s\n' "$sample_dump" | load_squash_fn filter_tier_gated_rows 'GATED-ID')"
gated_left="$(printf '%s\n' "$filtered" | grep -c 'GATED-ID')"
keep_left="$(printf '%s\n' "$filtered" | grep -c 'KEEP-ID')"
assert_eq "gated rows removed"        0 "$gated_left"
assert_eq "kept rows preserved (2)"   2 "$keep_left"

# With NO gated id, the stream passes through unchanged.
passthrough="$(printf '%s\n' "$sample_dump" | load_squash_fn filter_tier_gated_rows '')"
in_lines="$(printf '%s\n' "$sample_dump" | grep -c .)"
out_lines="$(printf '%s\n' "$passthrough" | grep -c .)"
assert_eq "empty gated-id list = passthrough" "$in_lines" "$out_lines"

# --------------------------------------------------------------------------
rm -rf "$SQUASH_TMP_MIGDIR" 2>/dev/null || true
printf '\n[test] %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
