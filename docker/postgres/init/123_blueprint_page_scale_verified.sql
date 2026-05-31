-- 123_blueprint_page_scale_verified.sql
--
-- Per-sheet scale-VERIFICATION state (Desktop v2 · EST · SCALE VERIFY, dsg__31).
--
-- Calibration (the two-point world-distance reference added in
-- 034_blueprint_pages.sql) answers "do we know the scale of this sheet?".
-- Verification answers a *separate*, human question: "has the estimator
-- confirmed this sheet's scale is correct so its takeoff quantities can be
-- trusted?". The design's "2 / 22 VERIFIED · 20 TO REVIEW" progress and the
-- per-row VERIFIED pill / CHECK button are driven by this explicit flag, not by
-- the mere presence of a calibration — an estimator may calibrate a sheet and
-- still want to eyeball it before signing off, and the AI-autoscale path will
-- set calibration without anyone having confirmed it.
--
-- A page is "verified" when `scale_verified_at` is non-null. Toggling the flag
-- off (re-review) clears both columns. Verification lives on `blueprint_pages`
-- (not `blueprint_documents`) because scale is a per-sheet concern — a 22-page
-- plan set is 22 independently verifiable sheets, matching Bluebeam's model and
-- the existing per-page calibration columns.
--
-- Additive / expand-only: nullable columns, no backfill needed (every existing
-- sheet starts UNVERIFIED, which is the correct default).

ALTER TABLE blueprint_pages
  ADD COLUMN IF NOT EXISTS scale_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS scale_verified_by text;

-- Cheap per-company "how many sheets are verified" rollup for the progress
-- sidebar without scanning every page row.
CREATE INDEX IF NOT EXISTS blueprint_pages_scale_verified_idx
  ON blueprint_pages (company_id, blueprint_document_id)
  WHERE scale_verified_at IS NOT NULL;
