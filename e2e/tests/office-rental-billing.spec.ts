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
 *       literal `state` string in a Pill. The e2e worker may advance the
 *       run from posting to posted before the detail route paints.
 *       (apps/web/src/screens/financial/billing-run-detail.tsx)
 */

type RentalBillingSnapshot = {
  state: 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('office user approves and requests a rental billing post', async ({ officePage }) => {
  const runId = FIXTURE_IDS.billingRunId
  const snapshotPath = `/api/rental-billing-runs/${runId}`
  const eventsPath = `${snapshotPath}/events`

  const initial = await fetchWorkflowSnapshot<RentalBillingSnapshot>(officePage, snapshotPath)
  expect(initial.state).toBe('generated')

  const approved = await dispatchWorkflowEvent<RentalBillingSnapshot>(officePage, eventsPath, {
    event: 'APPROVE',
    state_version: initial.state_version,
  })
  expect(approved.state).toBe('approved')

  const posting = await dispatchWorkflowEvent<RentalBillingSnapshot>(officePage, eventsPath, {
    event: 'POST_REQUESTED',
    state_version: approved.state_version,
  })
  expect(posting.state).toBe('posting')

  // UI assertion — billing-run-detail screen reflects the handoff or
  // worker-advanced state.
  await officePage.goto(`/financial/billing-runs/${runId}`)
  await expect(officePage.getByText(/^(posting|posted)$/)).toBeVisible()
})
