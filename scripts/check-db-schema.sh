#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$SCRIPT_DIR/db-common.sh"

load_database_url
select_psql_runner

schema_failures="$(run_psql_query "
with expected_tables(table_name) as (
  values
    ('companies'),
    ('company_memberships'),
    ('divisions'),
    ('service_items'),
    ('pricing_profiles'),
    ('customers'),
    ('projects'),
    ('workers'),
    ('crew_schedules'),
    ('labor_entries'),
    ('blueprint_documents'),
    ('takeoff_measurements'),
    ('estimate_lines'),
    ('integration_connections'),
    ('integration_mappings'),
    ('sync_events'),
    ('mutation_outbox'),
    ('bonus_rules'),
    ('material_bills')
),
expected_origin_columns(table_name) as (
  values
    ('projects'),
    ('blueprint_documents'),
    ('takeoff_measurements'),
    ('labor_entries'),
    ('material_bills'),
    ('crew_schedules'),
    ('estimate_lines')
),
missing_tables as (
  select 'missing table: ' || e.table_name as failure
  from expected_tables e
  left join information_schema.tables t
    on t.table_schema = 'public'
   and t.table_name = e.table_name
  where t.table_name is null
),
missing_origin_columns as (
  select 'missing origin column: ' || e.table_name || '.origin' as failure
  from expected_origin_columns e
  left join information_schema.columns c
    on c.table_schema = 'public'
   and c.table_name = e.table_name
   and c.column_name = 'origin'
  where c.column_name is null
)
select failure from missing_tables
union all
select failure from missing_origin_columns
order by failure;
")"

if [ -n "$schema_failures" ]; then
  echo "Database schema check failed:" >&2
  echo "$schema_failures" >&2
  exit 1
fi

echo "Database schema check passed"
