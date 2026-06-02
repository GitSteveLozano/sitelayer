-- 152_company_settings.sql
--
-- ⚠️ RENUMBER FLAG: max existing migration at author time was 150 (with 145/146
-- from the RLS slice already landed; 147–149 + 151 are unused gaps). This file
-- is numbered 152 to clear the 151 gap and sit one above 150. If a sibling slice
-- lands a 152 first, renumber this to the next free number — it is purely
-- additive (one new table + its RLS), so the renumber is a rename only, no
-- content change (the schema_migrations sha256 ledger keys on the FILE NAME, so
-- a rename re-applies cleanly on a fresh DB and is a no-op where already applied
-- under the old name only if the name matches — on collision pick a fresh name).
--
-- ── WHY THIS TABLE EXISTS ───────────────────────────────────────────────
-- Per-company config has been accreting as NEW COLUMNS, one migration per
-- setting: migration 144 added integration_connections.qbo_live_enabled, 150
-- added companies.notification_from_email / notification_from_name. Each new
-- per-company toggle has been a SCHEMA migration — exactly the migration-churn
-- this slice (company-config) is meant to end. On DigitalOcean Managed Postgres
-- (the only durable tier) every migration is forward-only + immutable +
-- checksum-ledgered, so the cost of "add the 20th per-company flag" is a real DB
-- change that has to ship through the deploy gate.
--
-- This table makes the NEXT per-company setting a CODE change, not a migration:
-- a generic (company_id, key) → jsonb value store. getCompanySetting() /
-- setCompanySetting() (packages/domain/src/company-settings.ts) read and write
-- it with a typed default supplied at the call site, so a new toggle is just a
-- new key + a new default constant — no ALTER TABLE, no new migration, no deploy
-- gate on the schema.
--
-- ── WHY A NEW TABLE, NOT companies.modules (migration 062) ──────────────
-- companies.modules is a FIXED-SHAPE typed boolean feature-pack (takeoff,
-- estimating, scaffold_design, …) consumed by a typed API + UI
-- (apps/api/src/routes/companies.ts GET/PATCH /modules, CompanyModulesPatchSchema).
-- It is the wrong home for arbitrary, heterogeneously-typed settings (a string
-- sender address, a number rate cap, a per-integration flag): widening it would
-- erode its typed contract and it lives on `companies`, the tenant ROOT, which is
-- deliberately NOT in the RLS-FORCE set (access gated by company_memberships, see
-- migration 150's header + docs/MULTI_TENANCY.md). A dedicated company-scoped
-- child table gets the SAME app.company_id RLS-FORCE every other per-tenant table
-- has, so the store is isolated at the DB layer, not just the app layer.
--
-- ── SCHEMA ──────────────────────────────────────────────────────────────
-- One row per (company_id, key). `value` is jsonb so a setting can be a bool,
-- string, number, or small object without a schema change. updated_at records
-- the last write and is set EXPLICITLY in the helper's upsert SQL
-- (`updated_at = now()`), matching the repo convention (no updated_at triggers
-- exist anywhere — qbo-sync-run.ts et al. all set it in the UPDATE). The
-- (company_id, key) unique key backs the helper's upsert (ON CONFLICT … DO UPDATE).
--
-- ── ROLLOUT SAFETY ──────────────────────────────────────────────────────
-- Additive / forward-only / idempotent (CREATE TABLE/INDEX IF NOT EXISTS; DROP
-- POLICY IF EXISTS before CREATE; ENABLE/FORCE are no-ops when already set). No
-- data is backfilled — the existing qbo_live_enabled / notification_from_*
-- columns are untouched and keep working; this table is the path FORWARD for the
-- next settings, and getCompanySetting can optionally read those two THROUGH it
-- (read-through in the helper), but nothing is migrated or dropped. New code that
-- reads a key returns the call-site default when the row is absent, so a worker
-- that deploys ahead of this migration is safe (it catches undefined_table /
-- 42P01 → default) and old code never touches the table.

CREATE TABLE IF NOT EXISTS company_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_settings_company_key_uniq UNIQUE (company_id, key)
);

COMMENT ON TABLE company_settings IS
  'Generic per-company (key -> jsonb value) settings store. THE convention for '
  'per-company config: a new toggle is a new key + a call-site default '
  '(getCompanySetting / setCompanySetting in @sitelayer/domain), NOT a new '
  'column + migration. company_id-scoped, RLS ENABLE+FORCE like every other '
  'tenant child table. Does not replace the typed companies.modules feature-pack '
  '(migration 062) nor the existing qbo_live_enabled (144) / notification_from_* '
  '(150) columns — it is the path forward for the NEXT settings.';

COMMENT ON COLUMN company_settings.key IS
  'Dotted/namespaced setting key (e.g. "notifications.digest_enabled", '
  '"billing.auto_invoice_cap"). Unique per company. Defined as a constant in '
  'packages/domain/src/company-settings.ts so the key + its default + its type '
  'live together in code.';

COMMENT ON COLUMN company_settings.value IS
  'jsonb-encoded setting value (bool / string / number / small object). The '
  'helper validates/parses it against the call-site default''s type; a value '
  'whose type does not match the default falls back to the default.';

-- ── RLS: same app.company_id isolation as every per-tenant child table ───
-- Policy body is IDENTICAL to migrations 066 / 085 / 101 / 145 / 146:
-- permissive when app.company_id is unset (so migrations, replay tooling, the
-- scenario seeder, and the worker's permissive paths keep working) and strict
-- equality once the GUC is bound, with WITH CHECK rejecting a cross-company
-- write. ENABLE + FORCE because on DO Managed Postgres the app connects as the
-- table-owner role, which would otherwise bypass RLS (see migration 085). The
-- RLS-FORCE coverage audit (apps/api/src/routes/rls-force-audit.ts) reads
-- pg_class.relforcerowsecurity for every company_id table and FAILS the deploy
-- gate if this table is not FORCEd — so this block is load-bearing, not optional.
DO $company_settings_rls$
BEGIN
  IF to_regclass('company_settings') IS NULL THEN
    RAISE NOTICE 'skip RLS for missing table company_settings';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS company_isolation ON company_settings;
  CREATE POLICY company_isolation ON company_settings
    FOR ALL
    USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
    WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());
  ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE company_settings FORCE ROW LEVEL SECURITY;
END
$company_settings_rls$;
