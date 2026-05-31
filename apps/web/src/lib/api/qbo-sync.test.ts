import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock the single HTTP client so we can assert the path + body the
// sync-run snapshot calls send, without standing up a server.
const requestMock = vi.hoisted(() => vi.fn())
vi.mock('./client', () => ({ request: requestMock }))

import { countFailedOutbox, dispatchQboSyncRunEvent, fetchQboSyncRun, isQboSyncRunInFlight } from './qbo-sync'

afterEach(() => {
  requestMock.mockReset()
})

describe('isQboSyncRunInFlight', () => {
  it('treats pending/syncing/retrying as in-flight and rest states as done', () => {
    expect(isQboSyncRunInFlight('pending')).toBe(true)
    expect(isQboSyncRunInFlight('syncing')).toBe(true)
    expect(isQboSyncRunInFlight('retrying')).toBe(true)
    expect(isQboSyncRunInFlight('succeeded')).toBe(false)
    expect(isQboSyncRunInFlight('failed')).toBe(false)
    expect(isQboSyncRunInFlight(undefined)).toBe(false)
  })
})

describe('fetchQboSyncRun', () => {
  it('GETs the company-scoped snapshot route', async () => {
    requestMock.mockResolvedValue({ state: 'failed' })
    await fetchQboSyncRun('run 1/x')
    expect(requestMock).toHaveBeenCalledWith('/api/integrations/qbo/sync-runs/run%201%2Fx')
  })
})

describe('dispatchQboSyncRunEvent', () => {
  it('POSTs the human event with the optimistic state_version', async () => {
    requestMock.mockResolvedValue({ state: 'retrying' })
    await dispatchQboSyncRunEvent('run-1', 'RETRY', 4)
    expect(requestMock).toHaveBeenCalledWith('/api/integrations/qbo/sync-runs/run-1/events', {
      method: 'POST',
      json: { event: 'RETRY', state_version: 4 },
    })
  })
})

describe('countFailedOutbox', () => {
  it('counts only failed rows', () => {
    expect(
      countFailedOutbox({
        outbox: [{ status: 'failed' }, { status: 'applied' }, { status: 'failed' }] as never,
      }),
    ).toBe(2)
    expect(countFailedOutbox(undefined)).toBe(0)
  })
})
