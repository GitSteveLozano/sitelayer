-- 110_seed_cladding_assemblies.sql
--
-- PlanSwift Phase 2 — exterior-cladding starter pack backfill (§5b).
--
-- The pilot company (L&A Operations, slug 'la-operations') already exists, so
-- new-company onboarding (apps/api/src/onboarding.ts ::
-- seedExteriorCladdingAssemblies) never fires for it. This data-only forward
-- migration seeds the SAME 6 cladding assemblies for that company only, sharing
-- one source of truth with the onboarding seed (EXTERIOR_CLADDING_PACK in
-- @sitelayer/domain) — the component numbers below are an exact transcription
-- of that constant. SME-tunable seed defaults, not contract; the pilot adjusts
-- them in the assembly editor.
--
-- Each assembly attaches to one of the LA seed service_item_codes (EPS,
-- Basecoat, Cultured Stone, Cementboard, Finish Coat, Air Barrier) and explodes
-- into flat material/labor/sub lines with per-component waste at recompute time.
--
-- Idempotent + tenant-scoped: every header insert is guarded by
-- NOT EXISTS (company_id, name); components are only inserted for headers this
-- run actually creates (the CTE returns no id for a header that already exists).
-- Re-running is a no-op and never touches a hand-edited same-named assembly.
-- Logically separate from migration 109 (which added the columns this depends
-- on), hence the new file rather than folding it into 109.
--
-- No RLS concern: this runs in the migration path where the app.company_id GUC
-- is unset, so the company_isolation policy on both assembly tables is
-- permissive (066/085). The inserts are still explicitly company-scoped via the
-- la-operations slug lookup.

