import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ProjectLifecycleState } from '@/lib/api/project-lifecycle'
import { ProjectStatePanel } from './overview-tab'

/**
 * Gap 1 + Gap 2 guard: ProjectStatePanel's contextual CTA keys off the
 * project_lifecycle workflow state (the typed 8-value union), NOT the
 * legacy `status` regex. This proves:
 *   - all 8 reducer states render distinct copy (the recovered
 *     `estimating` and `declined` no longer collapse into `draft`);
 *   - the panel takes a `state` prop, so a project with status:'lead'
 *     and lifecycle_state:'accepted' renders the "Accepted" CTA.
 */

afterEach(cleanup)

const EXPECTED_EYEBROW: Record<ProjectLifecycleState, string> = {
  draft: 'Drafting',
  estimating: 'Estimating',
  sent: 'Awaiting client',
  accepted: 'Accepted',
  declined: 'Bid lost',
  in_progress: 'In progress',
  done: 'Closing',
  archived: 'Archived',
}

describe('ProjectStatePanel', () => {
  it.each(Object.keys(EXPECTED_EYEBROW) as ProjectLifecycleState[])(
    'state %s renders its own distinct eyebrow copy',
    (state) => {
      render(<ProjectStatePanel state={state} projectId="p1" navigate={vi.fn()} />)
      expect(screen.getByText(EXPECTED_EYEBROW[state])).toBeTruthy()
    },
  )

  it('recovers estimating and declined as distinct from draft (the old bucket-collapse regression)', () => {
    render(<ProjectStatePanel state="estimating" projectId="p1" navigate={vi.fn()} />)
    expect(screen.getByText('Estimating')).toBeTruthy()
    expect(screen.queryByText('Drafting')).toBeNull()
    cleanup()
    render(<ProjectStatePanel state="declined" projectId="p1" navigate={vi.fn()} />)
    expect(screen.getByText('Bid lost')).toBeTruthy()
    expect(screen.queryByText('Drafting')).toBeNull()
  })

  it('renders the Accepted CTA from lifecycle state (status is irrelevant)', () => {
    // A project the legacy column would call a "lead" but whose pipeline
    // state is `accepted` — the panel must follow lifecycle_state.
    const navigate = vi.fn()
    render(<ProjectStatePanel state="accepted" projectId="p1" navigate={navigate} />)
    expect(screen.getByText('Accepted')).toBeTruthy()
    fireEvent.click(screen.getByText('Schedule'))
    expect(navigate).toHaveBeenCalledWith('/schedule')
  })
})
