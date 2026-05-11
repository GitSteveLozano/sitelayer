import { test, expect, dispatchWorkflowEvent, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 1 — admin-project-lifecycle.
 *
 * Admin walks the seeded `e2e-fixtures` project through the full
 * project-lifecycle workflow:
 *   draft → estimating → sent → accepted → in_progress → done → archived
 *
 * Each transition is driven via `POST /api/projects/:id/lifecycle/events`
 * (the same wire shape the LifecycleBanner button click produces), and
 * the UI is re-checked between steps to confirm the banner reflects
 * the new server-truth state.
 *
 * Per `apps/web/src/components/lifecycle/banner.tsx`, the banner renders
 * a `Pill` showing the label for the current state ("Drafting",
 * "Estimating", "Sent to client", "Accepted", "In progress", "Done",
 * "Archived"). We assert the label per step.
 */

type LifecycleSnapshot = {
  state: 'draft' | 'estimating' | 'sent' | 'accepted' | 'declined' | 'in_progress' | 'done' | 'archived'
  state_version: number
}

const STATE_LABELS: Record<LifecycleSnapshot['state'], string> = {
  draft: 'Drafting',
  estimating: 'Estimating',
  sent: 'Sent to client',
  accepted: 'Accepted',
  declined: 'Declined',
  in_progress: 'In progress',
  done: 'Done',
  archived: 'Archived',
}

// Skip-by-default until the parallel seed + act-as PRs land. CI sets
// E2E_RUN=1 once those are merged.
const runSpec = process.env.E2E_RUN === '1' ? test : test.skip

runSpec('admin walks project lifecycle through every state', async ({ adminPage }) => {
  const projectId = FIXTURE_IDS.lifecycleProjectId
  const lifecyclePath = `/api/projects/${projectId}/lifecycle`
  const eventsPath = `${lifecyclePath}/events`

  // Land on the project detail screen first so the LifecycleBanner is
  // visible for cross-checks between steps.
  await adminPage.goto(`/projects/${projectId}`)

  const transitions: Array<{ event: string; expected: LifecycleSnapshot['state'] }> = [
    { event: 'START_ESTIMATING', expected: 'estimating' },
    { event: 'SEND', expected: 'sent' },
    { event: 'ACCEPT', expected: 'accepted' },
    { event: 'START_WORK', expected: 'in_progress' },
    { event: 'COMPLETE', expected: 'done' },
    { event: 'ARCHIVE', expected: 'archived' },
  ]

  // Baseline: server should report the seeded `draft` state at v1.
  let snap = await fetchWorkflowSnapshot<LifecycleSnapshot>(adminPage, lifecyclePath)
  expect(snap.state).toBe('draft')

  for (const step of transitions) {
    const next = await dispatchWorkflowEvent<LifecycleSnapshot>(adminPage, eventsPath, {
      event: step.event,
      state_version: snap.state_version,
    })
    expect(next.state).toBe(step.expected)
    expect(next.state_version).toBe(snap.state_version + 1)
    snap = next

    // Cross-check the LifecycleBanner picks up the new state. The
    // banner polls/refetches on its own; we trigger a refetch by
    // reloading rather than waiting on TanStack Query's stale window.
    await adminPage.reload()
    await expect(adminPage.getByText(STATE_LABELS[step.expected], { exact: true })).toBeVisible()
  }
})
