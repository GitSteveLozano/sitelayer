-- 029_e2e_pilot_journey_fixture.sql
--
-- Dedicated, ISOLATED seed row for the pilot-journey e2e spec
-- (e2e/tests/pilot-journey.spec.ts).
--
-- WHY this exists
-- ----------------
-- pilot-journey used to drive the SHARED estimate_push fixture row
-- ('…000208') that `apps/api/scripts/seed-e2e-fixtures.ts` creates and that
-- admin-estimate-push.spec.ts ALSO walks through reviewed → approved → posted.
-- In a shared run that contention left row 208 past its `drafted` start, so
-- pilot-journey had to GUARD its click-through (`if (state === 'drafted')`) and
-- skip the human-review leg whenever another spec had advanced the row first.
-- That made the journey's most important assertion (the real UI click →
-- reducer transition) non-deterministic.
--
-- This migration seeds a SEPARATE estimate_push ('…000308') that ONLY
-- pilot-journey references. Nothing else (no other spec, not the seed script,
-- not the worker — which drains the outbox `post_qbo_estimate` mutation, not a
-- blanket "advance every drafted push" scan) touches id 308, so it stays in
-- `drafted` for every run and the spec's click-through becomes UNCONDITIONAL.
--
-- It rides on its OWN dedicated project ('…000301') + customer ('…000302') so
-- it never collides with the script-seeded lifecycle project ('…000201') that
-- project-lifecycle / closeout specs and the worker also mutate.
--
-- PROPERTIES (matches the e2e-fixture migration style — see
-- 008_rental_invoice_push_lane.sql / 017_send_estimate_share_lane.sql for the
-- forward-only additive lane-seed precedent, and 016_restore_constrained_role.sql
-- for the `current_database() ~ '^sitelayer_prod'` prod tier-gate):
--   * ADDITIVE + RE-RUNNABLE — every INSERT is `ON CONFLICT DO NOTHING`, so
--     re-applying this file (or `reset-dev-db.sh`) is a no-op.
--   * TIER-GATED to non-prod — the whole seed is skipped when the database is
--     a prod database (`^sitelayer_prod(_|$)`); the dedicated `e2e-fixtures`
--     tenant never reaches a customer-facing prod DB anyway, but the gate makes
--     that explicit and matches 016's precedent.
--   * Targets the dedicated `e2e-fixtures` company (id seeded by the baseline:
--     '8440c0ad-d8d3-49dd-80c7-e0516427f981'); the production `la-operations`
--     tenant is never touched.
--
-- Deterministic UUIDs use the UUIDv4 version/variant nibbles ('4' at position
-- 14, '8' at position 19) so `apps/api/src/http-utils.ts:isValidUuid` accepts
-- them at route entry. The tail numbering follows the seed-script convention
-- (100s = bootstrap entities, 200s = SHARED workflow rows); 300s are the
-- pilot-journey-only ISOLATED rows.

DO $$
DECLARE
  current_db  text := current_database();
  is_prod     boolean := current_db ~ '^sitelayer_prod(_|$)';
  company_id  uuid := '8440c0ad-d8d3-49dd-80c7-e0516427f981';  -- e2e-fixtures
  customer_id uuid := '00000000-0000-4000-8000-000000000302';
  project_id  uuid := '00000000-0000-4000-8000-000000000301';
  push_id     uuid := '00000000-0000-4000-8000-000000000308';
BEGIN
  IF is_prod THEN
    RAISE NOTICE 'e2e pilot-journey fixture: skipping in prod database %', current_db;
    RETURN;
  END IF;

  -- The e2e-fixtures company is seeded by the baseline. If it is somehow
  -- absent (a partially-migrated throwaway DB), skip rather than fail — the
  -- seed script (seed-e2e-fixtures.ts) also tolerates this ordering.
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = company_id) THEN
    RAISE NOTICE 'e2e pilot-journey fixture: company % missing, skipping', company_id;
    RETURN;
  END IF;

  -- Dedicated customer for the pilot-journey project.
  INSERT INTO public.customers (id, company_id, name, source)
  VALUES (customer_id, company_id, 'E2E Pilot Journey Customer', 'seed')
  ON CONFLICT (id) DO NOTHING;

  -- Dedicated project — renders the project-detail leg (leg 1) of the journey.
  -- Lifecycle starts in 'draft'; legacy `status` stays 'lead'.
  INSERT INTO public.projects (
    id, company_id, customer_id, customer_name, name, division_code, status,
    bid_total, labor_rate, target_sqft_per_hr, bonus_pool,
    lifecycle_state, lifecycle_state_version
  )
  VALUES (
    project_id, company_id, customer_id, 'E2E Pilot Journey Customer',
    'E2E Pilot Journey', 'D4', 'lead',
    25000.00, 38.00, 4.50, 5000.00, 'draft', 1
  )
  ON CONFLICT (id) DO NOTHING;

  -- Dedicated estimate_push in the KNOWN `drafted` start state. Only
  -- pilot-journey references this id, so its click-through (drafted → REVIEW →
  -- reviewed) is deterministic. Zero lines is fine — the detail screen renders
  -- a "No lines." card and the state Pill + "Mark reviewed" action regardless.
  INSERT INTO public.estimate_pushes (
    id, company_id, project_id, customer_id, status, state_version, subtotal
  )
  VALUES (
    push_id, company_id, project_id, customer_id, 'drafted', 1, 25000.00
  )
  ON CONFLICT (id) DO NOTHING;
END
$$;
