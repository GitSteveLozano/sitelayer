-- QR-coded scaffold tags + inspections.
--
-- Each physical erected scaffold (or sub-structure) gets a QR token. The
-- token resolves to a tag row, which holds project, structure type, and
-- the latest inspection summary. Inspections record a checklist payload,
-- photo refs, and a signoff identity — append-only history.

CREATE TABLE IF NOT EXISTS scaffold_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  qr_token text NOT NULL,
  label text NOT NULL,                     -- human-friendly name e.g. "Bay 12 W"
  structure_type text NOT NULL DEFAULT 'scaffold', -- 'scaffold' | 'stair_tower' | 'hoist' | 'shoring' | 'other'
  erected_on date,
  dismantled_on date,
  height_m numeric(8,2),
  load_class text,
  -- Last-known inspection summary, mirrored from scaffold_inspections so
  -- the site-map render is one query instead of N joins.
  last_inspection_id uuid,
  last_inspection_status text,             -- 'pass' | 'fail' | 'tagged_out'
  last_inspection_at timestamptz,
  status text NOT NULL DEFAULT 'active',   -- 'active' | 'tagged_out' | 'dismantled'
  -- Position on the project site map (lat/lng). Plane-fitting is left to
  -- the UI; the DB just stores the point.
  lat numeric(10,6),
  lng numeric(10,6),
  notes text,
  version int NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  UNIQUE (company_id, qr_token),
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS scaffold_tags_project_idx
  ON scaffold_tags (company_id, project_id, status)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS scaffold_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL,
  project_id uuid NOT NULL,
  inspector_user_id text NOT NULL,
  inspector_name text,
  status text NOT NULL CHECK (status IN ('pass', 'fail', 'tagged_out')),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  photo_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  defects text,
  remediation text,
  signed_at timestamptz NOT NULL DEFAULT now(),
  next_due_on date,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, tag_id) REFERENCES scaffold_tags(company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, project_id) REFERENCES projects(company_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS scaffold_inspections_tag_idx
  ON scaffold_inspections (company_id, tag_id, signed_at desc);

CREATE INDEX IF NOT EXISTS scaffold_inspections_due_idx
  ON scaffold_inspections (company_id, next_due_on)
  WHERE next_due_on IS NOT NULL;
