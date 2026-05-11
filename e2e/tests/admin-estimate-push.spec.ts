import { test, expect, dispatchWorkflowEvent, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 2 — admin-estimate-push.
 *
 * Admin advances a seeded estimate push through the QBO pipeline:
 *   drafted → reviewed → approved → posting → posted
 *
 * The QBO side-effect itself is mocked at the seed layer (the worker
 * that drains the outbox isn't running in the e2e env), so the spec
 * drives the workflow state machine directly via the events endpoint:
 *   POST /api/estimate-pushes/:id/events
 *
 * The seed inserts a row in the `posting` ready-state stub for the
 * POST_REQUESTED → posted step where the workflow would normally
 * wait on a QBO callback. We simulate the callback by issuing
 * POST_REQUESTED followed by a small wait and a re-fetch — if the
 * test env's outbox processor isn't running, the seed pre-stages a
 * second "posted" row tied to the same id, and the assertion focuses
 * on the EstimatePushDetail screen showing the final `posted` state.
 *
 * Per `apps/web/src/screens/financial/estimate-push-detail.tsx` the
 * detail screen renders the literal state string in a Pill (e.g. the
 * text "posted"), and the routing path is `/financial/estimate-pushes/:id`.
 */

type EstimatePushSnapshot = {
  state: 'drafted' | 'reviewed' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('admin pushes an estimate through to posted', async ({ adminPage }) => {
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

  // approved → posting (the workflow side-effect handler completes
  // the posted transition once the QBO call returns — the e2e seed
  // pre-stages that completion so the next snapshot read shows `posted`).
  snap = await dispatchWorkflowEvent<EstimatePushSnapshot>(adminPage, eventsPath, {
    event: 'POST_REQUESTED',
    state_version: snap.state_version,
  })
  expect(['posting', 'posted']).toContain(snap.state)

  // Wait for the side-effect to land — the seed harness simulates
  // the QBO callback so the run finishes within a few seconds.
  await expect
    .poll(
      async () => {
        const latest = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, snapshotPath)
        return latest.state
      },
      { timeout: 10_000, intervals: [250, 500, 1000] },
    )
    .toBe('posted')

  // UI assertion — the EstimatePushDetail screen shows the literal
  // state string ("posted") inside a Pill.
  await adminPage.goto(`/financial/estimate-pushes/${pushId}`)
  await expect(adminPage.getByText('posted', { exact: true })).toBeVisible()
})
