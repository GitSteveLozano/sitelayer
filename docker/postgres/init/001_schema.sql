CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS company_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  clerk_user_id text NOT NULL,
  role text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, clerk_user_id)
);

CREATE TABLE IF NOT EXISTS divisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS service_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  unit text NOT NULL,
  default_rate numeric(12,2),
  source text NOT NULL DEFAULT 'manual',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS pricing_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  external_id text,
  name text NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, external_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  name text NOT NULL,
  customer_name text NOT NULL,
  division_code text NOT NULL,
  status text NOT NULL DEFAULT 'lead',
  bid_total numeric(12,2) NOT NULL DEFAULT 0,
  labor_rate numeric(12,2) NOT NULL DEFAULT 0,
  target_sqft_per_hr numeric(12,2),
  bonus_pool numeric(12,2) NOT NULL DEFAULT 0,
  closed_at timestamptz,
  summary_locked_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS workers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  role text NOT NULL DEFAULT 'crew',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS crew_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scheduled_for date NOT NULL,
  crew jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS labor_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_id uuid REFERENCES workers(id) ON DELETE SET NULL,
  service_item_code text NOT NULL,
  hours numeric(12,2) NOT NULL DEFAULT 0,
  sqft_done numeric(12,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft',
  occurred_on date NOT NULL,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blueprint_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file_name text NOT NULL,
  storage_path text NOT NULL,
  preview_type text NOT NULL DEFAULT 'storage_path',
  calibration_length numeric(12,2),
  calibration_unit text,
  sheet_scale numeric(12,4),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  replaces_blueprint_document_id uuid REFERENCES blueprint_documents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS takeoff_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  blueprint_document_id uuid REFERENCES blueprint_documents(id) ON DELETE SET NULL,
  service_item_code text NOT NULL,
  quantity numeric(12,2) NOT NULL DEFAULT 0,
  unit text NOT NULL,
  notes text,
  geometry jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS estimate_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_item_code text NOT NULL,
  quantity numeric(12,2) NOT NULL DEFAULT 0,
  unit text NOT NULL,
  rate numeric(12,2) NOT NULL DEFAULT 0,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_account_id text,
  access_token text,
  refresh_token text,
  webhook_secret text,
  sync_cursor text,
  last_synced_at timestamptz,
  retry_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  rate_limit_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'connected',
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  provider text NOT NULL,
  entity_type text NOT NULL,
  local_ref text NOT NULL,
  external_id text NOT NULL,
  label text,
  status text NOT NULL DEFAULT 'active',
  notes text,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider, entity_type, local_ref)
);

CREATE TABLE IF NOT EXISTS sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  integration_connection_id uuid REFERENCES integration_connections(id) ON DELETE CASCADE,
  direction text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mutation_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  device_id text NOT NULL DEFAULT 'server',
  actor_user_id text,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  mutation_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS bonus_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS material_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_id text,
  vendor_name text NOT NULL,
  amount numeric(12,2) NOT NULL DEFAULT 0,
  bill_type text NOT NULL DEFAULT 'material',
  description text,
  occurred_on date,
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

INSERT INTO companies (slug, name)
VALUES ('la-operations', 'L&A Operations')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO companies (slug, name)
VALUES ('beta-build', 'Beta Build')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO company_memberships (company_id, clerk_user_id, role)
SELECT id, 'demo-user', 'admin' FROM companies WHERE slug = 'la-operations'
ON CONFLICT (company_id, clerk_user_id) DO NOTHING;

INSERT INTO company_memberships (company_id, clerk_user_id, role)
SELECT id, 'demo-user', 'admin' FROM companies WHERE slug = 'beta-build'
ON CONFLICT (company_id, clerk_user_id) DO NOTHING;

