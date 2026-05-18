import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Cross-tab guard on replayOfflineQueue.
 *
 * The audit flagged a multi-tab replay race: two tabs of the same
 * origin share the IndexedDB-backed offline queue. Before the fix,
 * each tab's `replayInFlight` was an in-memory flag — both tabs could
 * heartbeat at the same instant, both list the same rows, and both
 * POST them before the other deleted them. Result: duplicate
 * server-side mutations.
 *
 * Fix: gate `replayOfflineQueue()` on the Web Locks API. When tab A
 * holds the lock, tab B's `navigator.locks.request(..., { ifAvailable: true })`
 * callback receives `null` and we no-op instead of running a second
 * replay. This test stubs `navigator.locks` to make the contention
 * deterministic.
 */
describe('replayOfflineQueue — Web Locks cross-tab guard', () => {
  let originalLocks: unknown
  beforeEach(() => {
    originalLocks = (navigator as unknown as { locks?: unknown }).locks
  })
  afterEach(() => {
    if (originalLocks === undefined) {
      delete (navigator as unknown as { locks?: unknown }).locks
    } else {
      ;(navigator as unknown as { locks?: unknown }).locks = originalLocks
    }
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('no-ops when the lock is already held by another caller (simulated other tab)', async () => {
    // Stub navigator.locks so the first request acquires the lock and
    // never releases it (long-running tab-A replay), and the second
    // request's `ifAvailable: true` callback fires with lock=null.
    let lockHeld = false
    ;(navigator as unknown as { locks: unknown }).locks = {
      request: async (_name: string, opts: { ifAvailable?: boolean }, cb: (lock: unknown) => Promise<unknown>) => {
        if (opts.ifAvailable && lockHeld) {
          return cb(null)
        }
        lockHeld = true
        try {
          return await cb({ name: _name })
        } finally {
          // Intentionally don't release in this test — second call must
          // see ifAvailable=true → null.
        }
      },
    }

    // Mock the IDB-touching helpers so jsdom doesn't actually need IDB.
    vi.doMock('./queue', () => ({
      listOfflineMutations: vi.fn(async () => []),
      removeOfflineMutation: vi.fn(async () => undefined),
      updateOfflineMutation: vi.fn(async () => undefined),
    }))

    const { replayOfflineQueue } = await import('./replay')
    // First call acquires the lock and runs a (zero-row) replay.
    const first = await replayOfflineQueue()
    expect(first.replayed).toBe(0)
    // Second call must short-circuit because the lock is "still held"
    // (simulated other tab). Result is the zero-effect sentinel.
    const second = await replayOfflineQueue()
    expect(second).toEqual({ replayed: 0, dropped: 0, deferred: 0 })
  })

  it('drains the queue when the lock is available (single-tab happy path)', async () => {
    // Lock is freely available; cb runs with a truthy lock object.
    ;(navigator as unknown as { locks: unknown }).locks = {
      request: async (_name: string, _opts: unknown, cb: (lock: unknown) => Promise<unknown>) => {
        return cb({ name: _name })
      },
    }
    const listMock = vi.fn(async () => [
      {
        id: 'mut-1',
        kind: 'notification_pref_save' as const,
        enqueued_at: Date.now(),
        payload: { input: { enabled: true } },
        attempt_count: 0,
      },
    ])
    const removeMock = vi.fn(async () => undefined)
    const updateMock = vi.fn(async () => undefined)
    vi.doMock('./queue', () => ({
      listOfflineMutations: listMock,
      removeOfflineMutation: removeMock,
      updateOfflineMutation: updateMock,
    }))
    // Stub the live request so dispatchHandler's POST resolves OK.
    vi.doMock('@/lib/api/client', async () => {
      const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client')
      return {
        ...actual,
        request: vi.fn(async () => ({ ok: true })),
      }
    })
    const { replayOfflineQueue } = await import('./replay')
    const result = await replayOfflineQueue()
    expect(result.replayed).toBe(1)
    expect(removeMock).toHaveBeenCalledWith('mut-1')
  })
})
