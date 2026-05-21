import type { Pool } from 'pg'
import { setCompanyGuc } from '../runner-utils.js'

export type WorkRequestStaleSummary = {
  ran: boolean
  updated: number
  failed: number
}

export function createWorkRequestStaleRunner(deps: { pool: Pool }) {
  const { pool } = deps
  let lastRunAt = 0

  return {
    async maybeSweep(companyId: string): Promise<WorkRequestStaleSummary> {
      const intervalMs = readPositiveInt('WORK_REQUEST_STALE_SWEEP_INTERVAL_MS', 300_000)
      const now = Date.now()
      if (now - lastRunAt < intervalMs) return { ran: false, updated: 0, failed: 0 }
      lastRunAt = now
      return sweepStaleWorkRequests(pool, companyId)
    },
  }
}

async function sweepStaleWorkRequests(pool: Pool, companyId: string): Promise<WorkRequestStaleSummary> {
  const reviewStaleHours = readPositiveInt('WORK_REQUEST_REVIEW_STALE_HOURS', 48)
  const agentStaleHours = readPositiveInt('WORK_REQUEST_AGENT_STALE_HOURS', 24)
  const limit = Math.min(readPositiveInt('WORK_REQUEST_STALE_SWEEP_LIMIT', 25), 100)
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const stale = await client.query<{ id: string; status: string; lane: string }>(
      `select id, status, lane
         from context_work_items
        where company_id = $1
          and (
            (status = 'review_ready' and updated_at < now() - make_interval(hours => $2::int))
            or (status = 'agent_running' and updated_at < now() - make_interval(hours => $3::int))
          )
        order by updated_at asc
        limit $4
        for update skip locked`,
      [companyId, reviewStaleHours, agentStaleHours, limit],
    )
    let updated = 0
    for (const row of stale.rows) {
      const nextStatus = row.status === 'review_ready' ? 'review_stale' : 'proposal_expired'
      const nextLane = row.lane === 'agent' ? 'both' : row.lane
      const eventKey = `context_work_item:worker_stale:${row.id}:${nextStatus}`
      await client.query(
        `insert into context_handoff_events (
           company_id, work_item_id, event_type, actor_kind, actor_ref,
           source_system, payload, metadata, idempotency_key, redaction_version
         ) values ($1, $2, 'work_item.status_changed', 'system', 'work_request_stale_sweep',
           'sitelayer-worker', $3::jsonb, $4::jsonb, $5, 'context-handoff-v1')
         on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing`,
        [
          companyId,
          row.id,
          JSON.stringify({
            previous_status: row.status,
            previous_lane: row.lane,
            status: nextStatus,
            lane: nextLane,
            review_stale_hours: reviewStaleHours,
            agent_stale_hours: agentStaleHours,
          }),
          JSON.stringify({ reason: 'worker_stale_sweep' }),
          eventKey,
        ],
      )
      const result = await client.query(
        `update context_work_items
            set status = $3,
                lane = $4,
                updated_at = now()
          where company_id = $1 and id = $2 and status = $5`,
        [companyId, row.id, nextStatus, nextLane, row.status],
      )
      updated += result.rowCount ?? 0
    }
    await client.query('commit')
    return { ran: true, updated, failed: 0 }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
