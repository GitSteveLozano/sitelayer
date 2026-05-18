-- 085_rls_enable_phase_3.sql
--
-- Phase 3 of the RLS rollout: ENABLE + FORCE ROW LEVEL SECURITY on the
-- remaining 65 company-scoped domain tables.
--
-- Phase 1 (migration 066) defined the `company_isolation` policy on the
-- full 69-table domain surface but kept RLS DISABLED ("shadow mode") so
-- unmigrated readers wouldn't break.
--
-- Phase 2 (migration 073) flipped ENABLE + FORCE on the four append-only
-- queue tables: audit_events, workflow_event_log, mutation_outbox,
-- sync_events. Migration 078 then NO-FORCE'd those same four so that
-- `pg_dump` running as the table owner can keep producing backups.
--
-- This migration (Phase 3) flips the remaining 65 tables — the policy
-- bodies are already in place from migration 066, so no CREATE POLICY
-- runs here. We only flip the storage-level flags.
--
-- IMPORTANT: the policy from migration 066 stays permissive when
-- `app.company_id` is unset (`USING (app_current_company_id() IS NULL OR
-- ...)`), so legacy / unmigrated code paths (debug routes, cross-company
-- webhooks, replay tooling) keep working after this flip. The real
-- enforcement value is:
--
--   - WITH CHECK fires on every INSERT/UPDATE: a transaction bound to
--     `app.company_id = A` can no longer write a row with
--     `company_id = B`, even by accident.
--   - Reads inside a `withCompanyClient` / `withMutationTx` closure are
--     filtered to the bound company.
--
-- FORCE is required because on DigitalOcean Managed Postgres the
-- migrator runs as the `doadmin` superuser but the app runs as the
-- `sitelayer` role, which is the table owner. Without FORCE the table
-- owner bypasses RLS and the migration is effectively a no-op in prod.
--
-- Tables exempted from FORCE per migration 078 (the pg_dump-as-owner
-- exception list) get ENABLE without FORCE so backup tooling continues
-- to work. Today that list happens to cover only the Phase 2 four
-- tables, none of which are in this migration's set, so the
-- `no_force_tables` exclusion is a structural safeguard (and a hook for
-- future maintainers who add another exempted table) rather than an
-- active filter on the Phase 3 surface.
--
-- Idempotent: re-running the DO block is safe. Postgres treats `ENABLE
-- ROW LEVEL SECURITY` on an already-enabled table as a no-op, and the
-- same is true for `FORCE` on a table that's already forced.

DO $rls_phase3$
DECLARE
  scoped_table text;
  scoped_tables text[] := ARRAY[
    -- The canonical 69-table list from migration 066, minus the 4
    -- Phase 2 tables (audit_events, workflow_event_log, mutation_outbox,
    -- sync_events) already flipped by migration 073.
    'ai_insights',
    'blueprint_documents',
    'blueprint_page_diffs',
    'blueprint_pages',
    'bom_lines',
    'boms',
    'bonus_rules',
    'branches',
    'catalog_parts',
    'clock_events',
    'companycam_photo_imports',
    'company_memberships',
    'crew_schedules',
    'customer_portal_links',
    'customers',
    'daily_log_photos',
    'daily_logs',
    'damage_charges',
    'divisions',
    'estimate_lines',
    'estimate_pushes',
    'estimate_push_lines',
    'estimate_share_links',
    'external_rentals',
    'integration_connections',
    'integration_mappings',
    'inventory_items',
    'inventory_locations',
    'inventory_movements',
    'job_rental_contracts',
    'job_rental_lines',
    'labor_entries',
    'labor_payroll_runs',
    'material_bills',
    'notification_preferences',
    'notifications',
    'payroll_exports',
    'pricing_profiles',
    'project_assignments',
    'project_briefs',
    'projects',
    'push_subscriptions',
    'qbo_custom_field_mappings',
    'rental_billing_run_lines',
    'rental_billing_runs',
    'rental_requests',
    'rentals',
    'rental_share_links',
    'rental_vendors',
    'scaffold_inspections',
    'scaffold_tags',
    'service_item_assemblies',
    'service_item_assembly_components',
    'service_item_divisions',
    'service_items',
    'shipment_events',
    'shipment_lines',
    'shipments',
    'support_debug_packets',
    'takeoff_measurements',
    'takeoff_measurement_tags',
    'time_review_runs',
    'worker_issue_attachments',
    'worker_issues',
    'workers'
  ];
  -- Tables exempted from FORCE per migration 078 so `pg_dump` running as
  -- the table owner can still read them. Today this list overlaps only
  -- with the Phase 2 four, none of which are in scoped_tables above, so
  -- this filter is structural (and a hook for future maintainers).
  no_force_tables text[] := ARRAY[
    'audit_events',
    'workflow_event_log',
    'mutation_outbox',
    'sync_events'
  ];
  enabled_count integer := 0;
  forced_count integer := 0;
  skipped_count integer := 0;
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    -- Skip silently if the table doesn't exist yet. The intent is for
    -- new company-scoped tables to flip RLS in the same migration that
    -- creates them; this loop covers the existing Phase 1 surface.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = scoped_table
    ) THEN
      RAISE NOTICE 'rls phase 3: skipping % (table missing)', scoped_table;
      skipped_count := skipped_count + 1;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    enabled_count := enabled_count + 1;

    IF NOT (scoped_table = ANY (no_force_tables)) THEN
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
      forced_count := forced_count + 1;
    ELSE
      RAISE NOTICE 'rls phase 3: % is on the no-force list (pg_dump owner exemption); ENABLE only', scoped_table;
    END IF;
  END LOOP;

  RAISE NOTICE 'rls phase 3 complete: % enabled, % forced, % skipped (missing tables)',
    enabled_count, forced_count, skipped_count;
END
$rls_phase3$;
