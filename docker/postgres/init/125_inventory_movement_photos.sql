-- 125_inventory_movement_photos.sql
--
-- Persist rental dispatch / return condition photos for the desktop
-- (owner-rentals-dispatch / owner-rentals-return) and mobile
-- (rentals-scan) flows.
--
-- Until now those screens captured a condition grade + a free-text note +
-- a "photo" list, but the photos were placeholder-only: the desktop return
-- pushed names like `photo-1.jpg` and the mobile scan stamped
-- `capture://return/<ts>-<slot>` references, then smuggled a count into the
-- movement notes. No bytes were ever stored — there was no
-- returns/damage photo-upload endpoint (documented GAP in
-- apps/web/src/screens/desktop/owner-rentals-return.tsx).
--
-- Schema choice — separate table, not columns on inventory_movements:
--   * A dispatch/return movement can carry multiple condition photos (the
--     UI shows a "+ Add photo" dropzone and three optional capture tiles),
--     so a scalar `photo_storage_key text` would force the client to
--     discard all but one — the same data-loss bug at a different layer.
--   * We want mime + size per photo so the GET path can stream bytes back
--     with the correct Content-Type / Content-Length.
--   * Photos hang off the movement (the canonical dispatch/return event)
--     so a GOOD/WEAR `return`, a `damaged` return, and a `deliver`
--     dispatch all share one attachment shape.
--
-- Storage keys live in the same bucket under a
-- `<companyId>/inventory-movements/<movementId>/<filename>` prefix — same
-- shape as `<companyId>/worker-issues/<id>/...` and
-- `<companyId>/daily-logs/<id>/...`, so assertKeyInCompany still gates
-- cross-tenant access via the first path segment.

CREATE TABLE IF NOT EXISTS inventory_movement_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inventory_movement_id uuid NOT NULL REFERENCES inventory_movements(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movement_photos_size_chk CHECK (
    size_bytes >= 0
  )
);

-- Hot path: list photos for one movement, oldest first (the order they
-- were captured), so the dispatch/return summary renders deterministically.
CREATE INDEX IF NOT EXISTS inventory_movement_photos_movement_idx
  ON inventory_movement_photos(inventory_movement_id, created_at ASC);

CREATE INDEX IF NOT EXISTS inventory_movement_photos_company_idx
  ON inventory_movement_photos(company_id, created_at DESC);

-- Storage keys are globally unique inside a bucket; if the same key
-- somehow showed up twice we'd be exposing the same bytes under two photo
-- rows. Deduplicate at the DB layer (mirrors worker_issue_attachments).
CREATE UNIQUE INDEX IF NOT EXISTS inventory_movement_photos_storage_key_uidx
  ON inventory_movement_photos(storage_key);

-- Row level security: new company-scoped table, so flip it in the same
-- migration that creates it (per migration 085's "intent is for new
-- company-scoped tables to flip RLS in the same migration that creates
-- them"). Same permissive-when-unset policy body as migration 066 / 120.
DROP POLICY IF EXISTS company_isolation ON inventory_movement_photos;
CREATE POLICY company_isolation ON inventory_movement_photos
  FOR ALL
  USING (app_current_company_id() IS NULL OR company_id = app_current_company_id())
  WITH CHECK (app_current_company_id() IS NULL OR company_id = app_current_company_id());

ALTER TABLE inventory_movement_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movement_photos FORCE ROW LEVEL SECURITY;
