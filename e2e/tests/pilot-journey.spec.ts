import { test, expect, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

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
 */

type EstimatePushSnapshot = {
  state: 'drafted' | 'reviewed' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec(
  'pilot happy path: project → estimate → review (UI click-through)',
  { tag: '@journey' },
  async ({ adminPage }) => {
    const projectId = FIXTURE_IDS.lifecycleProjectId
    const pushId = FIXTURE_IDS.estimatePushId

    // 1. PROJECT — land on the seeded project detail screen. It must render (not
    //    crash into the root error boundary) — the first leg of the journey.
    await adminPage.goto(`/projects/${projectId}`)
    await expect(adminPage.getByRole('heading', { name: /Sitelayer hit an error\./i })).toHaveCount(0)
    await adminPage.waitForLoadState('networkidle').catch(() => {})

    // 2. ESTIMATE — open the estimate push detail for this pilot.
    const initial = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, `/api/estimate-pushes/${pushId}`)

    await adminPage.goto(`/financial/estimate-pushes/${pushId}`)
    // The detail screen MUST render (the state Pill shows the literal state) —
    // the estimate leg of the journey, asserted regardless of which state the
    // shared fixture is in.
    await expect(adminPage.getByText(initial.state, { exact: true }).first()).toBeVisible({ timeout: 10_000 })

    // 3. SEND (human leg) — drive the real role-located action button when the
    //    fixture is at its seeded `drafted` start. From `drafted` the label is
    //    "Mark reviewed" (packages/workflows/src/estimate-push.ts); the click
    //    fires the onClick→dispatch(REVIEW) mutation through the estimate-push
    //    XState machine — a real UI mutation, not a direct API POST.
    //
    //    NOTE on fixture sharing: the seed creates ONE estimate push (id ...208)
    //    that admin-estimate-push.spec.ts also drives, and the e2e worker
    //    auto-advances it; so in a shared run this row may already be past
    //    `drafted`. We therefore guard the click on the live state. The journey's
    //    render + navigation legs (1 + 2) always run; the click-through leg runs
    //    when the fixture is fresh. TODO(pilot, seed lane): give this journey its
    //    OWN seeded push row so the click-through is unconditional + isolated.
    if (initial.state === 'drafted') {
      await adminPage.getByRole('button', { name: 'Mark reviewed' }).click()
      await expect(adminPage.getByText('reviewed', { exact: true })).toBeVisible({ timeout: 10_000 })

      // Server-truth cross-check: the click drove a real reducer transition.
      const after = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, `/api/estimate-pushes/${pushId}`)
      expect(after.state).toBe('reviewed')
      expect(after.state_version).toBe(initial.state_version + 1)
    }

    // TODO(pilot): extend with the Clerk-backed login leg and the worker-driven
    // QBO `posted` terminal once the e2e tier seeds a Clerk test user + asserts
    // the QBO stub. Scaffolded here so the journey grows in one place.
  },
)
