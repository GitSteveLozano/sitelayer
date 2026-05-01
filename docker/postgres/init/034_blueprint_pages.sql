-- 034_blueprint_pages.sql
--
-- Multi-page blueprints + per-page scale calibration (Phase 3B + 3C).
--
-- Real construction plans are 30-200 pages. Today blueprint_documents
-- carries one storage_path, an implicit "single page". This migration
-- adds a `blueprint_pages` table so a single PDF document can be
-- represented as N page rows, each with its own scale calibration
-- (per Bluebeam's pattern — scale is a per-sheet concern, never a
-- project-wide one).
--
-- Per-page columns:
--   - page_number       1-indexed, unique within a document
--   - storage_path      optional; null when the page is rendered from
--                       the parent doc's PDF on demand. Set when a
--                       page-image cache is generated upstream.
--   - calibration_*     two-point click-to-set: world distance (in
--                       inches by default to match construction plan
--                       conventions) measured between two on-screen
--                       points whose pixel coordinates are stored as
--                       (x1,y1)–(x2,y2). The UI computes
--                       pixels-per-inch from that pair; the server
--                       just persists it so re-opens are deterministic.
--   - measurement count cache so the page-strip nav can show a "3 marks"
--     badge without joining takeoff_measurements every render.
--
-- Backfill: every existing blueprint_documents row gets one
-- blueprint_pages row at page_number=1 to keep the legacy single-page
-- world working. New uploads (Phase 3 multi-page upload) will create
-- N rows.

CREATE TABLE IF NOT EXISTS blueprint_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  blueprint_document_id uuid NOT NULL REFERENCES blueprint_documents(id) ON DELETE CASCADE,
  page_number int NOT NULL,
  storage_path text,
  -- Calibration: two-point world-distance reference.
  calibration_world_distance numeric(12, 4),
  calibration_world_unit text,
  calibration_x1 numeric(10, 4),
  calibration_y1 numeric(10, 4),
  calibration_x2 numeric(10, 4),
  calibration_y2 numeric(10, 4),
  calibration_set_at timestamptz,
  calibration_set_by text,
  measurement_count int NOT NULL DEFAULT 0,
  origin text DEFAULT current_setting('app.tier', true),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blueprint_pages_unique_page UNIQUE (blueprint_document_id, page_number),
  CONSTRAINT blueprint_pages_page_chk CHECK (page_number >= 1)
);

CREATE INDEX IF NOT EXISTS blueprint_pages_company_doc_idx
  ON blueprint_pages (company_id, blueprint_document_id, page_number);

-- Backfill: one page per existing document.
INSERT INTO blueprint_pages (company_id, blueprint_document_id, page_number, storage_path)
SELECT d.company_id, d.id, 1, d.storage_path
FROM blueprint_documents d
WHERE NOT EXISTS (
  SELECT 1 FROM blueprint_pages p WHERE p.blueprint_document_id = d.id
);

-- Add page_id to takeoff_measurements so a measurement can be
-- attributed to a specific sheet. NULL means "page 1 by convention"
-- (matches the legacy single-page world); new takeoffs always set it.
ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS page_id uuid REFERENCES blueprint_pages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS takeoff_measurements_page_idx
  ON takeoff_measurements (company_id, page_id) WHERE page_id IS NOT NULL;
