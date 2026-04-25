#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
source "$SCRIPT_DIR/db-common.sh"

load_database_url
load_database_schema
select_psql_runner
schema_name="$DB_SCHEMA"

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
    ('material_bills'),
    ('audit_events'),
    ('service_item_divisions'),
    ('notifications'),
    ('rentals'),
    ('clock_events'),
    ('schema_migrations')
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
expected_division_columns(table_name) as (
  values
    ('labor_entries'),
    ('estimate_lines'),
    ('takeoff_measurements')
),
expected_project_site_columns(column_name) as (
  values
    ('site_lat'),
    ('site_lng'),
    ('site_radius_m')
),
expected_queue_columns(table_name, column_name) as (
  values
    ('mutation_outbox', 'attempt_count'),
    ('mutation_outbox', 'next_attempt_at'),
    ('mutation_outbox', 'applied_at'),
    ('mutation_outbox', 'error'),
    ('sync_events', 'attempt_count'),
    ('sync_events', 'next_attempt_at'),
    ('sync_events', 'applied_at'),
    ('sync_events', 'error'),
    ('mutation_outbox', 'sentry_trace'),
    ('mutation_outbox', 'sentry_baggage'),
    ('mutation_outbox', 'request_id'),
    ('sync_events', 'sentry_trace'),
    ('sync_events', 'sentry_baggage'),
    ('sync_events', 'request_id')
),
expected_required_columns(table_name, column_name) as (
  values
    ('audit_events', 'request_id'),
    ('audit_events', 'sentry_trace'),
    ('notifications', 'next_attempt_at'),
    ('notifications', 'attempt_count'),
    ('rentals', 'next_invoice_at'),
    ('rentals', 'invoice_cadence_days'),
    ('clock_events', 'inside_geofence'),
    ('takeoff_measurements', 'updated_at'),
    ('schema_migrations', 'checksum')
),
missing_tables as (
  select 'missing table: ' || e.table_name as failure
  from expected_tables e
  left join information_schema.tables t
    on t.table_schema = '$schema_name'
   and t.table_name = e.table_name
  where t.table_name is null
),
missing_origin_columns as (
  select 'missing origin column: ' || e.table_name || '.origin' as failure
  from expected_origin_columns e
  left join information_schema.columns c
    on c.table_schema = '$schema_name'
   and c.table_name = e.table_name
   and c.column_name = 'origin'
  where c.column_name is null
),
missing_division_columns as (
  select 'missing division column: ' || e.table_name || '.division_code' as failure
  from expected_division_columns e
  left join information_schema.columns c
    on c.table_schema = '$schema_name'
   and c.table_name = e.table_name
   and c.column_name = 'division_code'
  where c.column_name is null
),
missing_project_site_columns as (
  select 'missing project site column: projects.' || e.column_name as failure
  from expected_project_site_columns e
  left join information_schema.columns c
    on c.table_schema = '$schema_name'
   and c.table_name = 'projects'
   and c.column_name = e.column_name
  where c.column_name is null
),
missing_queue_columns as (
  select 'missing queue column: ' || e.table_name || '.' || e.column_name as failure
  from expected_queue_columns e
  left join information_schema.columns c
    on c.table_schema = '$schema_name'
   and c.table_name = e.table_name
   and c.column_name = e.column_name
  where c.column_name is null
),
missing_required_columns as (
  select 'missing required column: ' || e.table_name || '.' || e.column_name as failure
  from expected_required_columns e
  left join information_schema.columns c
    on c.table_schema = '$schema_name'
   and c.table_name = e.table_name
   and c.column_name = e.column_name
  where c.column_name is null
)
select failure from missing_tables
union all
select failure from missing_origin_columns
union all
select failure from missing_division_columns
union all
select failure from missing_project_site_columns
union all
select failure from missing_queue_columns
union all
select failure from missing_required_columns
order by failure;
")"

if [ -n "$schema_failures" ]; then
  echo "Database schema check failed:" >&2
  echo "$schema_failures" >&2
  exit 1
fi

echo "Database schema check passed for schema: $schema_name"
