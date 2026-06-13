// Offline mutation replay engine.
//
// On `online` event (and a 15s heartbeat as backstop in case the event
// missed) we drain the queue from oldest to newest. Each mutation
// dispatches to its kind-specific handler. Outcomes:
//   - 2xx: remove from queue
//   - 4xx (client): drop with logged error — bad input won't get fixed
//                    by retry. Surface via Sentry breadcrumb.
//   - 5xx / NetworkError: keep the row, bump attempt_count + last_error
//                         so the next cycle retries. Backed by exponential
//                         backoff via attempt_count gate.
//
// The handlers re-use the same `request()` function the live mutation
// hooks use — auth headers + token provider all run as normal.

import { Sentry } from '@/instrument'
import { ApiError, NetworkError, request } from '@/lib/api/client'
import {
  listOfflineMutations,
  removeOfflineMutation,
  updateOfflineMutation,
  type OfflineMutation,
  type OfflineMutationKind,
} from './queue'
import { uploadDailyLogPhoto } from '@/lib/api/daily-logs'
import { uploadClockEventPhoto } from '@/lib/api/clock'
import {
  createCaptureSession,
  finalizeCaptureSession,
  uploadCaptureArtifact,
  type CaptureArtifactUploadInput,
  type CaptureSessionCreateInput,
  type CaptureFinalizeInput,
} from '@/lib/api/capture-sessions'
import {
  finalizePortalEstimateCaptureSession,
  finalizePortalRentalCaptureSession,
  startPortalEstimateCaptureSession,
  startPortalRentalCaptureSession,
  uploadPortalEstimateCaptureArtifact,
  uploadPortalRentalCaptureArtifact,
} from '@/portal/api'

let replayInFlight = false
let intervalId: ReturnType<typeof setInterval> | null = null

/** Cross-tab lock name. All tabs share IndexedDB, so without a
 * cross-tab guard two tabs both heartbeat at the same instant, both
 * `listOfflineMutations()` returns the same rows, and each tab POSTs
 * the same mutation before the other deletes it. The Web Locks API
 * serializes the replay across tabs of the same origin.
 *
 * Available in every browser that ships Service Workers (Chrome 69+,
 * Firefox 96+, Safari 15.4+). The fallback path runs the local
 * `replayInFlight` guard only — that's still correct for single-tab
 * usage and degrades gracefully on the long tail of older browsers.
 */
const OFFLINE_REPLAY_LOCK = 'sitelayer:offline-replay'

/**
 * Idempotent — safe to call from multiple places. Bails out fast if
 * a replay is already running locally OR in another tab (Web Locks).
 */
export async function replayOfflineQueue(): Promise<{ replayed: number; dropped: number; deferred: number }> {
  // Cross-tab guard: only one tab at a time owns the replay lock. If
  // another tab is already replaying, `ifAvailable` returns null and
  // we no-op rather than waiting (the other tab's heartbeat or our
  // next heartbeat will pick up any leftover rows).
  if (typeof navigator !== 'undefined' && navigator.locks) {
    const result = await navigator.locks.request(
      OFFLINE_REPLAY_LOCK,
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (!lock) return null
        return runReplay()
      },
    )
    return result ?? { replayed: 0, dropped: 0, deferred: 0 }
  }
  // Web Locks unavailable — fall back to the local in-tab guard. Same
  // behavior as before this fix for single-tab usage; multi-tab races
  // are only possible on browsers without navigator.locks (pre-2020).
  return runReplay()
}

