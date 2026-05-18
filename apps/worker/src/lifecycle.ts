import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { Sentry, captureWithEntityContext } from './instrument.js'
import { observeWorkerTickInterval } from './metrics.js'

export interface LifecycleDeps {
  pool: Pool
  logger: Logger
  pollIntervalMs: number
  /**
   * Upper bound for the adaptive backoff. After a sequence of empty ticks the
   * scheduler doubles `currentIntervalMs` until it reaches this cap. Defaults
   * to `WORKER_POLL_MAX_INTERVAL_MS` (60_000ms) when omitted.
   */
  maxPollIntervalMs?: number
  heartbeat: () => Promise<{ idle: boolean }>
}

export interface LifecycleHandle {
  runHeartbeat(): Promise<{ idle: boolean } | undefined>
  scheduleNextHeartbeat(idle: boolean): void
  installSignalHandlers(): void
}

/**
 * Pure backoff math for the worker tick scheduler. Exported so the math
 * can be unit-tested without the heartbeat/timer/pool plumbing.
 *
 * - When `foundWork` is true, reset to `base` so the worker reacts fast to
 *   a fresh outbox row.
 * - When `foundWork` is false, double `current` up to `max`.
 *
 * Inputs are clamped: `base`/`max` are coerced to at least 1ms, `current`
 * is treated as `base` when it falls below `base` (e.g. after a misconfigured
 * env value).
 */
export function nextInterval(current: number, base: number, max: number, foundWork: boolean): number {
  const safeBase = Math.max(1, Math.floor(base))
  const safeMax = Math.max(safeBase, Math.floor(max))
  if (foundWork) return safeBase
  const safeCurrent = Math.max(safeBase, Math.floor(current))
  const doubled = safeCurrent * 2
  return Math.min(doubled, safeMax)
}

export function createLifecycle(deps: LifecycleDeps): LifecycleHandle {
  const { pool, logger, pollIntervalMs, heartbeat } = deps

  let shutdownStarted = false
  let heartbeatInFlight: Promise<{ idle: boolean } | undefined> | null = null
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

  // Adaptive exponential backoff. `currentIntervalMs` starts at the base
  // `pollIntervalMs`. After every empty tick (no runner reported work) it
  // doubles up to `maxPollIntervalMs`. The first tick that finds work
  // resets it back to `pollIntervalMs`, so the worker reacts fast to a
  // fresh outbox row but does not waste cycles polling an empty queue.
  const maxPollIntervalMs = (() => {
    if (typeof deps.maxPollIntervalMs === 'number' && deps.maxPollIntervalMs > 0) {
      return Math.max(pollIntervalMs, Math.floor(deps.maxPollIntervalMs))
    }
    const raw = process.env.WORKER_POLL_MAX_INTERVAL_MS
    const fallback = 60_000
    if (!raw) return Math.max(pollIntervalMs, fallback)
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return Math.max(pollIntervalMs, fallback)
    return Math.max(pollIntervalMs, Math.floor(n))
  })()

  let currentIntervalMs = pollIntervalMs

  // Publish the static base/max once so dashboards can graph backoff
  // ratio (current / max). `current` will be updated whenever it changes.
  observeWorkerTickInterval('base', pollIntervalMs)
  observeWorkerTickInterval('max', maxPollIntervalMs)
  observeWorkerTickInterval('current', currentIntervalMs)

  async function runHeartbeat(): Promise<{ idle: boolean } | undefined> {
    if (shutdownStarted) return undefined
    if (heartbeatInFlight) {
      logger.warn('[worker] previous heartbeat still running; skipping overlap')
      return undefined
    }

    heartbeatInFlight = heartbeat()
      .catch((error) => {
        logger.error({ err: error }, '[worker] heartbeat failed')
        captureWithEntityContext(error, { scope: 'worker_heartbeat' })
        return undefined
      })
      .finally(() => {
        heartbeatInFlight = null
      })

    return await heartbeatInFlight
  }

  function scheduleNextHeartbeat(idle: boolean): void {
    if (shutdownStarted) return
    const foundWork = !idle
    const previous = currentIntervalMs
    currentIntervalMs = nextInterval(previous, pollIntervalMs, maxPollIntervalMs, foundWork)

    if (currentIntervalMs !== previous) {
      observeWorkerTickInterval('current', currentIntervalMs)
      if (foundWork) {
        logger.info(
          { interval_ms: currentIntervalMs, previous_ms: previous },
          '[worker] tick interval reset to base — work found',
        )
      } else {
        logger.debug(
          {
            interval_ms: currentIntervalMs,
            previous_ms: previous,
            max_interval_ms: maxPollIntervalMs,
          },
          '[worker] tick interval backed off — idle',
        )
      }
    }

    heartbeatTimer = setTimeout(() => {
      void runHeartbeat()
        .then((result) => {
          const nextIdle = result?.idle ?? true
          scheduleNextHeartbeat(nextIdle)
        })
        .catch(() => {
          // runHeartbeat already logs/captures on failure; treat as idle so we
          // back off a bit before the next attempt.
          scheduleNextHeartbeat(true)
        })
    }, currentIntervalMs)
  }

  async function shutdown(signal: NodeJS.Signals) {
    if (shutdownStarted) return
    shutdownStarted = true
    logger.info({ signal }, '[worker] shutting down')
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer)
    }

    const forceExit = setTimeout(
      () => {
        logger.error({ signal }, '[worker] shutdown timed out')
        process.exit(1)
      },
      Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000),
    )
    forceExit.unref()

    try {
      if (heartbeatInFlight) {
        await heartbeatInFlight
      }
      await pool.end()
      await Sentry.flush(2_000)
      clearTimeout(forceExit)
      logger.info({ signal }, '[worker] shutdown complete')
      process.exit(0)
    } catch (error) {
      clearTimeout(forceExit)
      logger.error({ err: error, signal }, '[worker] shutdown failed')
      captureWithEntityContext(error, { scope: 'worker_shutdown' })
      process.exit(1)
    }
  }

  function installSignalHandlers(): void {
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM')
    })
    process.on('SIGINT', () => {
      void shutdown('SIGINT')
    })
  }

  return { runHeartbeat, scheduleNextHeartbeat, installSignalHandlers }
}
