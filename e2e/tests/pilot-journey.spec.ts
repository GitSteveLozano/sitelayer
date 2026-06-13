import { test, expect, fetchWorkflowSnapshot } from '../fixtures/auth'

/**
 * Spec — pilot-journey (happy path, gap #9 follow-on).
 *
 * One cheap end-to-end happy path that stitches the pilot's core surfaces
 * together through REAL UI navigation + a real button click, rather than
 * direct API POSTs. The named pilot loop is
 *   login → project → estimate → send
 * and the cheap, seed-backed slice of it we exercise here is:
 *   project detail → estimate push detail → (UI click) Mark reviewed.
 *
 * WHY this shape (and what is deliberately TODO):
 *   - LOGIN: skipped on purpose. The e2e fixtures authenticate via the dev
 *     act-as channel (e2e/fixtures/auth.ts), NOT a real Clerk sign-in, so a
 *     genuine login leg needs a Clerk test user + the demo sign-in-link flow
 *     (scripts/smoke-tier.sh check 6 already exercises the Clerk ticket
 *     exchange). TODO: add a Clerk-backed login leg when the e2e tier gets a
 *     seeded Clerk test user.
 *   - SEND to QBO: the terminal "send" is a worker-driven QBO push
 *     (POST_REQUESTED → posting → posted), and the QBO side-effect is stubbed
 *     in e2e. We drive the human REVIEW step through the UI button (the
 *     onClick→mutation wiring a blind port can drop) and leave the worker-only
 *     POST_SUCCEEDED to the queue/workflow tests. TODO: extend to assert the
 *     `posted` terminal once the e2e worker's QBO stub is asserted here.
 *
 * This is intentionally a THIN happy path — the per-workflow click-throughs
 * live in admin-estimate-push.spec.ts / office-rental-billing.spec.ts; this
 * spec proves the surfaces chain together for the pilot demo.
 *
 * FIXTURE ISOLATION (why the click-through is now UNCONDITIONAL):
 *   This journey drives its OWN dedicated estimate_push row ('…000308') on its
 *   OWN project ('…000301'), seeded in a KNOWN `drafted` start state by
 *   migration `docker/postgres/init/029_e2e_pilot_journey_fixture.sql`. It is
 *   the only reference to id 308 — admin-estimate-push.spec.ts walks the SHARED
 *   row ('…000208') and the worker only drains the outbox `post_qbo_estimate`
 *   mutation, so nothing else advances 308 past `drafted`. The human-review leg
 *   therefore runs every time, with no `if (state === 'drafted')` guard.
 */

type EstimatePushSnapshot = {
  state: 'drafted' | 'reviewed' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

// Dedicated, ISOLATED ids seeded by migration 029 — distinct from the SHARED
// seed-script rows (project '…000201' / estimate_push '…000208' in
// e2e/fixtures/ids.ts) that other specs + the worker mutate. Overridable via
// env so the seed lane can re-pin without editing this spec.
const PILOT_JOURNEY_PROJECT_ID = (
  process.env.E2E_PILOT_JOURNEY_PROJECT_ID ?? '00000000-0000-4000-8000-000000000301'
).trim()
const PILOT_JOURNEY_ESTIMATE_PUSH_ID = (
  process.env.E2E_PILOT_JOURNEY_ESTIMATE_PUSH_ID ?? '00000000-0000-4000-8000-000000000308'
).trim()

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec(
  'pilot happy path: project → estimate → review (UI click-through)',
  { tag: '@journey' },
  async ({ adminPage }) => {
    const projectId = PILOT_JOURNEY_PROJECT_ID
    const pushId = PILOT_JOURNEY_ESTIMATE_PUSH_ID

    // 1. PROJECT — land on the seeded project detail screen. It must render (not
    //    crash into the root error boundary) — the first leg of the journey.
    await adminPage.goto(`/projects/${projectId}`)
    await expect(adminPage.getByRole('heading', { name: /Sitelayer hit an error\./i })).toHaveCount(0)
    await adminPage.waitForLoadState('networkidle').catch(() => {})

    // 2. ESTIMATE — open the dedicated estimate push detail for this pilot.
    //    Because this row ('…000308') is journey-exclusive (migration 029), its
    //    start state is DETERMINISTICALLY `drafted` — assert that exactly.
    const initial = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, `/api/estimate-pushes/${pushId}`)
    expect(initial.state).toBe('drafted')

    await adminPage.goto(`/financial/estimate-pushes/${pushId}`)
    // The detail screen MUST render — the state Pill shows the literal
    // `drafted` state, the estimate leg of the journey.
    await expect(adminPage.getByText('drafted', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

    // 3. SEND (human leg) — drive the real role-located action button. From the
    //    seeded `drafted` start the label is "Mark reviewed"
    //    (packages/workflows/src/estimate-push.ts); the click fires the
    //    onClick→dispatch(REVIEW) mutation through the estimate-push XState
    //    machine — a real UI mutation, not a direct API POST. This leg is now
    //    UNCONDITIONAL: nothing but this spec mutates row 308 (see the FIXTURE
    //    ISOLATION note above), so the row is always fresh at `drafted`.
    await adminPage.getByRole('button', { name: 'Mark reviewed' }).click()
    await expect(adminPage.getByText('reviewed', { exact: true }).first()).toBeVisible({ timeout: 10_000 })

    // Server-truth cross-check: the click drove a real reducer transition.
    const after = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, `/api/estimate-pushes/${pushId}`)
    expect(after.state).toBe('reviewed')
    expect(after.state_version).toBe(initial.state_version + 1)

    // TODO(pilot): extend with the Clerk-backed login leg and the worker-driven
    // QBO `posted` terminal once the e2e tier seeds a Clerk test user + asserts
    // the QBO stub. Scaffolded here so the journey grows in one place.
  },
)
