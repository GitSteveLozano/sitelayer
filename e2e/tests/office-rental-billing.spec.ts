import { test, expect, dispatchWorkflowEvent, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 5 — office-rental-billing.
 *
 * Office user approves a rental billing run and requests the QBO post.
 * The browser-visible human handoff is:
 *   APPROVE → POST_REQUESTED → posting
 *
 * Wire: POST /api/rental-billing-runs/:id/events
 * UI:   `/financial/billing-runs/:id` — billing-run-detail renders the
 *       literal `state` string in a Pill and an Actions grid of role-located
 *       buttons whose labels come from the workflow's next_events
 *       (packages/workflows/src/rental-billing.ts).
 *       (apps/web/src/screens/financial/billing-run-detail.tsx)
 *
 * CLICK-THROUGH (gap #9). The first transition (APPROVE) is driven by a REAL
 * role-located button CLICK on the rendered screen — not a direct API POST — so
 * a port that lost its onClick→mutation wiring FAILS here (it used to pass: the
 * spec drove every transition via dispatchWorkflowEvent and only asserted a
 * Pill, never exercising the button). This mirrors the genuine click-through in
 * foreman-field-event.spec.ts. The remaining POST_REQUESTED step stays an API
 * call (the click-through has already proven the UI mutation path end-to-end).
 */

type RentalBillingSnapshot = {
  state: 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('office user approves and requests a rental billing post', { tag: '@rental' }, async ({ officePage }) => {
  const runId = FIXTURE_IDS.billingRunId
  const snapshotPath = `/api/rental-billing-runs/${runId}`
  const eventsPath = `${snapshotPath}/events`

  // Sanity-check the seed: the run starts `generated`.
  const initial = await fetchWorkflowSnapshot<RentalBillingSnapshot>(officePage, snapshotPath)
  expect(initial.state).toBe('generated')

  // --- REAL click-through: open the detail screen and click "Approve" -------
  await officePage.goto(`/financial/billing-runs/${runId}`)
  // The state Pill shows the current literal state before we act.
  await expect(officePage.getByText('generated', { exact: true })).toBeVisible()

  // The Actions grid renders one MButton per next_event; from `generated` the
  // human action is labelled "Approve billing run"
  // (packages/workflows/src/rental-billing.ts). Clicking it fires the
  // onClick→dispatch(APPROVE) mutation through the billing-review XState
  // machine — the exact wiring a blind port can drop.
  await officePage.getByRole('button', { name: 'Approve billing run' }).click()

  // After the mutation resolves the Pill flips to `approved`. This asserts the
  // UI actually performed the transition (not just that a button exists).
  await expect(officePage.getByText('approved', { exact: true })).toBeVisible({ timeout: 10_000 })

  // Server-truth cross-check: the run advanced to `approved` with a bumped
  // version — proof the click drove a real reducer transition, not optimistic UI.
  const afterApprove = await fetchWorkflowSnapshot<RentalBillingSnapshot>(officePage, snapshotPath)
  expect(afterApprove.state).toBe('approved')
  expect(afterApprove.state_version).toBe(initial.state_version + 1)

  // Continue the handoff via the events endpoint (the click-through above has
  // already exercised the UI mutation path end-to-end).
  const posting = await dispatchWorkflowEvent<RentalBillingSnapshot>(officePage, eventsPath, {
    event: 'POST_REQUESTED',
    state_version: afterApprove.state_version,
  })
  expect(posting.state).toBe('posting')

  // UI assertion — the detail screen reflects the handoff or the
  // worker-advanced state (the e2e worker may post the run before the route
  // repaints).
  await officePage.goto(`/financial/billing-runs/${runId}`)
  await expect(officePage.getByText(/^(posting|posted)$/)).toBeVisible()
})
