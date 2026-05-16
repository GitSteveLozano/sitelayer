-- Scaffold-aware catalog + BOM bridge.
--
-- service_items stays generic (per-company priced lines for estimating).
-- catalog_part is the *physical* manufacturer part record (weight, system,
-- description, manufacturer SKU). bom + bom_line link an estimate or
-- scaffold-design entity into catalog_part quantities, so when a BOM is
-- approved we can roll quantities into inventory_items / job_rental_lines
-- through a separate join layer rather than collapsing the two worlds.

CREATE TABLE IF NOT EXISTS scaffold_manufacturers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  website text,
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

-- System scaffold families (Kwikstage, Ring, Cup-lock, HAKI, Safway, OCTO,
-- etc.). Identified by code; the (manufacturer, system) pair narrows the
-- universe of catalog parts when a designer is laying out bays.
CREATE TABLE IF NOT EXISTS scaffold_systems (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  manufacturer_id uuid REFERENCES scaffold_manufacturers(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS catalog_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  manufacturer_id uuid REFERENCES scaffold_manufacturers(id) ON DELETE SET NULL,
  scaffold_system_id uuid REFERENCES scaffold_systems(id) ON DELETE SET NULL,
  -- Link to the existing owned-inventory record when we stock this part.
  -- Nullable because a BOM may reference parts we don't own and would
  -- need to cross-hire or purchase.
  inventory_item_id uuid,
  sku text NOT NULL,
  description text NOT NULL,
  unit text NOT NULL DEFAULT 'ea',
  weight_kg numeric(12,3),
  length_mm int,
  width_mm int,
  height_mm int,
  surface_area_m2 numeric(12,3),
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, sku),
  FOREIGN KEY (company_id, inventory_item_id) REFERENCES inventory_items(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS catalog_parts_system_idx
  ON catalog_parts (company_id, scaffold_system_id)
  WHERE deleted_at IS NULL;

-- BOM = the scaffold designer's "bill of materials" output. Source
-- references the upstream artifact (a project_id today; later a scaffold
-- model id when 3D design ships). One BOM may serve many estimates /
-- shipments; revisions are tracked via version + a head pointer.
CREATE TABLE IF NOT EXISTS boms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'manual', -- 'manual' | 'avontus_import' | 'scaffold_design'
  source_ref text,
  name text NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'draft', -- 'draft' | 'approved' | 'superseded'
  approved_at timestamptz,
  approved_by text,
  superseded_by uuid REFERENCES boms(id) ON DELETE SET NULL,
  total_weight_kg numeric(14,3) NOT NULL DEFAULT 0,
  total_lines int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS boms_project_idx
  ON boms (company_id, project_id, status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS bom_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bom_id uuid NOT NULL,
  catalog_part_id uuid NOT NULL,
  quantity numeric(14,3) NOT NULL,
  notes text,
  attrs jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, bom_id) REFERENCES boms(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, catalog_part_id) REFERENCES catalog_parts(company_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS bom_lines_bom_idx
  ON bom_lines (company_id, bom_id);
