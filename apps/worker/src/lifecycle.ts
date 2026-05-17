import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { Sentry, captureWithEntityContext } from './instrument.js'

export interface LifecycleDeps {
  pool: Pool
  logger: Logger
  pollIntervalMs: number
  heartbeat: () => Promise<{ idle: boolean }>
}

export interface LifecycleHandle {
  runHeartbeat(): Promise<{ idle: boolean } | undefined>
  scheduleNextHeartbeat(idle: boolean): void
  installSignalHandlers(): void
}

export function createLifecycle(deps: LifecycleDeps): LifecycleHandle {
  const { pool, logger, pollIntervalMs, heartbeat } = deps

  let shutdownStarted = false
  let heartbeatInFlight: Promise<{ idle: boolean } | undefined> | null = null
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

  // Adaptive backoff: when a heartbeat finds no work, stretch the next tick to
  // `idlePollIntervalMs` (default 3x active). The first non-idle tick resets to
  // the active cadence. Saves CPU on busy hosts where the worker is mostly
  // waiting around.
  const idlePollIntervalMs = (() => {
    const raw = process.env.WORKER_IDLE_POLL_INTERVAL_MS
    const fallback = pollIntervalMs * 3
    if (!raw) return fallback
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
  })()

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
    const delay = idle ? idlePollIntervalMs : pollIntervalMs
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
    }, delay)
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
