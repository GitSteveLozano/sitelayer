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

/**
 * Build the PER-COMPANY circuit-breaker key for a QBO push.
 *
 * The breaker used to key on the bare integration name `'qbo'`, which made it
 * GLOBAL: a single tenant's revoked-token failures (or any tripping error from
 * one company's pushes) would open the breaker for EVERY company and halt the
 * entire QBO drain. Keying per company (`qbo:<companyId>`) isolates the blast
 * radius — company A's outage no longer starves company B's invoices.
 *
 * Pure + deterministic so the breaker key, the persisted `circuit_state` row,
 * and any metrics label all agree for a given company.
 */
export function qboCircuitKey(companyId: string): string {
  return `qbo:${companyId}`
}

// QBO circuit breaker. Three consecutive 5xx (or network) failures on a
// company's QBO push open THAT COMPANY's circuit for QBO_CIRCUIT_COOLDOWN_MS
// (default 5 min); while open, push wrappers throw CircuitOpenError
// immediately and the worker defers the row's next_attempt_at instead of
// incrementing attempt_count. One success closes the circuit. Auth 401s are
// NOT tripping (see isTrippingError in @sitelayer/queue) — a bad/revoked
// token is that tenant's problem, not an Intuit outage, so it must not halt
// the drain.
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

  // Seed a baseline `qbo` row at boot so the gauge is non-absent even before
  // any company's breaker ever trips. The live breaker now keys PER COMPANY
  // (qbo:<companyId>) — those rows are written lazily by onOpen/onClose the
  // first time a company's circuit changes state. Wrapped in try/catch —
  // migration 074 may not yet be applied on older deployments and we
  // shouldn't block startup.
  void (async () => {
    await persistCircuitState(pool, logger, 'qbo', 'closed', { failureCount: 0, lastError: null })
  })()

  return { qboCircuit, qboCircuitThreshold, qboCircuitCooldownMs }
}
