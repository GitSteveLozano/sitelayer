import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { CircuitBreaker } from '@sitelayer/queue'
import { captureMessageWithEntityContext } from './instrument.js'
import { persistCircuitState } from './runner-utils.js'

export interface QboCircuitBundle {
  qboCircuit: CircuitBreaker
  qboCircuitThreshold: number
  qboCircuitCooldownMs: number
}

// QBO circuit breaker. Three consecutive 5xx (or network) failures on any
// QBO push open the circuit for QBO_CIRCUIT_COOLDOWN_MS (default 5 min);
// while open, push wrappers throw CircuitOpenError immediately and the
// worker defers the row's next_attempt_at instead of incrementing
// attempt_count. One success closes the circuit.
export function createQboCircuit(deps: { pool: Pool; logger: Logger }): QboCircuitBundle {
  const { pool, logger } = deps
  const qboCircuitThreshold = Number(process.env.QBO_CIRCUIT_THRESHOLD ?? 3)
  const qboCircuitCooldownMs = Number(process.env.QBO_CIRCUIT_COOLDOWN_MS ?? 5 * 60_000)

  const qboCircuit = new CircuitBreaker({
    threshold: qboCircuitThreshold,
    cooldownMs: qboCircuitCooldownMs,
    onOpen: (key, info) => {
      logger.warn({ key, ...info }, '[circuit-breaker] open — halting QBO drain')
      captureMessageWithEntityContext(`circuit breaker open: ${key}`, {
        level: 'warning',
        scope: 'circuit_breaker',
        extra_tags: { integration: key },
        extra: { failureCount: info.failureCount, lastError: info.lastError },
      })
      void persistCircuitState(pool, logger, key, 'open', {
        failureCount: info.failureCount,
        lastError: info.lastError,
      })
    },
    onClose: (key) => {
      logger.info({ key }, '[circuit-breaker] closed — resuming drain')
      void persistCircuitState(pool, logger, key, 'closed', { failureCount: 0, lastError: null })
    },
  })

  // Seed the row at boot so the gauge is non-absent even before the
  // breaker ever trips. Wrapped in try/catch — migration 074 may not
  // yet be applied on older deployments and we shouldn't block startup.
  void (async () => {
    await persistCircuitState(pool, logger, 'qbo', 'closed', { failureCount: 0, lastError: null })
  })()

  return { qboCircuit, qboCircuitThreshold, qboCircuitCooldownMs }
}
