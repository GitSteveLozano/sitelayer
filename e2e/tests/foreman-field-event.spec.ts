import { test, expect, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 3 — foreman-field-event.
 *
 * Worker (e2e-member) filed a blocker before the spec runs (seed step).
 * The foreman opens the issue in fm-blocker-detail
 * (`/foreman/blocker/:issueId`) and clicks Resolve. The screen wires
 * to PATCH /api/worker-issues/:id with
 *   { event: 'RESOLVE', state_version, action, message_to_worker }
 *
 * Expected: the field-event workflow transitions `open → resolved`
 * and the foreman-blocker-detail screen swaps its bottom segmented
 * picker for the green "Resolved <relative time>" confirmation banner
 * (see apps/web/src/screens/mobile/foreman-blocker-detail.tsx line ~328).
 */

type FieldEventSnapshot = {
  state: 'open' | 'resolved' | 'escalated' | 'dismissed'
  state_version: number
  context: {
    resolved_at?: string | null
    resolved_action?: string | null
  }
}

const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('foreman resolves a worker-flagged blocker', { tag: '@foreman' }, async ({ foremanPage }) => {
  const issueId = FIXTURE_IDS.fieldEventIssueId
  const issuePath = `/api/worker-issues/${issueId}`

  // Sanity-check the seed: snapshot should be `open` and the resolve
  // PATCH is available as a next_event.
  const initial = await fetchWorkflowSnapshot<FieldEventSnapshot>(foremanPage, issuePath)
  expect(initial.state).toBe('open')

  // Navigate to the foreman blocker detail screen. The web shell mounts
  // it at `/foreman/blocker/:issueId` inside the mobile shell (see
  // apps/web/src/screens/mobile-shell.tsx).
  await foremanPage.goto(`/foreman/blocker/${issueId}`)

  // The resolution picker requires an action selection before the
  // Resolve button enables. "Use what's on hand" is the lowest-friction
  // option that doesn't trigger any downstream change-order side-effects.
  await foremanPage.getByRole('button', { name: /Use what.+on hand/i }).click()

  // The API's RESOLVE schema (packages/workflows/src/field-event.ts)
  // requires a non-empty `message_to_worker` (min(1) max(4000)). Fill
  // the "Reply to worker" textarea — the placeholder hints at the
  // expected shape — before clicking Resolve. Without this the PATCH
  // returns 400 and the screen stays on the picker.
  await foremanPage.getByPlaceholder(/On its way/i).fill('On its way · 30m')

  await foremanPage.getByRole('button', { name: 'Resolve', exact: true }).click()

  // After the PATCH succeeds the foreman-blocker-detail screen renders
  // the green "Resolved …" confirmation text. The leading word is enough
  // to assert state — the suffix is a relative timestamp that varies.
  await expect(foremanPage.getByText(/^Resolved/)).toBeVisible({ timeout: 10_000 })

  // Server-truth cross-check: state should now be `resolved` with a
  // bumped version and a populated resolution timestamp.
  const after = await fetchWorkflowSnapshot<FieldEventSnapshot>(foremanPage, issuePath)
  expect(after.state).toBe('resolved')
  expect(after.state_version).toBe(initial.state_version + 1)
  expect(after.context.resolved_at).toBeTruthy()
})
