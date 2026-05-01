-- 038_qbo_sqft_custom_field.sql
--
-- Takeoff → QBO bridge with sqft preserved (Phase 3H).
--
-- Per the design brief (Position C): "the single highest-leverage
-- feature" — when a SiteLayer measurement flows to QBO, sqft is
-- written to a QBO custom field as structured numeric data, not
-- narrative description.
--
-- This migration sets up the mapping side: an
-- `qbo_custom_field_mappings` table records, per company + per
-- entity_type (Estimate / Invoice / Bill), the QBO custom field
-- definition id we should populate. The worker's QBO push handlers
-- consult this table to know what custom-field id to write into.
--
-- Companies can configure once via the QBO Custom Fields settings
-- screen; until that screen ships in Phase 5, rows can be
-- inserted manually via SQL or PATCH /api/qbo/custom-fields. The
-- worker tolerates a missing mapping (skips the field write rather
-- than failing the push).

CREATE TABLE IF NOT EXISTS qbo_custom_field_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  /** QBO entity type the custom field applies to. */
  entity_type text NOT NULL,
  /** Sitelayer-side semantic name (e.g. 'sqft_total'). */
  field_name text NOT NULL,
  /** QBO's CustomField.DefinitionId (numeric, but stored as text since QBO returns it as strings). */
  qbo_definition_id text NOT NULL,
  /** Human label as it appears in QBO. Stored for debug/UI; not authoritative. */
  qbo_label text,
  notes text,
  origin text DEFAULT current_setting('app.tier', true),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT qbo_custom_field_mappings_entity_chk
    CHECK (entity_type IN ('Estimate', 'Invoice', 'Bill', 'PurchaseOrder')),
  CONSTRAINT qbo_custom_field_mappings_unique
    UNIQUE (company_id, entity_type, field_name)
);

CREATE INDEX IF NOT EXISTS qbo_custom_field_mappings_company_entity_idx
  ON qbo_custom_field_mappings (company_id, entity_type);
