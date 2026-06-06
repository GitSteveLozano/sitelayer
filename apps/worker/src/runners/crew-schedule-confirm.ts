import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { captureWithEntityContext } from '../instrument.js'
import { processCrewScheduleConfirm } from '../crew-schedule-confirm-processor.js'

export interface CrewScheduleConfirmRunner {
  drain(companyId: string): Promise<Awaited<ReturnType<typeof processCrewScheduleConfirm>>>
}

/**
 * Worker runner that drains the crew_schedule declared side effects
 * (materialize_labor_entries + notify_foreman_decline). Mirrors the
 * field-events runner shape — the caller owns the pool; the processor
 * manages its own per-row transactions so a failure on one row can't
 * strand earlier rows' work.
 */
export function createCrewScheduleConfirmRunner(deps: { pool: Pool; logger: Logger }): CrewScheduleConfirmRunner {
  const { pool, logger } = deps

  async function drain(companyId: string) {
    const client = await pool.connect()
    try {
      const summary = await processCrewScheduleConfirm(client, companyId)
      if (summary.materialized > 0 || summary.notified > 0 || summary.failed > 0) {
        logger.info({ company_id: companyId, ...summary }, '[worker] crew-schedule confirm drain')
      }
      return summary
    } catch (err) {
      logger.error({ err }, '[worker] crew-schedule confirm drain failed')
      captureWithEntityContext(err, {
        scope: 'crew_schedule_confirm',
        entity_type: 'crew_schedule',
        company_id: companyId,
        workflow_name: 'crew_schedule',
      })
      return { processed: 0, materialized: 0, notified: 0, skipped: 0, failed: 0 }
    } finally {
      client.release()
    }
  }

  return { drain }
}
