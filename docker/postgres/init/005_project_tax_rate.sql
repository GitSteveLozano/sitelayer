-- 005_project_tax_rate.sql — sales tax on estimates (PlanSwift gap G4, cont.).
--
-- Estimates had zero tax support. PlanSwift estimates apply sales tax to the
-- taxable portion of the bid. This adds a per-project tax rate (tax varies by
-- jurisdiction / project location, so per-project is the right grain) that the
-- estimate tax endpoint applies to the taxable subtotal.
--
-- Taxable basis (v1 default, applied in the route, not the schema): material +
-- freight + un-exploded flat lines are taxable; labor + sub are exempt — the
-- common construction default. A configurable per-company tax_basis is a later
-- refinement.
--
-- Additive only: one nullable-with-default numeric column on projects (RLS
-- already covers it). 0 = no tax (current behavior), so existing projects are
-- unchanged.

ALTER TABLE public.projects
    ADD COLUMN IF NOT EXISTS tax_rate numeric(6, 5) DEFAULT 0 NOT NULL;
