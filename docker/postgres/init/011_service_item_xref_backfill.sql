-- 011_service_item_xref_backfill.sql
--
-- Backfill `service_item_divisions` for every (company, service_item) pair so
-- the takeoff catalog enforcement layer (apps/api/src/server.ts ::
-- assertDivisionAllowedForServiceItem) can refuse to write a takeoff for a
-- service item that has not been curated.
--
-- Mapping is taken from `LA_SERVICE_ITEMS[*].defaultDivisionCode` in
-- packages/domain/src/index.ts. We embed the same mapping here as a literal
-- VALUES list rather than depending on application code at migration time.
--
-- Idempotent: ON CONFLICT DO NOTHING means re-running this migration will
-- not duplicate rows or overwrite admin-curated entries.
--
-- After this runs, every seeded service item maps to its default division.
-- Admins can still ADD additional rows via /api/integrations/qbo/sync (and
-- the items pull) or via direct SQL.

INSERT INTO service_item_divisions (company_id, service_item_code, division_code)
SELECT si.company_id, si.code, m.division_code
FROM service_items si
JOIN (VALUES
  ('EPS',            'D4'),
  ('Basecoat',       'D4'),
  ('Finish Coat',    'D4'),
  ('Air Barrier',    'D5'),
  ('Envelope Seal',  'D5'),
  ('Cementboard',    'D3'),
  ('Cultured Stone', 'D2'),
  ('Caulking',       'D2'),
  ('Flashing',       'D2'),
  ('Change Order',   'D8'),
  ('Deposit',        'D8'),
  ('Holdback',       'D8')
) AS m(service_item_code, division_code)
  ON si.code = m.service_item_code
WHERE si.deleted_at IS NULL
  -- Only insert when the target division actually exists for this company.
  -- Companies that customized their division list and dropped e.g. D8 won't
  -- get a phantom xref row pointing at a missing FK target.
  AND EXISTS (
    SELECT 1 FROM divisions d
    WHERE d.company_id = si.company_id
      AND d.code = m.division_code
  )
ON CONFLICT (company_id, service_item_code, division_code) DO NOTHING;
