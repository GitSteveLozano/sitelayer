import type { Pool } from 'pg'
import { setCompanyGuc } from '../runner-utils.js'
import { postObservationEvent, type PostObservationDeps } from '../mesh-observation-client.js'

export type WorkRequestStaleSummary = {
  ran: boolean
  updated: number
  failed: number
}

export type WorkRequestStaleDeps = {
  pool: Pool
  meshObservationDeps?: PostObservationDeps
}

export function createWorkRequestStaleRunner(deps: WorkRequestStaleDeps) {
  const { pool, meshObservationDeps } = deps
  let lastRunAt = 0

  return {
    async maybeSweep(companyId: string): Promise<WorkRequestStaleSummary> {
      const intervalMs = readPositiveInt('WORK_REQUEST_STALE_SWEEP_INTERVAL_MS', 300_000)
      const now = Date.now()
      if (now - lastRunAt < intervalMs) return { ran: false, updated: 0, failed: 0 }
      lastRunAt = now
      return sweepStaleWorkRequests(pool, companyId, meshObservationDeps)
    },
  }
}

type StaleTransition = {
  workItemId: string
  severity: string | null
  route: string | null
  entityType: string | null
  previousStatus: string
  nextStatus: 'review_stale' | 'proposal_expired'
}

async function sweepStaleWorkRequests(
  pool: Pool,
  companyId: string,
  meshObservationDeps?: PostObservationDeps,
): Promise<WorkRequestStaleSummary> {
  const reviewStaleHours = readPositiveInt('WORK_REQUEST_REVIEW_STALE_HOURS', 48)
  const agentStaleHours = readPositiveInt('WORK_REQUEST_AGENT_STALE_HOURS', 24)
  const limit = Math.min(readPositiveInt('WORK_REQUEST_STALE_SWEEP_LIMIT', 25), 100)
  const transitions: StaleTransition[] = []
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const stale = await client.query<{
      id: string
      status: string
      lane: string
      severity: string | null
      route: string | null
      entity_type: string | null
    }>(
      `select id, status, lane, severity, route, entity_type
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
      const rowsUpdated = result.rowCount ?? 0
      updated += rowsUpdated
      if (rowsUpdated > 0) {
        transitions.push({
          workItemId: row.id,
          severity: row.severity ?? null,
          route: row.route ?? null,
          entityType: row.entity_type ?? null,
          previousStatus: row.status,
          nextStatus,
        })
      }
    }
    await client.query('commit')
    // Emit mesh observation events for the committed transitions. This
    // is best-effort — failures don't bubble up to the sweep summary
    // (the audit row already landed in context_handoff_events, which is
    // the local source of truth). Done outside the DB transaction so
    // a slow mesh ingress can't hold a Postgres connection.
    await emitObstructionObservations(companyId, transitions, meshObservationDeps)
    return { ran: true, updated, failed: 0 }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function emitObstructionObservations(
  companyId: string,
  transitions: StaleTransition[],
  deps?: PostObservationDeps,
): Promise<void> {
  if (transitions.length === 0) return
  const occurredAt = new Date().toISOString()
  for (const transition of transitions) {
    const reason =
      transition.nextStatus === 'review_stale'
        ? 'Review not picked up in the configured window'
        : 'Agent dispatch did not return a proposal within the window'
    try {
      await postObservationEvent(
        {
          source: 'sitelayer',
          event_type: 'work_item_obstructed',
          subject: { type: 'work_item', id: transition.workItemId },
          status: transition.nextStatus,
          reason,
          severity: transition.severity ?? 'normal',
          occurred_at: occurredAt,
          metadata: {
            company_id: companyId,
            route: transition.route,
            entity_type: transition.entityType,
            previous_status: transition.previousStatus,
          },
        },
        deps,
      )
    } catch {
      // postObservationEvent itself swallows fetch errors and returns a
      // result object. This catch is defense-in-depth for unexpected
      // panics in the client (e.g. invalid env that throws during
      // module init under a stricter runtime).
    }
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