async function runReplay(): Promise<{ replayed: number; dropped: number; deferred: number }> {
  if (replayInFlight) return { replayed: 0, dropped: 0, deferred: 0 }
  replayInFlight = true
  let replayed = 0
  let dropped = 0
  let deferred = 0
  try {
    const rows = await listOfflineMutations()
    for (const row of rows) {
      // Backoff: rows with 5+ attempts wait 60s × 2^(attempt-5) before
      // the next try. Caps at 1h; keeps a stuck row from hammering.
      // Measured from last_attempt_at — measuring from enqueued_at would
      // let any row that's been sitting in the queue longer than the
      // backoff window slip through every heartbeat (15s).
      if (row.attempt_count >= 5) {
        const backoffMs = Math.min(60 * 60_000, 60_000 * Math.pow(2, row.attempt_count - 5))
        const since = row.last_attempt_at ?? row.enqueued_at
        if (Date.now() - since < backoffMs) {
          deferred++
          continue
        }
      }
      try {
        await dispatchHandler(row)
        await removeOfflineMutation(row.id)
        replayed++
      } catch (err) {
        if (
          err instanceof ApiError &&
          err.status >= 400 &&
          err.status < 500 &&
          err.status !== 408 &&
          err.status !== 429
        ) {
          // Permanent — bad input; drop and log.
          await removeOfflineMutation(row.id)
          dropped++
          Sentry.captureMessage(`offline replay dropped: ${row.kind}`, {
            level: 'warning',
            tags: { offline_kind: row.kind, status: String(err.status) },
            // Send only safe metadata — the raw payload can contain
            // free-text notes / customer PII and there's no beforeSend
            // scrubber on the web SDK, so report the shape (keys + id),
            // never the values.
            extra: {
              error: err.message_for_user(),
              id: row.id,
              payloadKeys: row.payload && typeof row.payload === 'object' ? Object.keys(row.payload) : undefined,
            },
          })
          continue
        }
        // Transient — defer.
        deferred++
        await updateOfflineMutation({
          ...row,
          attempt_count: row.attempt_count + 1,
          last_attempt_at: Date.now(),
          last_error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        })
      }
    }
  } finally {
    replayInFlight = false
  }
  return { replayed, dropped, deferred }
}

/**
 * Wire the replay engine into window events. Call once at app startup.
 * Returns a cleanup function (mostly for tests).
 */
export function startOfflineReplayLoop(opts: { heartbeatMs?: number } = {}): () => void {
  const heartbeat = opts.heartbeatMs ?? 15_000
  const onOnline = () => {
    void replayOfflineQueue()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
    // Kick once at startup in case the queue has rows from a prior session.
    void replayOfflineQueue()
  }
  intervalId = setInterval(() => {
    if (typeof navigator === 'undefined' || navigator.onLine) {
      void replayOfflineQueue()
    }
  }, heartbeat)
  return () => {
    if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
    if (intervalId !== null) clearInterval(intervalId)
    intervalId = null
  }
}

// ---------------------------------------------------------------------------
// Kind-specific handlers. Add a new branch when wiring a new mutation
// into the queue.
// ---------------------------------------------------------------------------

