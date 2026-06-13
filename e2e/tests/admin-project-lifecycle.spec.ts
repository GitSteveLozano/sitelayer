import { test, expect, fetchWorkflowSnapshot } from '../fixtures/auth'
import { FIXTURE_IDS } from '../fixtures/ids'

/**
 * Spec 1 — admin-project-lifecycle.
 *
 * Admin walks the seeded `e2e-fixtures` project through the full
 * project-lifecycle workflow:
 *   draft → estimating → sent → accepted → in_progress → done → archived
 *
 * FULL CLICK-THROUGH (WF-1). Every transition is driven by a REAL click on the
 * on-screen LifecycleBanner action button — not a direct API POST. The banner
 * (`apps/web/src/components/lifecycle/banner.tsx`) renders one button per
 * server-supplied `next_events` entry, labelled from the reducer
 * (packages/workflows/src/project-lifecycle.ts), and its onClick dispatches the
 * event through the `useProjectLifecycle` XState machine. We resolve the button
 * label for each step from the live snapshot's next_events (so a state offering
 * a branch — e.g. `sent` → "Mark accepted" / "Mark declined" — clicks the right
 * one), click it, then cross-check the banner Pill flips to the new state. A
 * port that lost the banner's onClick→mutation wiring FAILS here.
 *
 * Per the banner, the Pill shows the label for the current state ("Drafting",
 * "Estimating", "Sent to client", "Accepted", "In progress", "Done",
 * "Archived"). We assert that label per step.
 */

type LifecycleNextEvent = { type: string; label: string }

type LifecycleSnapshot = {
  state: 'draft' | 'estimating' | 'sent' | 'accepted' | 'declined' | 'in_progress' | 'done' | 'archived'
  state_version: number
  next_events: LifecycleNextEvent[]
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

runSpec('admin walks project lifecycle through every state', { tag: '@project' }, async ({ adminPage }) => {
  const projectId = FIXTURE_IDS.lifecycleProjectId
  const lifecyclePath = `/api/projects/${projectId}/lifecycle`

  // Land on the project detail screen so the LifecycleBanner is mounted and
  // its action buttons are clickable.
  await adminPage.goto(`/projects/${projectId}`)

  const transitions: Array<{ event: string; expected: LifecycleSnapshot['state'] }> = [
    { event: 'START_ESTIMATING', expected: 'estimating' },
    { event: 'SEND', expected: 'sent' },
    { event: 'ACCEPT', expected: 'accepted' },
    { event: 'START_WORK', expected: 'in_progress' },
    { event: 'COMPLETE', expected: 'done' },
    { event: 'ARCHIVE', expected: 'archived' },
  ]

  // Baseline: server should report the seeded `draft` state, and the banner
  // should show the "Drafting" Pill.
  const initial = await fetchWorkflowSnapshot<LifecycleSnapshot>(adminPage, lifecyclePath)
  expect(initial.state).toBe('draft')
  await expect(adminPage.getByTestId('lifecycle-banner').getByText(STATE_LABELS.draft, { exact: true })).toBeVisible({
    timeout: 15_000,
  })

  let prevVersion = initial.state_version
  for (const step of transitions) {
    // Resolve the button label for THIS transition from server truth so the
    // click targets exactly the action the workflow offers (and the right
    // branch when a state exposes more than one — e.g. `sent` offers both
    // ACCEPT and DECLINE).
    const before = await fetchWorkflowSnapshot<LifecycleSnapshot>(adminPage, lifecyclePath)
    const action = before.next_events.find((ev) => ev.type === step.event)
    expect(action, `next_events should offer ${step.event} from ${before.state}`).toBeTruthy()

    // CLICK the LifecycleBanner action button — drives the onClick→dispatch
    // through the useProjectLifecycle XState machine, NOT a direct API POST.
    const banner = adminPage.getByTestId('lifecycle-banner')
    await banner.getByRole('button', { name: action!.label, exact: true }).click()

    // The banner refetches on its own after the mutation; assert the Pill flips
    // to the new state's label.
    //
    // Generous timeout: under the full e2e suite the bootstrap payload for this
    // fixture project grows with the audit/notification rows every prior
    // transition emits, so the final (archived) cross-check can take >5s — the
    // default would flake on the last step only.
    await expect(banner.getByText(STATE_LABELS[step.expected], { exact: true })).toBeVisible({ timeout: 15_000 })

    // Server-truth cross-check: advanced to the expected state with a bumped
    // version — proof the click drove a real reducer transition.
    const after = await fetchWorkflowSnapshot<LifecycleSnapshot>(adminPage, lifecyclePath)
    expect(after.state).toBe(step.expected)
    expect(after.state_version).toBe(prevVersion + 1)
    prevVersion = after.state_version
  }
})
