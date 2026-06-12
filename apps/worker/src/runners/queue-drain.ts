import type { Pool } from 'pg'
import { processQueueWithClient } from '@sitelayer/queue'
import { spanForAppliedRow } from '../trace.js'
import { setCompanyGuc } from '../runner-utils.js'

export function createQueueDrainRunner(deps: { pool: Pool }) {
  const { pool } = deps

  return async function processQueue(companyId: string, limit = 25) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      await setCompanyGuc(client, companyId)
      const result = await processQueueWithClient(client, companyId, limit)
      await client.query('commit')
      for (const row of result.outbox) {
        spanForAppliedRow({ ...row, kind: 'outbox' })
      }
      for (const row of result.syncEvents) {
        spanForAppliedRow({ ...row, kind: 'sync_event' })
      }
      return {
        processedOutbox: result.processedOutboxCount,
        processedSyncEvents: result.processedSyncEventCount,
        // Rows parked as 'failed' because no handler (generic allowlist OR
        // dedicated runner) claims their mutation_type. Surfaced so the
        // worker heartbeat can log these loudly — they are contract bugs,
        // never normal operation.
        quarantinedOutbox: result.quarantinedOutboxCount,
        quarantinedRows: result.quarantinedOutbox,
      }
    } catch (error) {
      await client.query('rollback')
      throw error
    } finally {
      client.release()
    }
  }
}