-- The cached header total_rate matches recomputeAssemblyTotal's expression:
--   sum(quantity_per_unit * (1 + waste_pct/100) * unit_cost)
-- We compute it from the component VALUES rather than hardcoding a constant so
-- the header rate can never drift from the components below.
WITH la AS (
  SELECT id AS company_id FROM companies WHERE slug = 'la-operations'
),
header_def (service_item_code, name, description, unit) AS (
  VALUES
    ('EPS', 'EIFS Complete (EPS + Base + Finish)',
     'Full exterior insulation finish system: EPS board, adhesive, base coat with mesh, and acrylic finish, installed over a prepared substrate.', 'sqft'),
    ('Basecoat', '3-Coat Stucco (Scratch / Brown / Finish)',
     'Traditional three-coat Portland-cement stucco over lath: scratch coat, brown coat, and finish coat.', 'sqft'),
    ('Cultured Stone', 'Cultured Stone Veneer',
     'Manufactured stone veneer over scratch coat with mortar setting bed and grouted joints.', 'sqft'),
    ('Cementboard', 'Cementboard + Battens (Modern Farmhouse)',
     'Fiber-cement board-and-batten siding over weather barrier with fasteners and painted finish.', 'sqft'),
    ('Finish Coat', 'EIFS Integral-Color Finish (Recoat)',
     'Integral-color acrylic EIFS finish recoat over an existing prepared base coat — cosmetic refresh without re-boarding.', 'sqft'),
    ('Air Barrier', 'Paper & Wire Envelope',
     'Weather-resistive paper and self-furring wire-lath envelope — the prep layer under stucco or stone, plus scaffolding access (subbed).', 'sqft')
),
-- (assembly name, kind, component name, quantity_per_unit, unit, unit_cost, waste_pct, sort_order)
component_def (assembly_name, kind, name, quantity_per_unit, unit, unit_cost, waste_pct, sort_order) AS (
  VALUES
    -- EIFS Complete
    ('EIFS Complete (EPS + Base + Finish)', 'material', 'EPS board 2"', 1::numeric, 'sqft', 0.85::numeric, 8::numeric, 0),
    ('EIFS Complete (EPS + Base + Finish)', 'material', 'EIFS adhesive', 1, 'sqft', 0.35, 5, 1),
    ('EIFS Complete (EPS + Base + Finish)', 'material', 'Base coat + reinforcing mesh', 1, 'sqft', 0.65, 10, 2),
    ('EIFS Complete (EPS + Base + Finish)', 'material', 'Acrylic finish coat', 1, 'sqft', 0.95, 8, 3),
    ('EIFS Complete (EPS + Base + Finish)', 'labor', 'EIFS installation crew', 0.06, 'hr', 48, 0, 4),
    -- 3-Coat Stucco
    ('3-Coat Stucco (Scratch / Brown / Finish)', 'material', 'Cement / sand scratch + brown', 1, 'sqft', 0.55, 12, 0),
    ('3-Coat Stucco (Scratch / Brown / Finish)', 'material', 'Stucco finish coat', 1, 'sqft', 0.7, 10, 1),
    ('3-Coat Stucco (Scratch / Brown / Finish)', 'material', 'Metal lath + fasteners', 1, 'sqft', 0.4, 8, 2),
    ('3-Coat Stucco (Scratch / Brown / Finish)', 'labor', 'Plasterer crew', 0.08, 'hr', 52, 0, 3),
    -- Cultured Stone Veneer
    ('Cultured Stone Veneer', 'material', 'Cultured stone units', 1, 'sqft', 6.5, 10, 0),
    ('Cultured Stone Veneer', 'material', 'Type-S mortar + bonding', 1, 'sqft', 0.85, 12, 1),
    ('Cultured Stone Veneer', 'material', 'Lath + weather-resistive barrier', 1, 'sqft', 0.5, 8, 2),
    ('Cultured Stone Veneer', 'labor', 'Mason crew', 0.12, 'hr', 55, 0, 3),
    -- Cementboard + Battens
    ('Cementboard + Battens (Modern Farmhouse)', 'material', 'Fiber-cement panel', 1, 'sqft', 1.95, 10, 0),
    ('Cementboard + Battens (Modern Farmhouse)', 'material', 'Battens + trim', 1, 'sqft', 0.6, 12, 1),
    ('Cementboard + Battens (Modern Farmhouse)', 'material', 'Fasteners + sealant', 1, 'sqft', 0.25, 5, 2),
    ('Cementboard + Battens (Modern Farmhouse)', 'labor', 'Siding crew', 0.05, 'hr', 46, 0, 3),
    ('Cementboard + Battens (Modern Farmhouse)', 'labor', 'Paint + caulk finish', 0.03, 'hr', 40, 0, 4),
    -- EIFS Integral-Color Finish
    ('EIFS Integral-Color Finish (Recoat)', 'material', 'Primer', 1, 'sqft', 0.3, 6, 0),
    ('EIFS Integral-Color Finish (Recoat)', 'material', 'Integral-color acrylic finish', 1, 'sqft', 1.1, 8, 1),
    ('EIFS Integral-Color Finish (Recoat)', 'labor', 'Finish applicator', 0.04, 'hr', 48, 0, 2),
    -- Paper & Wire Envelope
    ('Paper & Wire Envelope', 'material', 'Building paper (2 layers)', 2, 'sqft', 0.12, 15, 0),
    ('Paper & Wire Envelope', 'material', 'Self-furring wire lath', 1, 'sqft', 0.45, 10, 1),
    ('Paper & Wire Envelope', 'material', 'Lath fasteners', 1, 'sqft', 0.15, 8, 2),
    ('Paper & Wire Envelope', 'labor', 'Lath crew', 0.035, 'hr', 44, 0, 3),
    ('Paper & Wire Envelope', 'sub', 'Scaffolding access (subbed)', 1, 'sqft', 0.5, 0, 4)
),
-- Cached per-unit total from the components (waste-adjusted), per header.
header_total (name, total_rate) AS (
  SELECT assembly_name,
         sum(quantity_per_unit * (1 + waste_pct / 100.0) * unit_cost)
  FROM component_def
  GROUP BY assembly_name
),
-- Insert only the headers L&A doesn't already have (by name). RETURNING gives
-- us the freshly-minted ids so we can attach components just to those.
inserted_headers AS (
  INSERT INTO service_item_assemblies
    (company_id, service_item_code, name, description, total_rate, unit)
  SELECT la.company_id, h.service_item_code, h.name, h.description,
         ht.total_rate, h.unit
  FROM la
  CROSS JOIN header_def h
  JOIN header_total ht ON ht.name = h.name
  WHERE NOT EXISTS (
    SELECT 1 FROM service_item_assemblies a
    WHERE a.company_id = la.company_id
      AND a.name = h.name
      AND a.deleted_at IS NULL
  )
  RETURNING id, company_id, name
)
INSERT INTO service_item_assembly_components
  (company_id, assembly_id, kind, name, quantity_per_unit, unit, unit_cost, waste_pct, sort_order)
SELECT ih.company_id, ih.id, c.kind, c.name, c.quantity_per_unit, c.unit,
       c.unit_cost, c.waste_pct, c.sort_order
FROM inserted_headers ih
JOIN component_def c ON c.assembly_name = ih.name;
