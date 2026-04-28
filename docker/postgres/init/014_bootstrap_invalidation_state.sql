-- Bootstrap response invalidation token.
--
-- /api/bootstrap fans out across 11 tables. We don't have a uniform
-- updated_at column on those tables (divisions, workers, pricing_profiles,
-- bonus_rules, integration_connections, crew_schedules, labor_entries lack
-- one), so a "max(updated_at)" ETag won't reliably detect change. Instead,
-- per-statement triggers bump a single token per company on any
-- INSERT/UPDATE/DELETE on a bootstrap table. The /api/bootstrap handler
-- reads the token, returns it as the response ETag, and short-circuits
-- with 304 when the client's If-None-Match matches.
--
-- We use STATEMENT-level triggers with REFERENCING TABLE clauses so a bulk
-- insert/update doesn't fire the bump 10k times — one bump per (statement,
-- affected company) is enough for cache invalidation correctness.

CREATE TABLE IF NOT EXISTS company_bootstrap_state (
  company_id uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Backfill: every existing company starts with a token so reads can begin
-- caching immediately after this migration applies.
INSERT INTO company_bootstrap_state (company_id)
SELECT id FROM companies
ON CONFLICT (company_id) DO NOTHING;

CREATE OR REPLACE FUNCTION bump_company_bootstrap_state() RETURNS trigger AS $$
DECLARE
  affected uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT company_id) INTO affected FROM old_rows;
  ELSIF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT company_id) INTO affected FROM new_rows;
  ELSE
    -- UPDATE: include both, in case an UPDATE moved the row across companies
    -- (it shouldn't, but the bump is correctness, not cost-sensitive).
    SELECT array_agg(DISTINCT company_id) INTO affected FROM (
      SELECT company_id FROM new_rows
      UNION
      SELECT company_id FROM old_rows
    ) cs;
  END IF;

  IF affected IS NOT NULL THEN
    INSERT INTO company_bootstrap_state (company_id, token, updated_at)
    SELECT cid, gen_random_uuid(), now()
    FROM unnest(affected) AS t(cid)
    WHERE cid IS NOT NULL
    ON CONFLICT (company_id) DO UPDATE
    SET token = excluded.token, updated_at = excluded.updated_at;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers. Each table needs three triggers (INSERT/UPDATE/DELETE)
-- because REFERENCING clauses are operation-specific.

-- divisions
DROP TRIGGER IF EXISTS divisions_bootstrap_bump_ins ON divisions;
DROP TRIGGER IF EXISTS divisions_bootstrap_bump_upd ON divisions;
DROP TRIGGER IF EXISTS divisions_bootstrap_bump_del ON divisions;
CREATE TRIGGER divisions_bootstrap_bump_ins AFTER INSERT ON divisions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER divisions_bootstrap_bump_upd AFTER UPDATE ON divisions
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER divisions_bootstrap_bump_del AFTER DELETE ON divisions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- service_items
DROP TRIGGER IF EXISTS service_items_bootstrap_bump_ins ON service_items;
DROP TRIGGER IF EXISTS service_items_bootstrap_bump_upd ON service_items;
DROP TRIGGER IF EXISTS service_items_bootstrap_bump_del ON service_items;
CREATE TRIGGER service_items_bootstrap_bump_ins AFTER INSERT ON service_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER service_items_bootstrap_bump_upd AFTER UPDATE ON service_items
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER service_items_bootstrap_bump_del AFTER DELETE ON service_items
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- customers
DROP TRIGGER IF EXISTS customers_bootstrap_bump_ins ON customers;
DROP TRIGGER IF EXISTS customers_bootstrap_bump_upd ON customers;
DROP TRIGGER IF EXISTS customers_bootstrap_bump_del ON customers;
CREATE TRIGGER customers_bootstrap_bump_ins AFTER INSERT ON customers
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER customers_bootstrap_bump_upd AFTER UPDATE ON customers
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER customers_bootstrap_bump_del AFTER DELETE ON customers
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- projects
DROP TRIGGER IF EXISTS projects_bootstrap_bump_ins ON projects;
DROP TRIGGER IF EXISTS projects_bootstrap_bump_upd ON projects;
DROP TRIGGER IF EXISTS projects_bootstrap_bump_del ON projects;
CREATE TRIGGER projects_bootstrap_bump_ins AFTER INSERT ON projects
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER projects_bootstrap_bump_upd AFTER UPDATE ON projects
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER projects_bootstrap_bump_del AFTER DELETE ON projects
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- workers
DROP TRIGGER IF EXISTS workers_bootstrap_bump_ins ON workers;
DROP TRIGGER IF EXISTS workers_bootstrap_bump_upd ON workers;
DROP TRIGGER IF EXISTS workers_bootstrap_bump_del ON workers;
CREATE TRIGGER workers_bootstrap_bump_ins AFTER INSERT ON workers
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER workers_bootstrap_bump_upd AFTER UPDATE ON workers
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER workers_bootstrap_bump_del AFTER DELETE ON workers
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- pricing_profiles
DROP TRIGGER IF EXISTS pricing_profiles_bootstrap_bump_ins ON pricing_profiles;
DROP TRIGGER IF EXISTS pricing_profiles_bootstrap_bump_upd ON pricing_profiles;
DROP TRIGGER IF EXISTS pricing_profiles_bootstrap_bump_del ON pricing_profiles;
CREATE TRIGGER pricing_profiles_bootstrap_bump_ins AFTER INSERT ON pricing_profiles
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER pricing_profiles_bootstrap_bump_upd AFTER UPDATE ON pricing_profiles
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER pricing_profiles_bootstrap_bump_del AFTER DELETE ON pricing_profiles
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- bonus_rules
DROP TRIGGER IF EXISTS bonus_rules_bootstrap_bump_ins ON bonus_rules;
DROP TRIGGER IF EXISTS bonus_rules_bootstrap_bump_upd ON bonus_rules;
DROP TRIGGER IF EXISTS bonus_rules_bootstrap_bump_del ON bonus_rules;
CREATE TRIGGER bonus_rules_bootstrap_bump_ins AFTER INSERT ON bonus_rules
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER bonus_rules_bootstrap_bump_upd AFTER UPDATE ON bonus_rules
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER bonus_rules_bootstrap_bump_del AFTER DELETE ON bonus_rules
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- integration_connections
DROP TRIGGER IF EXISTS integration_connections_bootstrap_bump_ins ON integration_connections;
DROP TRIGGER IF EXISTS integration_connections_bootstrap_bump_upd ON integration_connections;
DROP TRIGGER IF EXISTS integration_connections_bootstrap_bump_del ON integration_connections;
CREATE TRIGGER integration_connections_bootstrap_bump_ins AFTER INSERT ON integration_connections
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER integration_connections_bootstrap_bump_upd AFTER UPDATE ON integration_connections
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER integration_connections_bootstrap_bump_del AFTER DELETE ON integration_connections
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- integration_mappings
DROP TRIGGER IF EXISTS integration_mappings_bootstrap_bump_ins ON integration_mappings;
DROP TRIGGER IF EXISTS integration_mappings_bootstrap_bump_upd ON integration_mappings;
DROP TRIGGER IF EXISTS integration_mappings_bootstrap_bump_del ON integration_mappings;
CREATE TRIGGER integration_mappings_bootstrap_bump_ins AFTER INSERT ON integration_mappings
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER integration_mappings_bootstrap_bump_upd AFTER UPDATE ON integration_mappings
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER integration_mappings_bootstrap_bump_del AFTER DELETE ON integration_mappings
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- crew_schedules
DROP TRIGGER IF EXISTS crew_schedules_bootstrap_bump_ins ON crew_schedules;
DROP TRIGGER IF EXISTS crew_schedules_bootstrap_bump_upd ON crew_schedules;
DROP TRIGGER IF EXISTS crew_schedules_bootstrap_bump_del ON crew_schedules;
CREATE TRIGGER crew_schedules_bootstrap_bump_ins AFTER INSERT ON crew_schedules
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER crew_schedules_bootstrap_bump_upd AFTER UPDATE ON crew_schedules
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER crew_schedules_bootstrap_bump_del AFTER DELETE ON crew_schedules
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();

-- labor_entries
DROP TRIGGER IF EXISTS labor_entries_bootstrap_bump_ins ON labor_entries;
DROP TRIGGER IF EXISTS labor_entries_bootstrap_bump_upd ON labor_entries;
DROP TRIGGER IF EXISTS labor_entries_bootstrap_bump_del ON labor_entries;
CREATE TRIGGER labor_entries_bootstrap_bump_ins AFTER INSERT ON labor_entries
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER labor_entries_bootstrap_bump_upd AFTER UPDATE ON labor_entries
  REFERENCING NEW TABLE AS new_rows OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
CREATE TRIGGER labor_entries_bootstrap_bump_del AFTER DELETE ON labor_entries
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION bump_company_bootstrap_state();
