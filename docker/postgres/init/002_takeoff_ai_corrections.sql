-- 002_takeoff_ai_corrections.sql — AI-takeoff correction flywheel (PlanSwift gap G2).
--
-- The AI takeoff pipeline proposes quantities into takeoff_drafts.takeoff_result_json,
-- and the operator reviews them and PROMOTES a subset into committed
-- takeoff_measurements (optionally remapping the service_item_code). Until now
-- that human decision was thrown away: the proposal stayed immutable in the
-- draft, the measurement recorded only the final value, and nothing paired
-- "what the AI proposed" with "what the human committed". Without that pairing
-- the AI can never improve on the operator's own plan types — there is no
-- training signal and no moat. Togal did not launch at 98%; it got there on
-- user corrections.
--
-- This table is that pairing. The promote handler writes one row per committed
-- quantity, capturing the immutable AI proposal alongside the human-final value
-- + the correction signals (did the operator change the classification code or
-- the value). It is written INSIDE the promote transaction (atomic with the
-- measurement insert) — a committed measurement always has its training row.
--
-- Additive only: one new tenant-scoped table + indexes + RLS (mirrors
-- public.takeoff_measurements). No backfill — the flywheel starts capturing
-- from the next promote forward, which is the point ("from commit one").

CREATE TABLE IF NOT EXISTS public.takeoff_ai_corrections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    project_id uuid NOT NULL,
    -- Drafts get pruned and measurements get deleted; the training row outlives
    -- both, so these are soft links (no hard FK on draft_id; measurement FK
    -- nulls out on delete) rather than cascade-delete parents.
    draft_id uuid,
    measurement_id uuid REFERENCES public.takeoff_measurements(id) ON DELETE SET NULL,
    quantity_id text NOT NULL,
    -- v1 writes 'kept' (promoted). Reserved: 'rejected' (AI proposed, human
    -- dropped) / 'skipped' (selected but un-promotable) for a later review-close
    -- signal.
    decision text NOT NULL DEFAULT 'kept',
    source text,

    -- ── AI proposal (immutable snapshot of what the pipeline proposed) ──
    ai_value numeric(14,3),
    ai_unit text,
    ai_confidence numeric(4,3),
    ai_service_item_code text,
    ai_quantity_kind text,
    ai_detector text,
    ai_detector_version text,
    ai_quantity_json jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- ── Human-final (what the operator committed) ──
    final_value numeric(14,3),
    final_unit text,
    final_service_item_code text,

    -- ── Correction signals (the training labels) ──
    service_item_code_changed boolean NOT NULL DEFAULT false,
    value_changed boolean NOT NULL DEFAULT false,

    created_by_user_id text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS takeoff_ai_corrections_company_created_idx
    ON public.takeoff_ai_corrections (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS takeoff_ai_corrections_project_idx
    ON public.takeoff_ai_corrections (company_id, project_id);
CREATE INDEX IF NOT EXISTS takeoff_ai_corrections_draft_idx
    ON public.takeoff_ai_corrections (draft_id);
-- Cheap "show me where the AI was wrong" training query.
CREATE INDEX IF NOT EXISTS takeoff_ai_corrections_changed_idx
    ON public.takeoff_ai_corrections (company_id)
    WHERE service_item_code_changed OR value_changed;

-- RLS — tenant isolation, identical predicate to public.takeoff_measurements.
ALTER TABLE public.takeoff_ai_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.takeoff_ai_corrections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_isolation ON public.takeoff_ai_corrections;
CREATE POLICY company_isolation ON public.takeoff_ai_corrections
    USING (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())))
    WITH CHECK (((public.app_current_company_id() IS NULL) OR (company_id = public.app_current_company_id())));