INSERT INTO divisions (company_id, code, name, sort_order)
SELECT id, d.code, d.name, d.sort_order
FROM companies
CROSS JOIN (VALUES
  ('D1', 'Stucco', 1),
  ('D2', 'Masonry', 2),
  ('D3', 'Siding', 3),
  ('D4', 'EIFS', 4),
  ('D5', 'Paper and Wire', 5),
  ('D6', 'Snow Removal', 6),
  ('D7', 'Warranty', 7),
  ('D8', 'Overhead', 8),
  ('D9', 'Scaffolding', 9)
) AS d(code, name, sort_order)
WHERE companies.slug IN ('la-operations', 'beta-build')
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO service_items (company_id, code, name, category, unit, default_rate)
SELECT id, s.code, s.name, s.category, s.unit, s.default_rate
FROM companies
CROSS JOIN (VALUES
  ('EPS', 'EPS', 'measurable', 'sqft', 4.00),
  ('Basecoat', 'Basecoat', 'measurable', 'sqft', 2.50),
  ('Finish Coat', 'Finish Coat', 'measurable', 'sqft', 3.50),
  ('Air Barrier', 'Air Barrier', 'measurable', 'sqft', 1.80),
  ('Envelope Seal', 'Envelope Seal', 'measurable', 'lf', 2.00),
  ('Cementboard', 'Cementboard', 'measurable', 'sqft', 3.25),
  ('Cultured Stone', 'Cultured Stone', 'measurable', 'sqft', 12.00),
  ('Caulking', 'Caulking', 'measurable', 'lf', 4.50),
  ('Flashing', 'Flashing', 'measurable', 'lf', 8.00),
  ('Change Order', 'Change Order', 'accounting', 'job', NULL),
  ('Deposit', 'Deposit', 'accounting', 'job', NULL),
  ('Holdback', 'Holdback', 'accounting', 'job', NULL)
) AS s(code, name, category, unit, default_rate)
WHERE companies.slug IN ('la-operations', 'beta-build')
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO pricing_profiles (company_id, name, is_default, config)
SELECT id, CASE WHEN slug = 'la-operations' THEN 'Default' ELSE 'Beta Default' END, true, jsonb_build_object('template', slug)
FROM companies
WHERE slug IN ('la-operations', 'beta-build')
ON CONFLICT DO NOTHING;

INSERT INTO bonus_rules (company_id, name, config, is_active)
SELECT id, 'Default Margin Bonus', '{"basis":"margin","threshold":0.15}'::jsonb, true
FROM companies
WHERE slug IN ('la-operations', 'beta-build')
ON CONFLICT DO NOTHING;

INSERT INTO workers (company_id, name, role)
SELECT id, 'Crew Lead', 'foreman'
FROM companies
WHERE slug IN ('la-operations', 'beta-build')
ON CONFLICT DO NOTHING;

INSERT INTO customers (company_id, name, source)
SELECT id, 'Foxridge Homes', 'seed'
FROM companies
WHERE slug IN ('la-operations', 'beta-build')
ON CONFLICT DO NOTHING;

INSERT INTO customers (company_id, name, source)
SELECT id, 'Streetside Developments', 'seed'
FROM companies
WHERE slug IN ('la-operations', 'beta-build')
ON CONFLICT DO NOTHING;

INSERT INTO projects (company_id, customer_name, name, division_code, status, bid_total, labor_rate, target_sqft_per_hr, bonus_pool)
SELECT id, 'Foxridge Homes', CASE WHEN slug = 'la-operations' THEN '215 Cinnamon Teal' ELSE 'Beta Townhomes' END, 'D4', 'lead', 19267.50, 38, 4.73, 5000
FROM companies
WHERE slug IN ('la-operations', 'beta-build')
ON CONFLICT DO NOTHING;

INSERT INTO integration_connections (company_id, provider, provider_account_id, status)
SELECT id, 'qbo', CASE WHEN slug = 'la-operations' THEN 'sandbox-la' ELSE 'sandbox-beta' END, 'connected'
FROM companies
WHERE slug IN ('la-operations', 'beta-build')
ON CONFLICT DO NOTHING;
