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
 * Wire: POST /api/estimate-pushes/:id/events
 * UI:   `/financial/estimate-pushes/:id` — estimate-push-detail renders the
 *       literal state string in a Pill and an Actions row of role-located
 *       buttons whose labels come from the workflow's next_events
 *       (packages/workflows/src/estimate-push.ts).
 *       (apps/web/src/screens/financial/estimate-push-detail.tsx)
 *
 * CLICK-THROUGH (gap #9). The first transition (REVIEW) is driven by a REAL
 * role-located button CLICK on the rendered screen — not a direct API POST — so
 * a port that lost its onClick→mutation wiring FAILS here (it used to pass: the
 * spec drove every transition via dispatchWorkflowEvent and only asserted a
 * Pill, never exercising the button). This mirrors the genuine click-through in
 * foreman-field-event.spec.ts. The remaining APPROVE / POST_REQUESTED steps
 * stay API calls (the click-through has already proven the UI mutation path).
 *
 * `POST_REQUESTED` is the last human event; the worker-only `POST_SUCCEEDED`
 * transition is covered in queue/workflow tests. This browser spec tolerates
 * the background worker draining QBO outbox rows inside Playwright's window.
 */

type EstimatePushSnapshot = {
  state: 'drafted' | 'reviewed' | 'approved' | 'posting' | 'posted' | 'failed' | 'voided'
  state_version: number
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('admin requests an estimate push through the QBO handoff', { tag: '@estimate' }, async ({ adminPage }) => {
  const pushId = FIXTURE_IDS.estimatePushId
  const snapshotPath = `/api/estimate-pushes/${pushId}`
  const eventsPath = `${snapshotPath}/events`

  // Sanity-check the seed: the push starts `drafted`.
  const initial = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, snapshotPath)
  expect(initial.state).toBe('drafted')

  // --- REAL click-through: open the detail screen and click "Mark reviewed" -
  await adminPage.goto(`/financial/estimate-pushes/${pushId}`)
  await expect(adminPage.getByText('drafted', { exact: true })).toBeVisible()

  // The Actions row renders one MButton per next_event; from `drafted` the
  // human action is labelled "Mark reviewed"
  // (packages/workflows/src/estimate-push.ts). Clicking it fires the
  // onClick→dispatch(REVIEW) mutation through the estimate-push XState machine
  // — the exact wiring a blind port can drop.
  await adminPage.getByRole('button', { name: 'Mark reviewed' }).click()

  // After the mutation resolves the Pill flips to `reviewed`.
  await expect(adminPage.getByText('reviewed', { exact: true })).toBeVisible({ timeout: 10_000 })

  // Server-truth cross-check: advanced to `reviewed` with a bumped version.
  let snap = await fetchWorkflowSnapshot<EstimatePushSnapshot>(adminPage, snapshotPath)
  expect(snap.state).toBe('reviewed')
  expect(snap.state_version).toBe(initial.state_version + 1)

  // reviewed → approved (events endpoint; the UI path is already proven above)
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

  // UI assertion — the detail screen shows the literal state. The e2e worker
  // may advance posting -> posted before the route repaints.
  await adminPage.goto(`/financial/estimate-pushes/${pushId}`)
  await expect(adminPage.getByText(/^(posting|posted)$/)).toBeVisible()
})
