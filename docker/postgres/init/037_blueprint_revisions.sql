-- 037_blueprint_revisions.sql
--
-- Plan revision compare overlay (Phase 3E) — track which measurements
-- live on regions of a sheet that changed between plan revisions.
--
-- The existing `replaces_blueprint_document_id` lineage column on
-- blueprint_documents already says "this PDF replaces that PDF". This
-- migration adds a `blueprint_page_diffs` table that records bounding
-- boxes of changed regions per replaced page, plus an
-- `affected_measurement_ids` snapshot so the UI can surface
-- "3 measurements live on areas that changed."
--
-- Diffs are computed externally (a Phase 3E follow-on adds an image-
-- diff worker; this migration sets up the schema so the worker has a
-- destination). For now rows are written by an admin tool / manual
-- entry path.

CREATE TABLE IF NOT EXISTS blueprint_page_diffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  /** The newer revision's page that this diff applies to. */
  new_page_id uuid NOT NULL REFERENCES blueprint_pages(id) ON DELETE CASCADE,
  /** The page in the prior revision (NULL when added net-new). */
  prior_page_id uuid REFERENCES blueprint_pages(id) ON DELETE SET NULL,
  /** kind of change: added | removed | modified */
  change_kind text NOT NULL,
  /** Bounding box on the new page in 0..100 board space (matches polygon storage). */
  bbox_x numeric(8, 4) NOT NULL,
  bbox_y numeric(8, 4) NOT NULL,
  bbox_w numeric(8, 4) NOT NULL,
  bbox_h numeric(8, 4) NOT NULL,
  /** Diff confidence (image-diff worker output). 0..1. */
  confidence numeric(4, 3) NOT NULL DEFAULT 1,
  /** Cached: ids of takeoff_measurements whose centroid falls in bbox. */
  affected_measurement_ids uuid[] NOT NULL DEFAULT '{}',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blueprint_page_diffs_change_chk
    CHECK (change_kind IN ('added', 'removed', 'modified')),
  CONSTRAINT blueprint_page_diffs_bbox_chk
    CHECK (bbox_x >= 0 AND bbox_y >= 0 AND bbox_w > 0 AND bbox_h > 0
           AND bbox_x + bbox_w <= 100 AND bbox_y + bbox_h <= 100),
  CONSTRAINT blueprint_page_diffs_confidence_chk
    CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS blueprint_page_diffs_new_page_idx
  ON blueprint_page_diffs (company_id, new_page_id);