async function dispatchHandler(row: OfflineMutation): Promise<void> {
  switch (row.kind) {
    case 'clock_in':
      await request('/api/clock/in', { method: 'POST', json: row.payload })
      return
    case 'clock_out':
      await request('/api/clock/out', { method: 'POST', json: row.payload })
      return
    case 'clock_void': {
      const id = String(row.payload.id ?? '')
      const reason = (row.payload.reason ?? null) as string | null
      await request(`/api/clock/events/${encodeURIComponent(id)}/void`, {
        method: 'POST',
        json: { reason },
      })
      return
    }
    case 'clock_event_photo_upload': {
      const id = String(row.payload.id ?? '')
      const file = row.payload.file
      if (!(file instanceof File) && !(file instanceof Blob)) {
        throw new ApiError({
          status: 400,
          path: `/api/clock/events/${id}/photo`,
          method: 'POST',
          requestId: null,
          body: { error: 'queued clock-event photo blob lost on serialization' },
        })
      }
      const asFile =
        file instanceof File
          ? file
          : new File([file], typeof row.payload.fileName === 'string' ? row.payload.fileName : 'clock-photo.jpg')
      await uploadClockEventPhoto(id, asFile)
      return
    }
    case 'daily_log_create': {
      const input = (row.payload.input ?? {}) as Record<string, unknown>
      await request('/api/daily-logs', { method: 'POST', json: input })
      return
    }
    case 'daily_log_patch': {
      const id = String(row.payload.id ?? '')
      const input = (row.payload.input ?? {}) as Record<string, unknown>
      await request(`/api/daily-logs/${encodeURIComponent(id)}`, { method: 'PATCH', json: input })
      return
    }
    case 'daily_log_submit': {
      const id = String(row.payload.id ?? '')
      const input = (row.payload.input ?? {}) as Record<string, unknown>
      // New machine-driven submits enqueue the canonical { event, state_version }
      // body → replay through the /events route. Already-enqueued legacy payloads
      // carry { expected_version } (or nothing) → replay through the deprecated
      // /submit alias so mutations queued before this change still land.
      if ('state_version' in input || input.event === 'SUBMIT') {
        const stateVersion = Number(input.state_version)
        await request(`/api/daily-logs/${encodeURIComponent(id)}/events`, {
          method: 'POST',
          json: { event: 'SUBMIT', state_version: stateVersion },
        })
      } else {
        await request(`/api/daily-logs/${encodeURIComponent(id)}/submit`, { method: 'POST', json: input })
      }
      return
    }
    case 'daily_log_photo_upload': {
      const id = String(row.payload.id ?? '')
      const file = row.payload.file
      if (!(file instanceof File) && !(file instanceof Blob)) {
        throw new ApiError({
          status: 400,
          path: `/api/daily-logs/${id}/photos`,
          method: 'POST',
          requestId: null,
          body: { error: 'queued photo blob lost on serialization' },
        })
      }
      const asFile =
        file instanceof File
          ? file
          : new File([file], typeof row.payload.fileName === 'string' ? row.payload.fileName : 'photo.jpg')
      await uploadDailyLogPhoto(id, asFile)
      return
    }
    case 'daily_log_photo_delete': {
      const id = String(row.payload.id ?? '')
      const key = String(row.payload.key ?? '')
      await request(`/api/daily-logs/${encodeURIComponent(id)}/photos`, { method: 'DELETE', json: { key } })
      return
    }
    case 'takeoff_measurement_create': {
      const projectId = String(row.payload.projectId ?? '')
      const input = (row.payload.input ?? {}) as Record<string, unknown>
      await request(`/api/projects/${encodeURIComponent(projectId)}/takeoff/measurement`, {
        method: 'POST',
        json: input,
      })
      return
    }
    case 'time_review_event': {
      const id = String(row.payload.id ?? '')
      const input = (row.payload.input ?? {}) as Record<string, unknown>
      await request(`/api/time-review-runs/${encodeURIComponent(id)}/events`, { method: 'POST', json: input })
      return
    }
    case 'notification_pref_save': {
      const input = (row.payload.input ?? {}) as Record<string, unknown>
      await request('/api/notification-preferences', { method: 'PUT', json: input })
      return
    }
    case 'capture_session_start':
      await replayCaptureSessionStart(row)
      return
    case 'capture_artifact_upload':
      await replayCaptureArtifactUpload(row)
      return
    case 'capture_session_finalize':
      await replayCaptureSessionFinalize(row)
      return
    default: {
      // Exhaustiveness guard — unknown kinds are dropped after one
      // attempt so a stale queue from an old client doesn't accumulate.
      const exhaustive: never = row.kind as never
      throw new ApiError({
        status: 410,
        path: '(unknown)',
        method: '(unknown)',
        requestId: null,
        body: { error: `unknown offline kind: ${String(exhaustive)}` },
      })
    }
  }
}

type OfflineCaptureTarget =
  | { type: 'authenticated' }
  | { type: 'portal'; portal_surface: 'estimate_portal' | 'rental_portal'; share_token: string }

function parseCaptureTarget(value: unknown): OfflineCaptureTarget {
  if (!value || typeof value !== 'object') return { type: 'authenticated' }
  const target = value as Record<string, unknown>
  if (target.type === 'portal') {
    const portalSurface = target.portal_surface
    const shareToken = typeof target.share_token === 'string' ? target.share_token : ''
    if ((portalSurface === 'estimate_portal' || portalSurface === 'rental_portal') && shareToken.trim()) {
      return { type: 'portal', portal_surface: portalSurface, share_token: shareToken }
    }
  }
  return { type: 'authenticated' }
}

