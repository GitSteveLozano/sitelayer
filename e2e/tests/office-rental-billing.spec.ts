import type { Page } from '@playwright/test'
import { test, expect, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 5 — office-rental-billing.
 *
 * Office user walks a rental billing run through the human handoff, then the
 * WORKER drives it home:
 *   generated → approved → posting → (worker) posted
 *
 * Wire: POST /api/rental-billing-runs/:id/events
 * UI:   `/financial/billing-runs/:id` — billing-run-detail renders the literal
 *       `state` string in a Pill and an Actions grid of buttons whose labels
 *       come straight from the workflow's next_events
 *       (packages/workflows/src/rental-billing.ts).
 *       (apps/web/src/screens/financial/billing-run-detail.tsx)
 *
 * FULL CLICK-THROUGH (WF-1). Every human transition is driven by a REAL button
 * CLICK on the rendered detail screen — not a direct API POST. We follow the
 * ordered chain, and for each step locate the on-screen button by its
 * next_events label (`getByRole('button', { name })`) and click it. A port that
 * lost any onClick→mutation wiring FAILS here. This mirrors the genuine
 * click-through in foreman-field-event.spec.ts.
 *
 * WORKER-DRIVEN TERMINAL (WF-3). After the final human event (POST_REQUESTED →
 * posting) we assert the worker-only `POST_SUCCEEDED` transition lands: poll
 * `fetchWorkflowSnapshot` until `state === 'posted'` with the QBO invoice id
 * populated. The e2e worker drains the stubbed QBO push inside Playwright's
 * window — no permissive `/^(posting|posted)$/` tolerance.
 */

type RentalBillingNextEvent = { type: string; label: string }

type RentalBillingSnapshot = {
  state: 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
  next_events: RentalBillingNextEvent[]
  context: { qbo_invoice_id: string | null }
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

// Ordered human chain UP TO the QBO request. The on-screen button label is
// resolved at runtime from the live snapshot's next_events so the spec follows
// the workflow, not a hardcoded copy of its labels. POST_REQUESTED is handled
// separately because the e2e worker may drain `posting → posted` before the UI
// can settle on the transient `posting` Pill.
const HUMAN_CHAIN: Array<{ event: string; expected: RentalBillingSnapshot['state'] }> = [
  { event: 'APPROVE', expected: 'approved' },
]

/** Click the on-screen button that drives `event`, resolving its label from the
 *  live snapshot's next_events. */
async function clickAction(page: Page, snapshotPath: string, event: string): Promise<void> {
  const before = await fetchWorkflowSnapshot<RentalBillingSnapshot>(page, snapshotPath)
  const action = before.next_events.find((ev) => ev.type === event)
  expect(action, `next_events should offer ${event} from ${before.state}`).toBeTruthy()
  // Drives the onClick→dispatch through the billing-review XState machine, the
  // exact wiring a blind port can drop.
  await page.getByRole('button', { name: action!.label, exact: true }).click()
}

/**
 * Poll the billing-run snapshot until the e2e worker drives it to the `posted`
 * terminal with a populated QBO invoice id, then return that snapshot.
 */
async function pollForPosted(page: Page, snapshotPath: string): Promise<RentalBillingSnapshot> {
  let last: RentalBillingSnapshot | null = null
  await expect
    .poll(
      async () => {
        last = await fetchWorkflowSnapshot<RentalBillingSnapshot>(page, snapshotPath)
        return last.state === 'posted' && Boolean(last.context.qbo_invoice_id)
      },
      {
        message: 'e2e worker should drive rental billing posting → posted with a QBO id',
        timeout: 30_000,
        intervals: [500, 1_000, 2_000],
      },
    )
    .toBe(true)
  return last!
}

runSpec('office user approves and requests a rental billing post', { tag: '@rental' }, async ({ officePage }) => {
  const runId = FIXTURE_IDS.billingRunId
  const snapshotPath = `/api/rental-billing-runs/${runId}`

  // Sanity-check the seed: the run starts `generated`.
  const initial = await fetchWorkflowSnapshot<RentalBillingSnapshot>(officePage, snapshotPath)
  expect(initial.state).toBe('generated')

  // Open the detail screen — the Actions grid renders one MButton per
  // next_event, labelled from the reducer.
  await officePage.goto(`/financial/billing-runs/${runId}`)
  await expect(officePage.getByText('generated', { exact: true })).toBeVisible()

  let prevVersion = initial.state_version
  for (const step of HUMAN_CHAIN) {
    // The button label is resolved from server truth so the click targets
    // exactly the affordance the workflow offers (generated → "Approve billing
    // run").
    await clickAction(officePage, snapshotPath, step.event)

    // The state Pill flips once the reducer transition resolves.
    await expect(officePage.getByText(step.expected, { exact: true })).toBeVisible({ timeout: 10_000 })

    // Server-truth cross-check: advanced to the expected state with a bumped
    // version — proof the click drove a real reducer transition.
    const after = await fetchWorkflowSnapshot<RentalBillingSnapshot>(officePage, snapshotPath)
    expect(after.state).toBe(step.expected)
    expect(after.state_version).toBe(prevVersion + 1)
    prevVersion = after.state_version
  }

  // approved → posting: the final human CLICK kicks off the QBO push. We don't
  // assert the transient `posting` Pill (the worker can drain it away mid-frame)
  // — the worker-driven terminal below is the real assertion.
  await clickAction(officePage, snapshotPath, 'POST_REQUESTED')

  // --- WORKER-DRIVEN TERMINAL: posting → posted (POST_SUCCEEDED) ------------
  // The human chain ended at `posting`; the worker-only POST_SUCCEEDED lands
  // `posted` with the QBO invoice id. Poll until the e2e worker drains the
  // stubbed push — terminal only once `posted` AND the QBO id is populated.
  const terminal = await pollForPosted(officePage, snapshotPath)
  expect(terminal.state).toBe('posted')
  expect(terminal.context.qbo_invoice_id, 'posted run should carry a QBO invoice id').toBeTruthy()

  // UI cross-check: the detail screen reflects the worker-driven terminal.
  await officePage.goto(`/financial/billing-runs/${runId}`)
  await expect(officePage.getByText('posted', { exact: true })).toBeVisible({ timeout: 10_000 })
})
