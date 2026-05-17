import type { Pool, PoolClient } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { captureWithEntityContext } from './instrument.js'

/**
 * Bind `app.company_id` for the lifetime of the active transaction so any
 * RLS-protected SELECT/INSERT/UPDATE the worker issues against company-scoped
 * tables passes the `company_isolation` policy (migration 066). Caller must
 * have already opened a transaction with `client.query('begin')`.
 *
 * Migration 066's policy is `app_current_company_id() IS NULL OR company_id =
 * app_current_company_id()`, so a tx that forgets to set this still works —
 * but writes to the 4 RLS-enforced tables (audit_events, workflow_event_log,
 * mutation_outbox, sync_events) under FORCE will pass WITH CHECK only when
 * the GUC matches the row's company_id. Set this near the top of every BEGIN
 * the worker opens to keep behaviour stable when the permissive `IS NULL OR`
 * clause is removed in a follow-up.
 */
export async function setCompanyGuc(client: PoolClient, companyId: string): Promise<void> {
  await client.query('select set_config($1, $2, true)', ['app.company_id', companyId])
}

export interface AgentDrainSummary {
  processed: number
  insightsCreated: number
  failed: number
}

/**
 * Generic ai-insight outbox drain. Claims rows of the given mutation
 * type, runs the per-row processor, marks 'applied' on success or
 * reschedules with backoff on failure (parking at status='failed'
 * after 5 attempts so a structurally-broken row stops looping). Each
 * row runs in its own transaction so a stuck row can't strand the
 * rest of the batch.
 */
export async function drainAgentMutations<TPayload>(
  pool: Pool,
  mutationType: string,
  companyId: string,
  scope: string,
  process: (client: PoolClient, companyId: string, payload: TPayload) => Promise<{ insightsCreated: number }>,
): Promise<AgentDrainSummary> {
  const summary: AgentDrainSummary = { processed: 0, insightsCreated: 0, failed: 0 }
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const claimed = await client.query<{ id: string; payload: TPayload }>(
      `update mutation_outbox
         set status = 'processing',
             attempt_count = attempt_count + 1,
             next_attempt_at = now() + interval '5 minutes',
             error = null
       where id in (
         select id from mutation_outbox
         where company_id = $1
           and mutation_type = $2
           and (
             (status = 'pending' and next_attempt_at <= now())
             or (status = 'processing' and next_attempt_at <= now())
           )
         order by next_attempt_at asc, created_at asc
         limit 5
         for update skip locked
       )
       returning id, payload`,
      [companyId, mutationType],
    )
    await client.query('commit')

    for (const row of claimed.rows) {
      summary.processed++
      await client.query('begin')
      await setCompanyGuc(client, companyId)
      try {
        const result = await process(client, companyId, row.payload)
        summary.insightsCreated += result.insightsCreated
        await client.query(
          `update mutation_outbox
             set status = 'applied', applied_at = now(), updated_at = now()
           where id = $1`,
          [row.id],
        )
        await client.query('commit')
      } catch (err) {
        summary.failed++
        await client.query('rollback').catch(() => {})
        const message = err instanceof Error ? err.message : String(err)
        await pool
          .query(
            `update mutation_outbox
               set status = case when attempt_count >= 5 then 'failed' else 'pending' end,
                   error = $2,
                   next_attempt_at = now() + interval '2 minutes',
                   updated_at = now()
             where id = $1`,
            [row.id, message],
          )
          .catch(() => {})
        captureWithEntityContext(err, {
          scope,
          company_id: companyId,
          extra_tags: { outbox_id: row.id, mutation_type: mutationType },
        })
      }
    }
  } finally {
    client.release()
  }
  return summary
}

/**
 * Persist circuit-breaker state to `integration_circuit_state` so the
 * API's /api/metrics endpoint can publish the
 * `sitelayer_circuit_breaker_state{integration}` gauge. Best-effort:
 * a DB hiccup mustn't block the breaker transition.
 */
export async function persistCircuitState(
  pool: Pool,
  logger: Logger,
  integration: string,
  state: 'open' | 'closed',
  info?: { failureCount?: number; lastError?: string | null },
): Promise<void> {
  try {
    await pool.query(
      `insert into integration_circuit_state (integration, state, failure_count, last_error, opened_at, updated_at)
         values ($1, $2, coalesce($3, 0), $4, case when $2 = 'open' then now() else null end, now())
       on conflict (integration) do update set
         state = excluded.state,
         failure_count = coalesce(excluded.failure_count, integration_circuit_state.failure_count),
         last_error = coalesce(excluded.last_error, integration_circuit_state.last_error),
         opened_at = case when excluded.state = 'open' then coalesce(integration_circuit_state.opened_at, now()) else null end,
         updated_at = now()`,
      [integration, state, info?.failureCount ?? null, info?.lastError ?? null],
    )
  } catch (err) {
    logger.warn({ err, integration, state }, '[circuit-breaker] failed to persist state')
  }
}
