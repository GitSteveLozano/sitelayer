import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { captureWithEntityContext } from '../instrument.js'
import { processFieldEventNotifications } from '../field-event-notifier.js'
import { processFieldEventAutoEscalation, DEFAULT_AUTO_ESCALATE_CONFIG } from '../field-event-escalation.js'

export interface FieldEventsRunner {
  drainNotifications(companyId: string): Promise<Awaited<ReturnType<typeof processFieldEventNotifications>>>
  runAutoEscalation(companyId: string): Promise<void>
}

export function createFieldEventsRunner(deps: { pool: Pool; logger: Logger }): FieldEventsRunner {
  const { pool, logger } = deps

  async function drainFieldEventNotifications(companyId: string) {
    // Drains notify_worker_resolution + notify_estimator_escalation outbox
    // rows emitted by worker_issues PATCH (RESOLVE/ESCALATE workflow events).
    // Inserts notifications rows; push-channel delivery is a follow-up.
    const client = await pool.connect()
    try {
      return await processFieldEventNotifications(client, companyId)
    } finally {
      client.release()
    }
  }

  // Durable-timer pattern — auto-escalate worker_issues stuck open at
  // severity='stopped' beyond the configured threshold. Each heartbeat
  // claims a small batch with FOR UPDATE SKIP LOCKED so it's safe under
  // multiple worker replicas. The reducer's ESCALATE event is the same
  // path a foreman would trigger; only the actor id differs.
  async function runAutoEscalation(companyId: string): Promise<void> {
    const client = await pool.connect()
    try {
      await client.query('begin')
      const summary = await processFieldEventAutoEscalation(client, companyId, {
        ...DEFAULT_AUTO_ESCALATE_CONFIG,
        ageMinutes: Number(process.env.FIELD_EVENT_AUTO_ESCALATE_AGE_MIN ?? DEFAULT_AUTO_ESCALATE_CONFIG.ageMinutes),
      })
      await client.query('commit')
      if (summary.escalated > 0 || summary.failed > 0) {
        logger.info({ company_id: companyId, ...summary }, '[worker] field-event auto-escalation tick')
      }
    } catch (err) {
      await client.query('rollback').catch(() => undefined)
      logger.error({ err }, '[worker] field-event auto-escalation failed')
      captureWithEntityContext(err, {
        scope: 'field_event_auto_escalation',
        entity_type: 'field_event',
        company_id: companyId,
        workflow_name: 'field_event',
      })
    } finally {
      client.release()
    }
  }

  return {
    drainNotifications: drainFieldEventNotifications,
    runAutoEscalation,
  }
}
