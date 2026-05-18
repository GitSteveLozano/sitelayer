import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { OfflineBanner } from './OfflineBanner'

// IndexedDB isn't wired in jsdom; mock the queue subscriber so the
// banner can mount with a stable pending count. We only test the
// online/offline copy + the cached-data wording — the pending-count
// path is exercised end-to-end in queue.test.ts.
vi.mock('@/lib/offline/queue', () => ({
  offlineMutationCount: vi.fn().mockResolvedValue(0),
  subscribeOfflineMutations: vi.fn().mockReturnValue(() => {}),
}))

vi.mock('@/lib/offline/replay', () => ({
  replayOfflineQueue: vi.fn().mockResolvedValue({ replayed: 0, dropped: 0, deferred: 0 }),
}))

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })
  window.dispatchEvent(new Event(value ? 'online' : 'offline'))
}

beforeEach(() => {
  setOnline(true)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setOnline(true)
})

describe('OfflineBanner', () => {
  test('renders nothing when online and the queue is empty', () => {
    const { container } = render(<OfflineBanner />)
    // The component fires off a microtask to refresh the pending count;
    // even after settling there is no banner when online + 0 pending.
    expect(container.querySelector('[data-testid="offline-banner"]')).toBeNull()
  })

  test('shows the "showing cached data" copy within 500ms of going offline', async () => {
    render(<OfflineBanner />)
    act(() => {
      setOnline(false)
    })
    // useOnlineStatus updates synchronously on the offline event, so the
    // banner shows up on the same render cycle. The 500ms cap referenced
    // in the spec is the upper bound for user-perceived latency — in
    // practice the event handler is synchronous.
    await waitFor(
      () => {
        const banner = screen.getByTestId('offline-banner')
        expect(banner.getAttribute('data-online')).toBe('false')
        expect(banner.textContent ?? '').toMatch(/Offline — showing cached data/i)
      },
      { timeout: 500 },
    )
  })

  test('disappears when the browser reconnects', async () => {
    render(<OfflineBanner />)
    act(() => {
      setOnline(false)
    })
    await waitFor(() => expect(screen.getByTestId('offline-banner')).toBeTruthy())
    act(() => {
      setOnline(true)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('offline-banner')).toBeNull()
    })
  })
})
