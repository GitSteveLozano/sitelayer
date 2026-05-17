import type { Pool } from 'pg'
import { processLockLaborEntries, type LockLaborEntriesSummary } from '@sitelayer/queue'

export function createLockLaborRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function drainLockLaborEntries(companyId: string): Promise<LockLaborEntriesSummary> {
    // The lock_labor_entries handler manages its own per-row transactions
    // internally so a stuck row can't strand earlier work. We just hand it
    // a connection. See packages/queue/src/lock-labor-entries.ts.
    const client = await pool.connect()
    try {
      return await processLockLaborEntries(client, companyId, 25)
    } finally {
      client.release()
    }
  }
}