function captureUploadInputFromPayload(payload: Record<string, unknown>): CaptureArtifactUploadInput {
  const file = payload.file
  const isFile = typeof File !== 'undefined' && file instanceof File
  const isBlob = typeof Blob !== 'undefined' && file instanceof Blob
  if (!isFile && !isBlob) {
    throw new ApiError({
      status: 400,
      path: '/api/capture-sessions/:id/artifacts/upload',
      method: 'POST',
      requestId: null,
      body: { error: 'queued capture artifact blob lost on serialization' },
    })
  }
  const input: CaptureArtifactUploadInput = {
    kind: String(payload.kind ?? ''),
    file,
  }
  if (typeof payload.fileName === 'string') input.fileName = payload.fileName
  if (typeof payload.client_upload_id === 'string') input.client_upload_id = payload.client_upload_id
  if (typeof payload.duration_ms === 'number') input.duration_ms = payload.duration_ms
  if (isCapturePiiLevel(payload.pii_level)) input.pii_level = payload.pii_level
  if (isCaptureAccessPolicy(payload.access_policy)) input.access_policy = payload.access_policy
  if (isRecord(payload.metadata)) input.metadata = payload.metadata
  return input
}

async function replayCaptureSessionStart(row: OfflineMutation): Promise<void> {
  const input = (isRecord(row.payload.input) ? row.payload.input : {}) as CaptureSessionCreateInput
  const target = parseCaptureTarget(row.payload.target)
  if (target.type === 'portal') {
    if (target.portal_surface === 'estimate_portal') {
      await startPortalEstimateCaptureSession(target.share_token, input)
    } else {
      await startPortalRentalCaptureSession(target.share_token, input)
    }
    return
  }
  await createCaptureSession(input)
}

async function replayCaptureArtifactUpload(row: OfflineMutation): Promise<void> {
  const captureSessionId = String(row.payload.captureSessionId ?? '')
  const input = captureUploadInputFromPayload(row.payload)
  const target = parseCaptureTarget(row.payload.target)
  if (target.type === 'portal') {
    if (target.portal_surface === 'estimate_portal') {
      await uploadPortalEstimateCaptureArtifact(target.share_token, captureSessionId, input)
    } else {
      await uploadPortalRentalCaptureArtifact(target.share_token, captureSessionId, input)
    }
    return
  }
  await uploadCaptureArtifact(captureSessionId, input)
}

async function replayCaptureSessionFinalize(row: OfflineMutation): Promise<void> {
  const captureSessionId = String(row.payload.captureSessionId ?? '')
  const input = (isRecord(row.payload.input) ? row.payload.input : {}) as CaptureFinalizeInput
  const target = parseCaptureTarget(row.payload.target)
  if (target.type === 'portal') {
    if (target.portal_surface === 'estimate_portal') {
      await finalizePortalEstimateCaptureSession(target.share_token, captureSessionId, input)
    } else {
      await finalizePortalRentalCaptureSession(target.share_token, captureSessionId, input)
    }
    return
  }
  await finalizeCaptureSession(captureSessionId, input)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isCapturePiiLevel(value: unknown): value is NonNullable<CaptureArtifactUploadInput['pii_level']> {
  return value === 'low' || value === 'internal' || value === 'private' || value === 'restricted'
}

function isCaptureAccessPolicy(value: unknown): value is NonNullable<CaptureArtifactUploadInput['access_policy']> {
  return value === 'support_only' || value === 'operator_only' || value === 'tenant_visible'
}

/**
 * Helper used by mutation hooks: try the live request first; on
 * NetworkError, enqueue with the supplied kind + payload and resolve
 * (don't surface the error). Returns true if the call was queued for
 * later replay, false if the call ran live.
 */
export async function runOrEnqueue(
  liveCall: () => Promise<unknown>,
  kind: OfflineMutationKind,
  payload: Record<string, unknown>,
): Promise<boolean> {
  try {
    await liveCall()
    return false
  } catch (err) {
    if (err instanceof NetworkError) {
      const { enqueueOfflineMutation } = await import('./queue')
      await enqueueOfflineMutation(kind, payload)
      return true
    }
    throw err
  }
}
