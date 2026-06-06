import { test, expect, dispatchWorkflowEvent, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 4 — admin-time-review → labor-payroll.
 *
 * Multi-workflow chain. The seed pre-creates:
 *   - one time_review_run row in `pending` state (locks labor on APPROVE)
 *   - one labor_payroll_run row in `generated` state (sibling of the
 *     time review above so the chain runs end-to-end)
 *
 * Steps the admin walks through:
 *   1. APPROVE the time-review run (`pending → approved`). This locks
 *      the labor entries that feed the payroll run.
 *   2. The labor-payroll run is already seeded `generated` — admin
 *      APPROVEs it (`generated → approved`).
 *   3. Admin POST_REQUESTED → `posting`.
 *
 * `POST_SUCCEEDED` is worker-only and covered by queue/workflow tests.
 * This browser spec verifies the human-controlled QBO handoff and tolerates
 * the e2e worker advancing the run before the detail route paints.
 */

type TimeReviewSnapshot = {
  state: 'pending' | 'approved' | 'rejected'
  state_version: number
}

type LaborPayrollSnapshot = {
  state: 'generated' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('admin approves time review then requests labor payroll post', { tag: '@payroll' }, async ({ adminPage }) => {
  const timeReviewId = FIXTURE_IDS.timeReviewRunId
  const payrollId = FIXTURE_IDS.laborPayrollRunId

  const timeReviewPath = `/api/time-review-runs/${timeReviewId}`
  const timeReviewEventsPath = `${timeReviewPath}/events`
  const payrollPath = `/api/labor-payroll-runs/${payrollId}`
  const payrollEventsPath = `${payrollPath}/events`

  // 1. Time review: pending → approved (locks labor entries).
  const timeReviewBefore = await fetchWorkflowSnapshot<TimeReviewSnapshot>(adminPage, timeReviewPath)
  expect(timeReviewBefore.state).toBe('pending')

  const timeReviewAfter = await dispatchWorkflowEvent<TimeReviewSnapshot>(adminPage, timeReviewEventsPath, {
    event: 'APPROVE',
    state_version: timeReviewBefore.state_version,
  })
  expect(timeReviewAfter.state).toBe('approved')
  expect(timeReviewAfter.state_version).toBe(timeReviewBefore.state_version + 1)

  // 2. Labor payroll: generated → approved.
  const payrollBefore = await fetchWorkflowSnapshot<LaborPayrollSnapshot>(adminPage, payrollPath)
  expect(payrollBefore.state).toBe('generated')

  const payrollApproved = await dispatchWorkflowEvent<LaborPayrollSnapshot>(adminPage, payrollEventsPath, {
    event: 'APPROVE',
    state_version: payrollBefore.state_version,
  })
  expect(payrollApproved.state).toBe('approved')

  // 3. POST_REQUESTED → posting. POST_SUCCEEDED is worker-only.
  const payrollPosting = await dispatchWorkflowEvent<LaborPayrollSnapshot>(adminPage, payrollEventsPath, {
    event: 'POST_REQUESTED',
    state_version: payrollApproved.state_version,
  })
  expect(payrollPosting.state).toBe('posting')

  // UI cross-check: labor-payroll-run-detail renders the literal state
  // string in a Pill (mirrors estimate-push-detail). The e2e worker may
  // advance posting -> posted before the detail route paints.
  await adminPage.goto(`/financial/labor-payroll-runs/${payrollId}`)
  await expect(adminPage.getByText(/^(posting|posted)$/)).toBeVisible()
})
