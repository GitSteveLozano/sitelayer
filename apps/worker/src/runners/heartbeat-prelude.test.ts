import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import type { CircuitBreaker } from '@sitelayer/queue'
import { createHeartbeatPrelude } from './heartbeat-prelude.js'

class FakePool {
  calls: Array<{ sql: string; params: unknown[] }> = []

  async query(sql: string, params: unknown[] = []) {
    this.calls.push({ sql, params })
    return { rows: [], rowCount: 0 }
  }
}

const logger = {
  warn: () => undefined,
} as unknown as Logger

function circuit(open: boolean): CircuitBreaker {
  return {
    isOpen: () => open,
  } as unknown as CircuitBreaker
}

describe('heartbeat-prelude', () => {
  it('defers all QBO outbox mutation types while the QBO circuit is open', async () => {
    const pool = new FakePool()
    const prelude = createHeartbeatPrelude({
      pool: pool as unknown as Pool,
      logger,
      qboCircuit: circuit(true),
      mutationMaxRetries: 10,
      qboCircuitCooldownMs: 60_000,
    })

    await prelude.deferQboOutboxIfCircuitOpen('company-1')

    expect(pool.calls).toHaveLength(1)
    const sql = pool.calls[0]!.sql
    expect(sql).toContain('post_qbo_invoice')
    expect(sql).toContain('post_qbo_estimate')
    expect(sql).toContain('post_qbo_time_activities')
    expect(sql).not.toContain('post_qbo_time_activity')
  })

  it('does not touch mutation_outbox while the QBO circuit is closed', async () => {
    const pool = new FakePool()
    const prelude = createHeartbeatPrelude({
      pool: pool as unknown as Pool,
      logger,
      qboCircuit: circuit(false),
      mutationMaxRetries: 10,
      qboCircuitCooldownMs: 60_000,
    })

    await prelude.deferQboOutboxIfCircuitOpen('company-1')

    expect(pool.calls).toEqual([])
  })
})
