-- 107_service_item_divisions_backfill_uncurated.sql
--
-- The takeoff catalog guard (apps/api/src/catalog.ts ::
-- assertServiceItemCatalogStatus, enforced by
-- apps/api/src/routes/takeoff-write.ts) refuses to write a takeoff measurement
-- for a service item that has no `service_item_divisions` row, returning 422
-- `service item not in curated catalog for any division`.
--
-- Migration 011 backfilled the curated cross-reference only for the known
-- LA seed items (EPS→D4, Air Barrier→D5, ...). Items added since — via the
-- QBO item pull, manual `POST /api/service-items`, or a customized roster —
-- never got a cross-reference row, so a takeoff that picks one of them 422s
-- and the whole estimator workflow is blocked.
--
-- This forward, additive, idempotent backfill curates every *currently
-- uncurated* (company, service_item) pair to EVERY division that company has.
-- "Valid in every division" is the least-surprising default for an item whose
-- correct division we cannot infer; an admin can prune the cross-reference
-- afterwards. Items that ALREADY have at least one curated division (e.g. the
-- 011-seeded ones) are left untouched, so existing curation is preserved.
--
-- `POST /api/service-items` performs the same auto-curation for newly created
-- items going forward (see apps/api/src/routes/service-items.ts), so this is a
-- one-time catch-up for the existing data.
--
-- Idempotent: ON CONFLICT DO NOTHING + the NOT EXISTS guard mean re-running is
-- a no-op and never overwrites admin-curated entries.

INSERT INTO service_item_divisions (company_id, service_item_code, division_code)
SELECT si.company_id, si.code, d.code
FROM service_items si
JOIN divisions d
  ON d.company_id = si.company_id
WHERE si.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM service_item_divisions x
    WHERE x.company_id = si.company_id
      AND x.service_item_code = si.code
  )
ON CONFLICT (company_id, service_item_code, division_code) DO NOTHING;
