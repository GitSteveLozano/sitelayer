import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ProjectLifecycleState } from '@/lib/api/project-lifecycle'
import { LifecycleStepper, lifecycleStepIndex } from './stepper'

/**
 * Gap 3 guard: the DRAFT·SENT·ACCEPTED·PROGRESS·PAID stepper is a pure
 * derivation of the lifecycle state. Each of the 8 reducer states maps to
 * a deterministic highlighted step (or the off-track red "Lost" terminal
 * for `declined`).
 */

afterEach(cleanup)

const EXPECTED_INDEX: Record<ProjectLifecycleState, number> = {
  draft: 0,
  estimating: 0, // sub-phase of the DRAFT column
  sent: 1,
  accepted: 2,
  in_progress: 3,
  done: 4,
  archived: 4,
  declined: -1, // off-track / lost
}

describe('LifecycleStepper', () => {
  it.each(Object.keys(EXPECTED_INDEX) as ProjectLifecycleState[])(
    'state %s highlights the expected step index',
    (state) => {
      expect(lifecycleStepIndex(state)).toBe(EXPECTED_INDEX[state])
    },
  )

  it('renders the current step highlighted for in_progress (PROGRESS)', () => {
    render(<LifecycleStepper state="in_progress" />)
    const current = document.querySelector('[data-current="true"]')
    expect(current?.getAttribute('data-step')).toBe('PROGRESS')
  })

  it('renders the off-track Lost terminal for declined', () => {
    render(<LifecycleStepper state="declined" />)
    expect(screen.getByTestId('lifecycle-stepper-lost')).toBeTruthy()
    // No step is marked current in the lost state.
    expect(document.querySelector('[data-current="true"]')).toBeNull()
  })
})
