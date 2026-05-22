import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WorkRequestReversibilityBadge,
  reversibilityBadgeState,
} from './status'
import type { ContextWorkItem } from '@/lib/api'

afterEach(() => {
  cleanup()
})

function makeItem(overrides: Partial<Pick<ContextWorkItem, 'expires_at' | 'reversed_at'>>) {
  return {
    expires_at: null,
    reversed_at: null,
    ...overrides,
  }
}

describe('reversibilityBadgeState', () => {
  const now = Date.parse('2026-05-22T12:00:00.000Z')

  it('returns active state with HH:MM UTC label when the window is open and > 1h remains', () => {
    const state = reversibilityBadgeState(makeItem({ expires_at: '2026-05-22T18:30:00.000Z' }), now)
    expect(state?.mode).toBe('active')
    expect(state?.label).toBe('Recall until 18:30 UTC')
    expect(state?.tone).toBe('blue')
  })

  it('returns closing state with a countdown in the last hour', () => {
    const state = reversibilityBadgeState(makeItem({ expires_at: '2026-05-22T12:45:00.000Z' }), now)
    expect(state?.mode).toBe('closing')
    expect(state?.label).toMatch(/^Recall closes in \d+ min$/)
    expect(state?.tone).toBe('red')
  })

  it('returns closed state with a red tone once expires_at has passed', () => {
    const state = reversibilityBadgeState(makeItem({ expires_at: '2026-05-22T11:00:00.000Z' }), now)
    expect(state?.mode).toBe('closed')
    expect(state?.label).toBe('Recall window closed')
    expect(state?.tone).toBe('red')
  })

  it('returns reversed state when reversed_at is set, regardless of expires_at', () => {
    const state = reversibilityBadgeState(
      makeItem({ expires_at: '2026-05-22T18:00:00.000Z', reversed_at: '2026-05-22T11:45:00.000Z' }),
      now,
    )
    expect(state?.mode).toBe('reversed')
    expect(state?.label).toBe('Reversed at 11:45 UTC')
    expect(state?.tone).toBe('red')
  })

  it('returns null when expires_at and reversed_at are both unset', () => {
    expect(reversibilityBadgeState(makeItem({}), now)).toBeNull()
  })
})

describe('WorkRequestReversibilityBadge', () => {
  it('renders the active label inside an MPill', () => {
    render(
      <WorkRequestReversibilityBadge
        workItem={{ expires_at: '2026-05-22T18:30:00.000Z', reversed_at: null }}
        now={Date.parse('2026-05-22T12:00:00.000Z')}
      />,
    )
    expect(screen.getByText('Recall until 18:30 UTC')).toBeTruthy()
  })

  it('renders the reversed label when reversed_at is set', () => {
    render(
      <WorkRequestReversibilityBadge
        workItem={{ expires_at: '2026-05-22T18:00:00.000Z', reversed_at: '2026-05-22T11:45:00.000Z' }}
        now={Date.parse('2026-05-22T12:00:00.000Z')}
      />,
    )
    expect(screen.getByText('Reversed at 11:45 UTC')).toBeTruthy()
  })

  it('renders nothing when neither expires_at nor reversed_at is set', () => {
    const { container } = render(
      <WorkRequestReversibilityBadge workItem={{ expires_at: null, reversed_at: null }} />,
    )
    expect(container.firstChild).toBeNull()
  })
})
