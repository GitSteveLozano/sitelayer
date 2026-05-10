-- 070_takeoff_drafts_result_json.sql
--
-- Phase C.2 of folding sitelayer-capture into sitelayer. Adds an inline
-- jsonb column to `takeoff_drafts` so the capture API
-- (POST /api/projects/:id/takeoff-drafts/capture) can stash the pipeline's
-- emitted `TakeoffResult` on the draft without first standing up the
-- object-storage upload path for the canonical blob.
--
-- The 069 migration already added `takeoff_result_blob_uri` for the
-- eventual Spaces-backed path. This column is the lightweight inline
-- alternative — populated synchronously by the capture endpoint and
-- consumed by the takeoff-canvas preview / future promote-to-
-- measurements flow.
--
-- jsonb (vs json) because we'll filter on quantity confidence and
-- provenance.kind in upcoming queries (e.g. "show me drafts with any
-- quantity below 0.6 confidence for review"). jsonb indexes those
-- predicates without re-parsing per row.

ALTER TABLE takeoff_drafts
  ADD COLUMN IF NOT EXISTS takeoff_result_json jsonb;

-- Partial index for the review-queue query: drafts produced by a
-- capture pipeline (source <> 'manual') that have a stored result.
-- The deleted_at filter keeps soft-deleted drafts out of the inbox.
CREATE INDEX IF NOT EXISTS takeoff_drafts_result_json_idx
  ON takeoff_drafts (company_id, created_at DESC)
  WHERE source <> 'manual' AND deleted_at IS NULL AND takeoff_result_json IS NOT NULL;
