import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import type {
  FieldEventHookValue,
  FieldEventSnapshotResponse,
  FieldEventState,
} from '../../machines/field-event.js'

/**
 * Gap-1 coverage for the foreman blocker detail: the screen is a thin renderer
 * of the field_event snapshot, and the action affordances are driven off the
 * server-computed `next_events` — so DISMISS / REOPEN (which the reducer +
 * route already support) become reachable, and the UI can never offer an event
 * the server would 409 on. We mock `useFieldEvent` to pin each business state
 * and assert (a) the right buttons render per state and (b) clicking
 * Dismiss/Reopen dispatches the bare workflow event.
 */

const apiGetMock = vi.fn<(path: string, slug?: string) => Promise<unknown>>()
vi.mock('@/lib/api', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, apiGet: (path: string, slug?: string) => apiGetMock(path, slug) }
})

const dispatchMock = vi.fn()
let hookValue: FieldEventHookValue

vi.mock('../../machines/field-event.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useFieldEvent: () => hookValue }
})

import { ForemanBlockerDetail } from './foreman-blocker-detail'

afterEach(() => {
  cleanup()
  apiGetMock.mockReset()
  dispatchMock.mockReset()
})

function snapshot(state: FieldEventState, nextEvents: Array<{ type: string; label: string }>): FieldEventSnapshotResponse {
  return {
    state,
    state_version: 3,
    context: {
      id: 'i1',
      company_id: 'c',
      project_id: 'p1',
      worker_id: 'w1',
      reporter_clerk_user_id: 'user_w1',
      kind: 'materials_out',
      message: 'Out of EPS sheets',
      severity: 'stopped',
      state_version: 3,
      resolved_at: null,
      resolved_by_clerk_user_id: null,
      resolved_action: null,
      resolution_message: null,
      escalated_to_estimator_at: null,
      escalation_reason: null,
      dismissed_at: null,
      dismissed_by_clerk_user_id: null,
      created_at: '2026-05-09T15:00:00.000Z',
    },
    next_events: nextEvents as FieldEventSnapshotResponse['next_events'],
  }
}

function makeHook(snap: FieldEventSnapshotResponse): FieldEventHookValue {
  return {
    snapshot: snap,
    error: null,
    outOfSync: false,
    isLoading: false,
    isSubmitting: false,
    refresh: vi.fn(),
    dispatch: dispatchMock,
    dismissError: vi.fn(),
  }
}

function bootstrap(): BootstrapResponse {
  return {
    company: { id: 'c', name: 'Acme', slug: 'acme' },
    template: { slug: 't', name: 'T', description: '' },
    workflowStages: [],
    divisions: [],
    serviceItems: [],
    customers: [],
    projects: [],
    workers: [],
    pricingProfiles: [],
    bonusRules: [],
    integrations: [],
    integrationMappings: [],
    laborEntries: [],
    materialBills: [],
    schedules: [],
  }
}

function wrap(node: ReactNode) {
  return render(
    <MemoryRouter initialEntries={['/foreman/blocker/i1']}>
      <Routes>
        <Route path="/foreman/blocker/:issueId" element={node} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ForemanBlockerDetail — next_events drives the affordances (Gap 1)', () => {
  it('open state offers Dismiss (and Escalate); clicking through dispatches DISMISS', () => {
    apiGetMock.mockResolvedValue({ attachments: [] })
    hookValue = makeHook(
      snapshot('open', [
        { type: 'RESOLVE', label: 'Resolve and reply to worker' },
        { type: 'ESCALATE', label: 'Escalate to estimator' },
        { type: 'DISMISS', label: 'Dismiss' },
      ]),
    )
    wrap(<ForemanBlockerDetail bootstrap={bootstrap()} companySlug="acme" />)
    expect(screen.getByText('Escalate to estimator')).toBeTruthy()
    // Enter the dismiss sub-mode, then confirm.
    fireEvent.click(screen.getByText('Dismiss'))
    fireEvent.click(screen.getByText('Dismiss event'))
    expect(dispatchMock).toHaveBeenCalledWith({ event: 'DISMISS' })
  })

  it('does NOT offer a Reopen affordance while open', () => {
    apiGetMock.mockResolvedValue({ attachments: [] })
    hookValue = makeHook(snapshot('open', [{ type: 'RESOLVE', label: 'r' }]))
    wrap(<ForemanBlockerDetail bootstrap={bootstrap()} companySlug="acme" />)
    expect(screen.queryByText('Reopen')).toBeNull()
  })

  it('dismissed state offers Reopen; clicking it dispatches REOPEN', () => {
    apiGetMock.mockResolvedValue({ attachments: [] })
    hookValue = makeHook(snapshot('dismissed', [{ type: 'REOPEN', label: 'Reopen' }]))
    wrap(<ForemanBlockerDetail bootstrap={bootstrap()} companySlug="acme" />)
    const reopen = screen.getByText('Reopen')
    fireEvent.click(reopen)
    expect(dispatchMock).toHaveBeenCalledWith({ event: 'REOPEN' })
  })

  it('escalated state shows the escalated strip + Reopen, not the resolve form', () => {
    apiGetMock.mockResolvedValue({ attachments: [] })
    const snap = snapshot('escalated', [{ type: 'REOPEN', label: 'Reopen' }])
    snap.context.escalation_reason = 'Need a change order'
    hookValue = makeHook(snap)
    wrap(<ForemanBlockerDetail bootstrap={bootstrap()} companySlug="acme" />)
    expect(screen.getByText(/ESCALATED TO ESTIMATOR/)).toBeTruthy()
    expect(screen.getByText('Reopen')).toBeTruthy()
    // The resolve picker must not render in a closed state.
    expect(screen.queryByText('Resolve · pick one')).toBeNull()
  })
})
