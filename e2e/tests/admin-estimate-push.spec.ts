import type { Page } from '@playwright/test'
import { test, expect, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 2 — admin-estimate-push.
 *
 * Admin advances a seeded estimate push through the human-controlled
 * QBO handoff, then the WORKER drives it home:
 *   drafted → reviewed → approved → posting → (worker) posted
 *
 * Wire: POST /api/estimate-pushes/:id/events
 * UI:   `/financial/estimate-pushes/:id` — estimate-push-detail renders the
 *       literal state string in a Pill and an Actions row of buttons whose
 *       labels come straight from the workflow's next_events
 *       (packages/workflows/src/estimate-push.ts).
 *       (apps/web/src/screens/financial/estimate-push-detail.tsx)
 *
 * FULL CLICK-THROUGH (WF-1). Every human transition is driven by a REAL
 * button CLICK on the rendered detail screen — not a direct API POST. We
 * follow the ordered chain, and for each step locate the on-screen button by
 * its next_events label (`getByRole('button', { name })`) and click it. A port
 * that lost any onClick→mutation wiring FAILS here. This mirrors the genuine
 * click-through in foreman-field-event.spec.ts.
 *
 * WORKER-DRIVEN TERMINAL (WF-3). After the final human event (POST_REQUESTED →
 * posting) we assert the worker-only `POST_SUCCEEDED` transition lands: poll
 * `fetchWorkflowSnapshot` until `state === 'posted'` with the QBO estimate id
 * populated. The e2e worker drains the stubbed QBO push inside Playwright's
 * window, so the terminal is reachable in-test — no permissive
 * `/^(posting|posted)$/` tolerance.
 */

type EstimatePushNextEvent = { type: string; label: string }

type EstimatePushSnapshot = {
  state: 'drafted' | 'reviewed' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
  next_events: EstimatePushNextEvent[]
  context: { qbo_estimate_id: string | null }
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

/**
 * Poll the estimate-push snapshot until the e2e worker drives it to the
 * `posted` terminal with a populated QBO estimate id, then return that
 * snapshot. Fails the test if the terminal isn't reached in-window.
 */
async function pollForPosted(page: Page, snapshotPath: string): Promise<EstimatePushSnapshot> {
  let last: EstimatePushSnapshot | null = null
  await expect
    .poll(
      async () => {
        last = await fetchWorkflowSnapshot<EstimatePushSnapshot>(page, snapshotPath)
        return last.state === 'posted' && Boolean(last.context.qbo_estimate_id)
      },
      {
        message: 'e2e worker should drive estimate push posting → posted with a QBO id',
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
      },
    )
    .toBe(true)
  return last!
}

// Ordered human chain UP TO the QBO request. Each step names the event we drive
// and the (non-racing) state the reducer lands in. The on-screen button label is
// resolved at runtime from the live snapshot's next_events so the spec follows
// the workflow, not a hardcoded copy of its labels. POST_REQUESTED is handled
// separately because the e2e worker may drain `posting → posted` before the UI
// can settle on the transient `posting` Pill.
const HUMAN_CHAIN: Array<{ event: string; expected: EstimatePushSnapshot['state'] }> = [
  { event: 'REVIEW', expected: 'reviewed' },
  { event: 'APPROVE', expected: 'approved' },
]

/** Click the on-screen button that drives `event`, resolving its label from the
 *  live snapshot's next_events. */
async function clickAction(page: Page, snapshotPath: string, event: string): Promise<void> {
  const before = await fetchWorkflowSnapshot<EstimatePushSnapshot>(page, snapshotPath)
  const action = before.next_events.find((ev) => ev.type === event)
  expect(action, `next_events should offer ${event} from ${before.state}`).toBeTruthy()
  // Drives the onClick→dispatch through the estimate-push XState machine, the
  // exact wiring a blind port can drop.
  await page.getByRole('button', { name: action!.label, exact: true }).click()
}

runSpec('admin requests an estimate push through the QBO handoff', { tag: '@estimate' }, async ({ adminPage }) => {
  const pushId = FIXTURE_IDS.estimatePushId
  const snapshotPath = `/api/estimate-pushes/${pushId}`

  // Sanity-check the seed: the push starts `drafted`.
  const initial = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, snapshotPath)
  expect(initial.state).toBe('drafted')

  // Open the detail screen — the Actions row renders one MButton per
  // next_event, labelled from the reducer.
  await adminPage.goto(`/financial/estimate-pushes/${pushId}`)
  await expect(adminPage.getByText('drafted', { exact: true })).toBeVisible()

  let prevVersion = initial.state_version
  for (const step of HUMAN_CHAIN) {
    await clickAction(adminPage, snapshotPath, step.event)

    // The state Pill flips once the reducer transition resolves.
    await expect(adminPage.getByText(step.expected, { exact: true })).toBeVisible({ timeout: 10_000 })

    // Server-truth cross-check: advanced to the expected state with a bumped
    // version — proof the click drove a real reducer transition.
    const after = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, snapshotPath)
    expect(after.state).toBe(step.expected)
    expect(after.state_version).toBe(prevVersion + 1)
    prevVersion = after.state_version
  }

  // approved → posting: the final human CLICK kicks off the QBO push. We don't
  // assert the transient `posting` Pill (the worker can drain it away mid-frame)
  // — the worker-driven terminal below is the real assertion.
  await clickAction(adminPage, snapshotPath, 'POST_REQUESTED')

  // --- WORKER-DRIVEN TERMINAL: posting → posted (POST_SUCCEEDED) ------------
  // The worker-only POST_SUCCEEDED lands `posted` with the QBO estimate id.
  // Poll the snapshot until the e2e worker drains the stubbed push — the run is
  // only terminal once `posted` AND the QBO id is populated.
  const terminal = await pollForPosted(adminPage, snapshotPath)
  expect(terminal.state).toBe('posted')
  expect(terminal.context.qbo_estimate_id, 'posted run should carry a QBO estimate id').toBeTruthy()

  // UI cross-check: the detail screen reflects the worker-driven terminal.
  await adminPage.goto(`/financial/estimate-pushes/${pushId}`)
  await expect(adminPage.getByText('posted', { exact: true })).toBeVisible({ timeout: 10_000 })
})
