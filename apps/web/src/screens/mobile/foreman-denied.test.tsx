import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ContextHandoffEvent, ContextWorkItem, WorkRequestDetailResponse } from '../../lib/api/work-requests.js'

/**
 * Owner-denied feedback screen (design msg__42, audit gap M06 #17). The screen
 * was previously a no-op surface with hardcoded demo fallbacks; these tests pin
 * the rebuilt contract:
 *   (a) it renders the REAL work item + the owner's REAL denial note (the
 *       `wont_do` status-change event's message) — and an honest "no reason"
 *       line instead of a fabricated quote when the note is absent;
 *   (b) both actions dispatch real handoff events — RESUBMIT →
 *       `resolution.reopened`, REPLY → `message.added`;
 *   (c) a non-denied item never renders a stale denial composition.
 */

const detailMock = vi.fn<() => { data: WorkRequestDetailResponse | undefined; isPending: boolean; error: unknown }>()
const mutateMock = vi.fn()

vi.mock('@/lib/api/work-requests', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return {
    ...actual,
    useWorkRequest: () => detailMock(),
    useAppendWorkRequestEvent: () => ({ mutate: mutateMock, isPending: false, error: null }),
  }
})

import { ForemanDeniedScreen } from './foreman-denied'

afterEach(() => {
  cleanup()
  detailMock.mockReset()
  mutateMock.mockReset()
})

const WORK_ITEM_ID = '00000000-0000-4000-8000-000000000042'

function workItem(overrides: Partial<ContextWorkItem> = {}): ContextWorkItem {
  return {
    id: WORK_ITEM_ID,
    support_packet_id: 'sp-1',
    title: '$510 EPS order',
    summary: '14 sheets for the east elevation',
    status: 'wont_do',
    lane: 'done',
    severity: 'high',
    route: null,
    entity_type: null,
    entity_id: null,
    assignee_user_id: null,
    created_by_user_id: 'user_foreman',
    created_at: '2026-06-10T12:00:00.000Z',
    updated_at: '2026-06-12T13:14:00.000Z',
    resolved_at: null,
    reversed_at: null,
    reversibility_window_seconds: 86400,
    expires_at: null,
    metadata: {},
    ...overrides,
  }
}

function denialEvent(message: string | null): ContextHandoffEvent {
  return {
    id: 'ev-2',
    company_id: 'co-1',
    work_item_id: WORK_ITEM_ID,
    event_type: 'work_item.status_changed',
    actor_kind: 'user',
    actor_user_id: 'user_owner',
    actor_ref: null,
    source_system: 'sitelayer',
    payload: { status: 'wont_do', lane: 'done', message },
    metadata: {},
    idempotency_key: null,
    causation_event_id: null,
    correlation_id: null,
    request_id: null,
    sentry_trace: null,
    sentry_baggage: null,
    build_sha: null,
    redaction_version: 'context-handoff-v1',
    occurred_at: '2026-06-12T13:14:00.000Z',
    recorded_at: '2026-06-12T13:14:00.000Z',
  }
}

function detail(item: ContextWorkItem, events: ContextHandoffEvent[]): WorkRequestDetailResponse {
  return {
    work_item: item,
    support_packet: null,
    dispatch_outbox: null,
    work_request_brief: {} as WorkRequestDetailResponse['work_request_brief'],
    events,
    events_pagination: { limit: 200, offset: 0, total: events.length, has_more: false },
  }
}

function renderScreen() {
  return render(
    <MemoryRouter initialEntries={[`/foreman/denied/${WORK_ITEM_ID}`]}>
      <Routes>
        <Route path="/foreman/denied/:id" element={<ForemanDeniedScreen />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('ForemanDeniedScreen', () => {
  it('renders the real denied item with the owner reason and resubmits via resolution.reopened', () => {
    detailMock.mockReturnValue({
      data: detail(workItem(), [denialEvent('Aspen is already over budget. Pull what you can from yard.')]),
      isPending: false,
      error: null,
    })
    renderScreen()

    expect(screen.getByText(/● DENIED/)).toBeTruthy()
    expect(screen.getByText('$510 EPS order')).toBeTruthy()
    expect(screen.getByText('Aspen is already over budget. Pull what you can from yard.')).toBeTruthy()
    // Owner note exists → the design's SUGGESTED ALTERNATIVES framing.
    expect(screen.getByText('Suggested alternatives')).toBeTruthy()

    fireEvent.click(screen.getByText('Resubmit with changes'))
    fireEvent.change(screen.getByPlaceholderText(/What changed/), {
      target: { value: 'GC confirmed the drop in writing.' },
    })
    fireEvent.click(screen.getByText('Send back for review'))

    expect(mutateMock).toHaveBeenCalledTimes(1)
    expect(mutateMock.mock.calls[0]![0]).toEqual({
      id: WORK_ITEM_ID,
      input: { event_type: 'resolution.reopened', message: 'GC confirmed the drop in writing.' },
    })
  })

  it('replies to the owner via message.added', () => {
    detailMock.mockReturnValue({
      data: detail(workItem(), [denialEvent('Hold until Friday.')]),
      isPending: false,
      error: null,
    })
    renderScreen()

    fireEvent.click(screen.getByText('Reply to owner'))
    fireEvent.change(screen.getByPlaceholderText(/Your reply lands/), {
      target: { value: 'Understood — will pull 4 sheets from the yard.' },
    })
    fireEvent.click(screen.getByText('Send reply'))

    expect(mutateMock).toHaveBeenCalledTimes(1)
    expect(mutateMock.mock.calls[0]![0]).toEqual({
      id: WORK_ITEM_ID,
      input: { event_type: 'message.added', message: 'Understood — will pull 4 sheets from the yard.' },
    })
  })

  it('is honest when the owner left no reason — no fabricated quote, no alternatives claim', () => {
    detailMock.mockReturnValue({
      data: detail(workItem(), [denialEvent(null)]),
      isPending: false,
      error: null,
    })
    renderScreen()

    expect(screen.getByText('NO REASON WAS LEFT WITH THIS DENIAL.')).toBeTruthy()
    expect(screen.queryByText('Suggested alternatives')).toBeNull()
    expect(screen.getByText('Next steps')).toBeTruthy()
  })

  it('renders the back-in-review state instead of a stale denial once reopened', () => {
    detailMock.mockReturnValue({
      data: detail(workItem({ status: 'reopened', lane: 'triage' }), [denialEvent('Over budget.')]),
      isPending: false,
      error: null,
    })
    renderScreen()

    expect(screen.getByText('Back in review')).toBeTruthy()
    expect(screen.queryByText(/● DENIED/)).toBeNull()
  })
})
