import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { QboSyncRunSnapshot, QboSyncRunState } from '@/lib/api'

/**
 * The QBO connection screen now renders the qbo_sync_run workflow
 * snapshot (state + next_events) returned by
 * GET /api/integrations/qbo/sync-runs/:id instead of reconstructing the
 * run state from the connection's cached `status` flag. These tests mock
 * the `@/lib/api` hooks the screen consumes and assert:
 *   - a `failed` snapshot surfaces the reducer's RETRY next_event as a
 *     button, and clicking it dispatches RETRY with the snapshot's
 *     state_version (the optimistic-concurrency guard);
 *   - a `succeeded` snapshot shows no Retry button;
 *   - the status pill reflects the snapshot state, not a derived guess.
 */

const useQboConnectionMock = vi.fn()
const useTriggerQboSyncMock = vi.fn()
const useQboSyncRunMock = vi.fn()
const useQboSyncRunsMock = vi.fn()
const useQboSyncStatusMock = vi.fn()
const useQboSyncOutboxMock = vi.fn()
const dispatchMutateMock = vi.fn()
const useDispatchQboSyncRunEventMock = vi.fn()

vi.mock('@/lib/api', () => ({
  countFailedOutbox: () => 0,
  fetchQboAuthUrl: vi.fn(),
  useActiveCompanyId: () => 'co-1',
  useCompanySettings: () => ({ data: undefined, isPending: true }),
  usePatchCompanySettings: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useServiceItems: () => ({ data: { serviceItems: [] }, isPending: true }),
  useDispatchQboSyncRunEvent: (id: string) => useDispatchQboSyncRunEventMock(id),
  useQboConnection: () => useQboConnectionMock(),
  useQboSyncOutbox: () => useQboSyncOutboxMock(),
  useQboSyncRun: (id: string | null) => useQboSyncRunMock(id),
  useQboSyncRuns: () => useQboSyncRunsMock(),
  useQboSyncStatus: () => useQboSyncStatusMock(),
  useTriggerQboSync: () => useTriggerQboSyncMock(),
}))

vi.mock('@/lib/api/client', () => ({
  ApiError: class ApiError extends Error {},
}))

import { QboConnectionScreen } from './qbo-connection'

function snapshot(state: QboSyncRunState, overrides: Partial<QboSyncRunSnapshot> = {}): QboSyncRunSnapshot {
  const nextEvents =
    state === 'failed'
      ? [{ type: 'RETRY' as const, label: 'Retry sync' }]
      : state === 'pending' || state === 'retrying'
        ? [{ type: 'START_SYNC' as const, label: 'Start sync' }]
        : []
  return {
    state,
    state_version: 4,
    next_events: nextEvents,
    context: {
      id: 'run-1',
      company_id: 'co-1',
      integration_connection_id: 'conn-1',
      status: state,
      state_version: 4,
      started_at: '2026-05-31T00:00:00Z',
      succeeded_at: state === 'succeeded' ? '2026-05-31T00:01:00Z' : null,
      failed_at: state === 'failed' ? '2026-05-31T00:01:00Z' : null,
      retried_at: null,
      error: state === 'failed' ? 'QBO refused the push' : null,
      snapshot: null,
      triggered_by: 'demo-user',
      created_at: '2026-05-31T00:00:00Z',
    },
    ...overrides,
  }
}

function primeCommonMocks() {
  useQboConnectionMock.mockReturnValue({
    isPending: false,
    data: { connection: { status: 'error', version: 2, provider_account_id: 'realm-1' } },
  })
  useTriggerQboSyncMock.mockReturnValue({ mutateAsync: vi.fn(), isPending: false })
  useQboSyncStatusMock.mockReturnValue({
    data: { pendingOutboxCount: 0, pendingSyncEventCount: 0 },
    isPending: false,
    refetch: vi.fn(),
  })
  useQboSyncOutboxMock.mockReturnValue({ data: { outbox: [] }, isPending: false, refetch: vi.fn() })
  useQboSyncRunsMock.mockReturnValue({ data: { syncRuns: [] }, isPending: false })
  useDispatchQboSyncRunEventMock.mockReturnValue({
    mutate: dispatchMutateMock,
    isPending: false,
    error: null,
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function wrap(node: ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>)
}

describe('QboConnectionScreen sync-run snapshot', () => {
  it('renders a Retry button for a failed run and dispatches RETRY with the snapshot state_version', () => {
    primeCommonMocks()
    const failed = snapshot('failed')
    // The list seeds the run id on mount so RETRY survives a reload.
    useQboSyncRunsMock.mockReturnValue({ data: { syncRuns: [failed] }, isPending: false })
    useQboSyncRunMock.mockReturnValue({ data: failed, isFetching: false })

    wrap(<QboConnectionScreen />)

    // The reducer's failure detail comes straight from the snapshot context.
    expect(screen.getByText('QBO refused the push')).toBeTruthy()

    const retry = screen.getByRole('button', { name: 'Retry sync' })
    fireEvent.click(retry)

    expect(dispatchMutateMock).toHaveBeenCalledWith({ event: 'RETRY', state_version: 4 })
  })

  it('shows no Retry button for a succeeded run', () => {
    primeCommonMocks()
    useQboConnectionMock.mockReturnValue({
      isPending: false,
      data: { connection: { status: 'connected', version: 3, provider_account_id: 'realm-1' } },
    })
    useQboSyncRunMock.mockReturnValue({ data: snapshot('succeeded'), isFetching: false })

    wrap(<QboConnectionScreen />)

    expect(screen.getByText('Succeeded')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry sync' })).toBeNull()
  })

  it('shows the idle state before any run has been observed', () => {
    primeCommonMocks()
    useQboConnectionMock.mockReturnValue({
      isPending: false,
      data: { connection: { status: 'connected', version: 1, provider_account_id: null } },
    })
    useQboSyncRunMock.mockReturnValue({ data: undefined, isFetching: false })

    wrap(<QboConnectionScreen />)

    expect(screen.getByText('Idle')).toBeTruthy()
  })
})
