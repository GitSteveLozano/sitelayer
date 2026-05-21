import { test, expect, dispatchWorkflowEvent, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 2 — admin-estimate-push.
 *
 * Admin advances a seeded estimate push through the human-controlled
 * QBO handoff:
 *   drafted → reviewed → approved → posting
 *
 * The QBO side-effect itself is stubbed by the worker in the e2e env.
 * The spec drives the human workflow state machine directly via the events endpoint:
 *   POST /api/estimate-pushes/:id/events
 *
 * `POST_REQUESTED` is the last human event. The worker-only
 * `POST_SUCCEEDED` transition is covered in queue/workflow tests; this
 * browser spec should tolerate the background worker draining QBO outbox
 * rows inside Playwright's timing window.
 *
 * Per `apps/web/src/screens/financial/estimate-push-detail.tsx` the
 * detail screen renders the literal state string in a Pill, and the
 * routing path is `/financial/estimate-pushes/:id`.
 */

type EstimatePushSnapshot = {
  state: 'drafted' | 'reviewed' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('admin requests an estimate push through the QBO handoff', async ({ adminPage }) => {
  const pushId = FIXTURE_IDS.estimatePushId
  const snapshotPath = `/api/estimate-pushes/${pushId}`
  const eventsPath = `${snapshotPath}/events`

  let snap = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, snapshotPath)
  expect(snap.state).toBe('drafted')

  // drafted → reviewed
  snap = await dispatchWorkflowEvent<EstimatePushSnapshot>(adminPage, eventsPath, {
    event: 'REVIEW',
    state_version: snap.state_version,
  })
  expect(snap.state).toBe('reviewed')

  // reviewed → approved
  snap = await dispatchWorkflowEvent<EstimatePushSnapshot>(adminPage, eventsPath, {
    event: 'APPROVE',
    state_version: snap.state_version,
  })
  expect(snap.state).toBe('approved')

  // approved → posting. POST_SUCCEEDED is worker-only and intentionally
  // rejected by the human event endpoint.
  snap = await dispatchWorkflowEvent<EstimatePushSnapshot>(adminPage, eventsPath, {
    event: 'POST_REQUESTED',
    state_version: snap.state_version,
  })
  expect(snap.state).toBe('posting')

  // UI assertion — the EstimatePushDetail screen shows the literal
  // state string inside a Pill. The e2e worker may advance posting -> posted
  // before the detail route paints.
  await adminPage.goto(`/financial/estimate-pushes/${pushId}`)
  await expect(adminPage.getByText(/^(posting|posted)$/)).toBeVisible()
})
