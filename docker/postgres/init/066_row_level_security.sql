-- Row-level security policies for company-scoped tables.
--
-- Phase 1 (this migration): define policies but DO NOT enable RLS. Policies
-- exist on every company-scoped table but are dormant until a follow-up
-- migration runs `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` per table. This
-- is "shadow mode" — the app sets `app.company_id` via `SET LOCAL` on every
-- transaction (see apps/api/src/mutation-tx.ts and route-context wiring) so
-- that when RLS flips on, the policies already have a value to compare to.
--
-- The policy shape is the same on every table:
--   USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
--   WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id())
--
-- When the GUC is unset the policy is permissive (NULL match passes), so
-- migrations, replay tooling, and any unmigrated query path keep working.
-- Once every route sets the GUC, a follow-up migration tightens this to a
-- strict equality check by enabling RLS. See docs/SECURITY_RLS.md.

CREATE OR REPLACE FUNCTION app_current_company_id() RETURNS uuid
  LANGUAGE sql
  STABLE
AS $$
  SELECT NULLIF(current_setting('app.company_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION app_current_company_id() IS
  'Reads app.company_id GUC set via SET LOCAL on each request transaction. Returns NULL when unset (RLS permissive).';

-- Apply the policy on every company-scoped table via a single DO block so the
-- list stays a literal SQL array — easy to audit and modify.
DO $rls$
DECLARE
  scoped_table text;
  scoped_tables text[] := ARRAY[
    'ai_insights',
    'audit_events',
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
    'mutation_outbox',
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
    'sync_events',
    'takeoff_measurements',
    'takeoff_measurement_tags',
    'time_review_runs',
    'worker_issue_attachments',
    'worker_issues',
    'workers',
    'workflow_event_log'
  ];
BEGIN
  FOREACH scoped_table IN ARRAY scoped_tables LOOP
    -- Skip silently if the table doesn't exist yet (e.g. a follow-up migration
    -- added the table but this RLS migration hasn't been backported). The
    -- intent is for new company-scoped tables to add their own policy in the
    -- same migration that creates them; this loop covers the existing surface.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = scoped_table
    ) THEN
      RAISE NOTICE 'rls: skipping % (table missing)', scoped_table;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS company_isolation ON %I', scoped_table);
    EXECUTE format(
      'CREATE POLICY company_isolation ON %I
         FOR ALL
         USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
         WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id())',
      scoped_table
    );
  END LOOP;
END
$rls$;
