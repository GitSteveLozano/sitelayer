import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { Sentry } from '../instrument.js'

/**
 * Stuck-workflow alerting. A row in 'posting' state for too long means
 * either the worker crashed mid-push (recovery should have caught it,
 * but defense-in-depth) or QBO returned 200 without us recognizing it.
 * Either way the human needs to know.
 *
 * Threshold: WORKFLOW_STUCK_POSTING_MINUTES (default 30 min). Each
 * stuck row produces one Sentry event tagged with workflow + entity_id
 * so Sentry's fingerprinting groups recurring alerts on the same row
 * but separates distinct stuck rows. Cheap query (indexed on
 * (company_id, status)), runs each heartbeat.
 */
const WORKFLOW_STUCK_POSTING_MINUTES = (() => {
  const n = Number(process.env.WORKFLOW_STUCK_POSTING_MINUTES ?? 30)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30
})()

type StuckWorkflowRow = {
  id: string
  age_minutes: number
  state_version: number
  updated_at: string
}

export function createStuckWorkflowAlertsRunner(deps: { pool: Pool; logger: Logger }) {
  const { pool, logger } = deps

  function fireStuckPostingAlert(workflow: string, companyId: string, row: StuckWorkflowRow): void {
    const ageMinutes = Math.round(Number(row.age_minutes))
    const message = `Workflow stuck in posting: ${workflow} ${row.id} (${ageMinutes}m old, state_version=${row.state_version})`
    logger.error(
      {
        workflow,
        company_id: companyId,
        entity_id: row.id,
        state_version: row.state_version,
        age_minutes: ageMinutes,
        updated_at: row.updated_at,
      },
      message,
    )
    Sentry.captureMessage(message, {
      level: 'error',
      tags: {
        scope: 'workflow_stuck_posting',
        workflow_name: workflow,
        entity_type: workflow,
        entity_id: row.id,
        company_id: companyId,
      },
      extra: {
        state_version: row.state_version,
        age_minutes: ageMinutes,
        updated_at: row.updated_at,
        threshold_minutes: WORKFLOW_STUCK_POSTING_MINUTES,
      },
      // Group all alerts for the same (workflow, entity_id) under one
      // Sentry issue. New stuck rows still create separate issues.
      fingerprint: ['workflow_stuck_posting', workflow, row.id],
    })
  }

  return async function checkStuckPostingWorkflows(companyId: string): Promise<{
    rentalBillingStuck: number
    estimatePushStuck: number
  }> {
    const ageMinutes = WORKFLOW_STUCK_POSTING_MINUTES
    const [rental, estimate] = await Promise.all([
      pool
        .query<StuckWorkflowRow>(
          `select id,
                  state_version,
                  updated_at,
                  extract(epoch from (now() - updated_at)) / 60 as age_minutes
           from rental_billing_runs
           where company_id = $1
             and status = 'posting'
             and deleted_at is null
             and updated_at < now() - ($2 || ' minutes')::interval
           order by updated_at asc
           limit 50`,
          [companyId, String(ageMinutes)],
        )
        .catch((err) => {
          logger.error({ err }, '[worker] stuck-posting check failed for rental_billing_runs')
          return { rows: [] as StuckWorkflowRow[] }
        }),
      pool
        .query<StuckWorkflowRow>(
          `select id,
                  state_version,
                  updated_at,
                  extract(epoch from (now() - updated_at)) / 60 as age_minutes
           from estimate_pushes
           where company_id = $1
             and status = 'posting'
             and deleted_at is null
             and updated_at < now() - ($2 || ' minutes')::interval
           order by updated_at asc
           limit 50`,
          [companyId, String(ageMinutes)],
        )
        .catch((err) => {
          logger.error({ err }, '[worker] stuck-posting check failed for estimate_pushes')
          return { rows: [] as StuckWorkflowRow[] }
        }),
    ])

    for (const row of rental.rows) {
      fireStuckPostingAlert('rental_billing_run', companyId, row)
    }
    for (const row of estimate.rows) {
      fireStuckPostingAlert('estimate_push', companyId, row)
    }

    return { rentalBillingStuck: rental.rows.length, estimatePushStuck: estimate.rows.length }
  }
}
