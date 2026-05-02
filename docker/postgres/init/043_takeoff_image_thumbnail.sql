-- 043_takeoff_image_thumbnail.sql
--
-- Adds an `image_thumbnail` data-URL column to `takeoff_measurements`
-- so the photo-measure surface (Sitemap §5 panel 3) can persist a
-- compressed thumbnail of the photo the worker drew the rectangle on.
--
-- Why a data URL and not a Spaces storage key:
--   - Photos taken for measurement are typically a single feature
--     (lintel, vent, caulk run) and don't need the full-size original.
--   - 512×n JPEG @ q=0.7 ~ 30–80KB — well inside the 20MB JSON body
--     limit and fast to render in the takeoff summary.
--   - Daily-log photos take the Spaces path because they're full-res
--     site documentation; takeoff photos are inline thumbnails.
--   - When the photo-bucket follow-on lands, this column carries the
--     migration's source data: a worker that re-saves the measurement
--     uploads the original to Spaces and clears the thumbnail.
--
-- Sized at text without a length cap; reasonable callers will keep it
-- under ~100KB. The API enforces the 20MB JSON body cap upstream.

ALTER TABLE takeoff_measurements
  ADD COLUMN IF NOT EXISTS image_thumbnail text;
