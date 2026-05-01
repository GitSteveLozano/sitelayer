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

let replayInFlight = false
let intervalId: ReturnType<typeof setInterval> | null = null

/**
 * Idempotent — safe to call from multiple places. Bails out fast if
 * a replay is already running.
 */
export async function replayOfflineQueue(): Promise<{ replayed: number; dropped: number; deferred: number }> {
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
      if (row.attempt_count >= 5) {
        const backoffMs = Math.min(60 * 60_000, 60_000 * Math.pow(2, row.attempt_count - 5))
        if (Date.now() - row.enqueued_at < backoffMs) {
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
            extra: { error: err.message_for_user(), payload: row.payload },
          })
          continue
        }
        // Transient — defer.
        deferred++
        await updateOfflineMutation({
          ...row,
          attempt_count: row.attempt_count + 1,
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
    case 'daily_log_patch': {
      const id = String(row.payload.id ?? '')
      const input = (row.payload.input ?? {}) as Record<string, unknown>
      await request(`/api/daily-logs/${encodeURIComponent(id)}`, { method: 'PATCH', json: input })
      return
    }
    case 'daily_log_submit': {
      const id = String(row.payload.id ?? '')
      const input = (row.payload.input ?? {}) as Record<string, unknown>
      await request(`/api/daily-logs/${encodeURIComponent(id)}/submit`, { method: 'POST', json: input })
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
