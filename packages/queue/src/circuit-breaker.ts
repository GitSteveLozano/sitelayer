/**
 * In-memory circuit breaker for outbound integrations.
 *
 * Pattern: count consecutive failures per integration key. When the count
 * crosses `threshold`, the circuit "opens" and `isOpen()` returns true for
 * `cooldownMs`. While open, the worker should defer outbox rows targeting
 * that integration (push `next_attempt_at` forward) instead of hammering
 * the upstream API. A single success resets the counter and closes the
 * circuit immediately ("eager half-open").
 *
 * Per-process state is fine here: the worker is a single process and the
 * goal is to stop *this* worker from making thousands of failing calls.
 * If the worker scales out, each replica gets its own breaker — that's
 * actually desirable (one bad replica doesn't poison the others). For
 * cross-process coordination, push the open state into Postgres later.
 *
 * Inspired by the audit recommendation in #2: 3 consecutive 5xx from QBO
 * halts the drain for 5 minutes, alerts via Sentry.
 */

export type CircuitBreakerConfig = {
  /** Consecutive failures to trip. Default 3. */
  threshold: number
  /** Milliseconds the circuit stays open after tripping. Default 5min. */
  cooldownMs: number
  /** Called once when the circuit opens. Hook for Sentry alerts. */
  onOpen?: (key: string, info: { failureCount: number; lastError: string }) => void
  /** Called once when the circuit closes (success after open). */
  onClose?: (key: string) => void
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  threshold: 3,
  cooldownMs: 5 * 60_000,
}

type BreakerState = {
  failureCount: number
  /** ms epoch when the circuit opened. null while closed. */
  openedAt: number | null
  lastError: string | null
}

export class CircuitBreaker {
  private state = new Map<string, BreakerState>()

  constructor(
    private config: CircuitBreakerConfig = DEFAULT_CIRCUIT_BREAKER_CONFIG,
    private clock: () => number = Date.now,
  ) {}

  private getState(key: string): BreakerState {
    let s = this.state.get(key)
    if (!s) {
      s = { failureCount: 0, openedAt: null, lastError: null }
      this.state.set(key, s)
    }
    return s
  }

  /** Returns true if the breaker for `key` is open right now. */
  isOpen(key: string): boolean {
    const s = this.getState(key)
    if (s.openedAt === null) return false
    if (this.clock() - s.openedAt >= this.config.cooldownMs) {
      // Cooldown elapsed — half-open. Reset to closed so the next call gets
      // through; if it fails, the failure count starts fresh.
      s.openedAt = null
      s.failureCount = 0
      return false
    }
    return true
  }

  recordSuccess(key: string): void {
    const s = this.getState(key)
    const wasOpen = s.openedAt !== null
    s.failureCount = 0
    s.openedAt = null
    s.lastError = null
    if (wasOpen) this.config.onClose?.(key)
  }

  recordFailure(key: string, error: string): void {
    const s = this.getState(key)
    s.failureCount += 1
    s.lastError = error.slice(0, 500)
    if (s.openedAt === null && s.failureCount >= this.config.threshold) {
      s.openedAt = this.clock()
      this.config.onOpen?.(key, { failureCount: s.failureCount, lastError: s.lastError })
    }
  }

  /** Diagnostic — used by tests and `/api/metrics` exposure. */
  snapshot(key: string): { open: boolean; failureCount: number; lastError: string | null } {
    const s = this.getState(key)
    return { open: this.isOpen(key), failureCount: s.failureCount, lastError: s.lastError }
  }

  /** Force-close everything. Test/debug only. */
  reset(): void {
    this.state.clear()
  }
}

/**
 * Marker error thrown when `withCircuitBreaker` short-circuits because
 * the breaker is open. Workers should catch this and defer the row's
 * next_attempt_at instead of incrementing attempt_count, so a hot
 * upstream outage doesn't burn through MUTATION_MAX_RETRIES.
 */
export class CircuitOpenError extends Error {
  constructor(readonly key: string) {
    super(`circuit open for ${key}`)
    this.name = 'CircuitOpenError'
  }
}

/**
 * Wrap an async upstream call with breaker semantics. Throws
 * CircuitOpenError without calling `fn` if the circuit is open. On
 * call: success closes the circuit, tripping errors increment the
 * failure count, non-tripping errors propagate without affecting state.
 */
export async function withCircuitBreaker<T>(breaker: CircuitBreaker, key: string, fn: () => Promise<T>): Promise<T> {
  if (breaker.isOpen(key)) {
    throw new CircuitOpenError(key)
  }
  try {
    const result = await fn()
    breaker.recordSuccess(key)
    return result
  } catch (err) {
    if (isTrippingError(err)) {
      breaker.recordFailure(key, err instanceof Error ? err.message : String(err))
    }
    throw err
  }
}

/**
 * Lift an HTTP-ish status code into a circuit-tripping signal.
 *
 * 5xx and Network errors trip the breaker (genuine upstream/Intuit outage);
 * 4xx do NOT (bad input/auth shouldn't stop the drain — the row is dropped
 * via MUTATION_MAX_RETRIES instead).
 *
 * Auth errors are specifically NOT tripping: a 401/403 from QBO means THAT
 * tenant's token is bad/revoked, not that Intuit is down. With the per-company
 * breaker key, tripping on a 401 would still wrongly halt that company's drain
 * for the cooldown window when the right move is to surface the
 * reconnect/refresh failure and let the row retry/expire.
 *
 * Classification keys on the FIRST HTTP-status-looking token in the message
 * (our push errors are built as `... returned <status>: <body>`), so a 503
 * whose body echoes "404" still trips and a 401 whose body echoes "500" still
 * does NOT — the status, not an incidental number deeper in the body, decides.
 * Network-class messages have no status token and are matched separately.
 */
export function isTrippingError(err: unknown): boolean {
  if (err instanceof Error) {
    const message = err.message
    // The leading HTTP status (if any) is authoritative. 4xx (incl. auth
    // 401/403) never trips; 5xx trips.
    const statusMatch = /\b([45]\d\d)\b/.exec(message)
    if (statusMatch) {
      return statusMatch[1]!.startsWith('5')
    }
    // No status token — fall back to the network-class heuristic.
    if (/network|ECONN|ETIMEDOUT|ENOTFOUND|fetch failed/i.test(message)) return true
  }
  return false
}
