-- 137_takeoff_measured_revision.sql
--
-- Plan-revision overlay (H3) — version-stamp the takeoff scope.
--
-- The takeoff deep dive (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md, H3) flags
-- that estimates are "not stamped with the plan version measured." When a
-- re-issued plan lands, an estimator currently has no record of which
-- blueprint revision a draft's measurements were taken against, so they
-- can't tell at a glance whether a draft predates the latest revision.
--
-- This is a cheap, additive marker: a nullable FK on `takeoff_drafts`
-- (the per-project measurement scope) pointing at the blueprint document
-- the draft was measured against. It stays NULL for every existing draft
-- and for any draft until a writer sets it; nothing reads-or-writes it as
-- a hard dependency, so old and new code both tolerate the column during
-- rollout (expand step only).
--
-- ON DELETE SET NULL: if the referenced blueprint document is removed the
-- stamp clears rather than cascading the draft away — the measurements
-- outlive the source plan.
--
-- FOLLOW-UP (flagged in the PR): wiring the writer that sets this column
-- (stamp the draft with the active blueprint revision at measure time)
-- and surfacing a "measured against v{n} — newer revision available"
-- staleness banner are a separate slice. This migration only opens the
-- destination so that work is purely additive when it lands.

ALTER TABLE takeoff_drafts
  ADD COLUMN IF NOT EXISTS measured_blueprint_document_id uuid
    REFERENCES blueprint_documents(id) ON DELETE SET NULL;

COMMENT ON COLUMN takeoff_drafts.measured_blueprint_document_id IS
  'Blueprint document revision this draft''s measurements were taken against (H3 version stamp). NULL = unstamped. Writer wiring is a follow-up slice.';
