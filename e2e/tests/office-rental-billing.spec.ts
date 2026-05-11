import { test, expect, dispatchWorkflowEvent, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 5 — office-rental-billing.
 *
 * Office user approves a rental billing run and pushes it to QBO. The
 * rental-billing workflow mirrors the estimate-push and labor-payroll
 * shapes: APPROVE → POST_REQUESTED → posting → posted.
 *
 * Wire: POST /api/rental-billing-runs/:id/events
 * UI:   `/financial/billing-runs/:id` — billing-run-detail renders the
 *       literal `state` string ("posted") in a Pill.
 *       (apps/web/src/screens/financial/billing-run-detail.tsx)
 */

type RentalBillingSnapshot = {
  state: 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('office user approves and posts a rental billing run', async ({ officePage }) => {
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
  expect(['posting', 'posted']).toContain(posting.state)

  await expect
    .poll(
      async () => {
        const latest = await fetchWorkflowSnapshot<RentalBillingSnapshot>(officePage, snapshotPath)
        return latest.state
      },
      { timeout: 10_000, intervals: [250, 500, 1000] },
    )
    .toBe('posted')

  // UI assertion — billing-run-detail screen reflects posted state.
  await officePage.goto(`/financial/billing-runs/${runId}`)
  await expect(officePage.getByText('posted', { exact: true })).toBeVisible()
})
