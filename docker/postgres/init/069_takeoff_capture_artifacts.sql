-- 069_takeoff_capture_artifacts.sql
--
-- Phase C.1 of folding sitelayer-capture into sitelayer
-- (docs/MULTI_DRAFT_TAKEOFF_SPEC.md INTEGRATION.md Phase C).
--
-- With the multi-draft infrastructure (066-068) shipped and the four
-- capture pipelines ported into packages/ (Phase B / PR #271), the next
-- gap is plumbing the artifact upload + per-pipeline provenance through
-- the database.
--
-- This migration adds:
--   1. New columns on `takeoff_drafts` so each draft can declare which
--      pipeline produced it (`source`), where the canonical
--      `TakeoffResult` JSON lives in object storage
--      (`takeoff_result_blob_uri`), whether the pipeline flagged any
--      low-confidence quantities for human review (`review_required`),
--      and which version of the producing pipeline ran
--      (`pipeline_version`).
--   2. A new `takeoff_capture_artifacts` table — one row per uploaded
--      input (PDF, CapturedRoom JSON, labeled mesh, drone sidecar) tied
--      to a draft. Allows multiple artifacts per draft (e.g. a drone
--      sidecar + the original PDF that produced its measurements).
--
-- Why a separate artifacts table rather than just a column on
-- `takeoff_drafts`: each capture pipeline can stream additional
-- ancillary data (preview thumbnails, labeled mesh JSON for manual
-- review steps, raw point cloud subsamples) without bloating the
-- core draft row, and the artifacts can be replaced/versioned
-- without rewriting the draft's identity.
--
-- The `source` column defaults to 'manual' so all existing drafts
-- (the Default rows backfilled by 066) keep working without an
-- additional UPDATE.

ALTER TABLE takeoff_drafts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS takeoff_result_blob_uri text,
  ADD COLUMN IF NOT EXISTS review_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pipeline_version text;

-- Enumerate the known sources via a check constraint rather than a
-- Postgres ENUM. Reasoning matches takeoff_drafts.type: text + check
-- evolves safely (ALTER TABLE … DROP/ADD CONSTRAINT is in-transaction),
-- whereas ALTER TYPE … ADD VALUE pre-pg18 couldn't be wrapped in a
-- transaction. Postgres 18 supports it but the project convention is
-- check constraints for narrow vocabularies.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'takeoff_drafts_source_check'
  ) THEN
    ALTER TABLE takeoff_drafts
      ADD CONSTRAINT takeoff_drafts_source_check
      CHECK (source IN ('manual', 'roomplan', 'photogrammetry', 'drone', 'blueprint_vision'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS takeoff_drafts_source_idx
  ON takeoff_drafts (company_id, source)
  WHERE source <> 'manual';

CREATE INDEX IF NOT EXISTS takeoff_drafts_review_required_idx
  ON takeoff_drafts (company_id, review_required)
  WHERE review_required = true AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- New table: takeoff_capture_artifacts. One row per uploaded input.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS takeoff_capture_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES takeoff_drafts(id) ON DELETE CASCADE,
  -- 'pdf'         — raw blueprint PDF (pipe-blueprint input)
  -- 'usdz'        — RoomPlan export (future; today we accept the JSON)
  -- 'captured_room_json' — RoomPlan CapturedRoom JSON (pipe-roomplan)
  -- 'labeled_mesh'       — photogrammetry labeled mesh (pipe-photogrammetry
  --                        manual-labeling step output)
  -- 'pointcloud'         — drone point cloud subset (pipe-drone NodeODM)
  -- 'orthomosaic'        — drone orthomosaic preview (pipe-drone)
  -- 'sidecar_json'       — drone offline sidecar with pre-extracted
  --                        planes (pipe-drone offline path)
  kind text NOT NULL,
  -- Opaque storage path (Spaces key in prod, local fs path in
  -- dev/preview) — same shape as blueprint_documents.storage_path.
  blob_uri text NOT NULL,
  mime text,
  size_bytes bigint,
  -- Pipeline-specific metadata: confidence per region, raw extractor
  -- response, manufacturer catalog hints, etc. JSONB so the pipeline
  -- can evolve without a schema change.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS takeoff_capture_artifacts_draft_idx
  ON takeoff_capture_artifacts (company_id, draft_id, created_at DESC);

CREATE INDEX IF NOT EXISTS takeoff_capture_artifacts_kind_idx
  ON takeoff_capture_artifacts (company_id, kind, created_at DESC);

-- The companies-cascade FK + the draft-cascade FK together mean a
-- hard-deleted company or draft cleans up its artifacts atomically.
-- Soft-delete a draft (status='archived' / deleted_at) leaves its
-- artifacts in place per the same convention as the rest of the
-- multi-draft schema — the next recompute reads from
-- takeoff_drafts.takeoff_result_blob_uri rather than these artifact
-- rows, so they're for provenance / re-upload, not for the hot path.
