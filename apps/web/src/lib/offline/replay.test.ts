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

  it('replays authenticated capture artifact uploads from the offline queue', async () => {
    ;(navigator as unknown as { locks: unknown }).locks = {
      request: async (_name: string, _opts: unknown, cb: (lock: unknown) => Promise<unknown>) => {
        return cb({ name: _name })
      },
    }
    const blob = new Blob(['voice'], { type: 'audio/webm' })
    const row = {
      id: 'mut-capture-upload',
      kind: 'capture_artifact_upload' as const,
      enqueued_at: Date.now(),
      attempt_count: 0,
      payload: {
        target: { type: 'authenticated' },
        captureSessionId: '00000000-0000-4000-8000-000000000123',
        kind: 'audio',
        file: blob,
        fileName: 'audio.webm',
        client_upload_id: 'queued-audio-1',
        duration_ms: 1400,
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: { source: 'record_feedback' },
      },
    }
    const removeMock = vi.fn(async () => undefined)
    const uploadCaptureArtifact = vi.fn(async () => ({ artifact: { id: 'a1' } }))
    vi.doMock('./queue', () => ({
      listOfflineMutations: vi.fn(async () => [row]),
      removeOfflineMutation: removeMock,
      updateOfflineMutation: vi.fn(async () => undefined),
    }))
    vi.doMock('@/lib/api/capture-sessions', () => ({
      createCaptureSession: vi.fn(),
      finalizeCaptureSession: vi.fn(async () => ({ work_item: { id: 'w1' } })),
      uploadCaptureArtifact,
    }))
    vi.doMock('@/portal/api', () => ({
      finalizePortalEstimateCaptureSession: vi.fn(),
      finalizePortalRentalCaptureSession: vi.fn(),
      startPortalEstimateCaptureSession: vi.fn(),
      startPortalRentalCaptureSession: vi.fn(),
      uploadPortalEstimateCaptureArtifact: vi.fn(),
      uploadPortalRentalCaptureArtifact: vi.fn(),
    }))

    const { replayOfflineQueue } = await import('./replay')
    const result = await replayOfflineQueue()

    expect(result.replayed).toBe(1)
    expect(uploadCaptureArtifact).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000123',
      expect.objectContaining({
        kind: 'audio',
        file: blob,
        fileName: 'audio.webm',
        client_upload_id: 'queued-audio-1',
        duration_ms: 1400,
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: { source: 'record_feedback' },
      }),
    )
    expect(removeMock).toHaveBeenCalledWith('mut-capture-upload')
  })

  it('replays queued portal capture session starts before later artifacts', async () => {
    ;(navigator as unknown as { locks: unknown }).locks = {
      request: async (_name: string, _opts: unknown, cb: (lock: unknown) => Promise<unknown>) => {
        return cb({ name: _name })
      },
    }
    const row = {
      id: 'mut-capture-start',
      kind: 'capture_session_start' as const,
      enqueued_at: Date.now(),
      attempt_count: 0,
      payload: {
        target: { type: 'portal', portal_surface: 'estimate_portal', share_token: 'share-token' },
        input: {
          capture_session_id: '00000000-0000-4000-8000-000000000123',
          mode: 'feedback',
          consent_version: 'portal-feedback-v1',
          route_path: '/portal/estimate',
        },
      },
    }
    const removeMock = vi.fn(async () => undefined)
    const startPortalEstimateCaptureSession = vi.fn(async () => ({ capture_session: { id: 'session-1' } }))
    vi.doMock('./queue', () => ({
      listOfflineMutations: vi.fn(async () => [row]),
      removeOfflineMutation: removeMock,
      updateOfflineMutation: vi.fn(async () => undefined),
    }))
    vi.doMock('@/lib/api/capture-sessions', () => ({
      createCaptureSession: vi.fn(),
      finalizeCaptureSession: vi.fn(),
      uploadCaptureArtifact: vi.fn(),
    }))
    vi.doMock('@/portal/api', () => ({
      finalizePortalEstimateCaptureSession: vi.fn(),
      finalizePortalRentalCaptureSession: vi.fn(),
      startPortalEstimateCaptureSession,
      startPortalRentalCaptureSession: vi.fn(),
      uploadPortalEstimateCaptureArtifact: vi.fn(),
      uploadPortalRentalCaptureArtifact: vi.fn(),
    }))

    const { replayOfflineQueue } = await import('./replay')
    const result = await replayOfflineQueue()

    expect(result.replayed).toBe(1)
    expect(startPortalEstimateCaptureSession).toHaveBeenCalledWith('share-token', {
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      mode: 'feedback',
      consent_version: 'portal-feedback-v1',
      route_path: '/portal/estimate',
    })
    expect(removeMock).toHaveBeenCalledWith('mut-capture-start')
  })

  it('replays portal capture finalization using the queued target', async () => {
    ;(navigator as unknown as { locks: unknown }).locks = {
      request: async (_name: string, _opts: unknown, cb: (lock: unknown) => Promise<unknown>) => {
        return cb({ name: _name })
      },
    }
    const row = {
      id: 'mut-capture-finalize',
      kind: 'capture_session_finalize' as const,
      enqueued_at: Date.now(),
      attempt_count: 0,
      payload: {
        target: { type: 'portal', portal_surface: 'rental_portal', share_token: 'rental-token' },
        captureSessionId: '00000000-0000-4000-8000-000000000123',
        input: { category: 'record_feedback', title: 'Queued feedback', offline_replay: true },
      },
    }
    const removeMock = vi.fn(async () => undefined)
    const finalizePortalRentalCaptureSession = vi.fn(async () => ({ work_item: { id: 'w1' } }))
    vi.doMock('./queue', () => ({
      listOfflineMutations: vi.fn(async () => [row]),
      removeOfflineMutation: removeMock,
      updateOfflineMutation: vi.fn(async () => undefined),
    }))
    vi.doMock('@/lib/api/capture-sessions', () => ({
      createCaptureSession: vi.fn(),
      finalizeCaptureSession: vi.fn(),
      uploadCaptureArtifact: vi.fn(),
    }))
    vi.doMock('@/portal/api', () => ({
      finalizePortalEstimateCaptureSession: vi.fn(),
      finalizePortalRentalCaptureSession,
      startPortalEstimateCaptureSession: vi.fn(),
      startPortalRentalCaptureSession: vi.fn(),
      uploadPortalEstimateCaptureArtifact: vi.fn(),
      uploadPortalRentalCaptureArtifact: vi.fn(),
    }))

    const { replayOfflineQueue } = await import('./replay')
    const result = await replayOfflineQueue()

    expect(result.replayed).toBe(1)
    expect(finalizePortalRentalCaptureSession).toHaveBeenCalledWith(
      'rental-token',
      '00000000-0000-4000-8000-000000000123',
      {
        category: 'record_feedback',
        title: 'Queued feedback',
        offline_replay: true,
      },
    )
    expect(removeMock).toHaveBeenCalledWith('mut-capture-finalize')
  })
})
