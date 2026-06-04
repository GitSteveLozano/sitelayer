import type { Pool } from 'pg'
import { setCompanyGuc } from '../runner-utils.js'
import { postObservationEvent, type PostObservationDeps } from '../mesh-observation-client.js'

export type WorkDispatchReconcileSummary = {
  ran: boolean
  reconciled: number
  failed: number
}

export type WorkDispatchReconcilerDeps = {
  pool: Pool
  meshObservationDeps?: PostObservationDeps
}

const CALLBACK_EVENT_TYPES = [
  'agent.message_received',
  'agent.artifact_attached',
  'agent.proposal_ready',
  'agent.completed',
  'human.review_requested',
] as const

export function createWorkDispatchReconcilerRunner(deps: WorkDispatchReconcilerDeps) {
  const { pool, meshObservationDeps } = deps
  let lastRunAt = 0

  return {
    async maybeReconcile(companyId: string): Promise<WorkDispatchReconcileSummary> {
      const intervalMs = readPositiveInt('WORK_REQUEST_CALLBACK_RECONCILE_INTERVAL_MS', 300_000)
      const now = Date.now()
      if (now - lastRunAt < intervalMs) return { ran: false, reconciled: 0, failed: 0 }
      lastRunAt = now
      return reconcileLostDispatchCallbacks(pool, companyId, meshObservationDeps)
    },
  }
}

type LostCallbackCandidate = {
  id: string
  status: string
  lane: string
  severity: string | null
  route: string | null
  entity_type: string | null
  dispatch_acknowledged_at: string
  mesh_task_id: string | null
  capture_session_id: string | null
}

type ReconciledTransition = {
  workItemId: string
  severity: string | null
  route: string | null
  entityType: string | null
  previousStatus: string
  nextStatus: 'proposal_expired'
  meshTaskId: string | null
}

async function reconcileLostDispatchCallbacks(
  pool: Pool,
  companyId: string,
  meshObservationDeps?: PostObservationDeps,
): Promise<WorkDispatchReconcileSummary> {
  const callbackMissingHours = readPositiveInt('WORK_REQUEST_CALLBACK_MISSING_HOURS', 24)
  const limit = Math.min(readPositiveInt('WORK_REQUEST_CALLBACK_RECONCILE_LIMIT', 25), 100)
  const transitions: ReconciledTransition[] = []
  const client = await pool.connect()
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const candidates = await client.query<LostCallbackCandidate>(
      `select w.id,
              w.status,
              w.lane,
              w.severity,
              w.route,
              w.entity_type,
              ack.occurred_at::text as dispatch_acknowledged_at,
              ack.payload->>'mesh_task_id' as mesh_task_id,
              ack.capture_session_id::text as capture_session_id
         from context_work_items w
         join lateral (
           select occurred_at, payload, capture_session_id
             from context_handoff_events
            where company_id = $1
              and work_item_id = w.id
              and event_type = 'agent.dispatch_acknowledged'
            order by occurred_at desc
            limit 1
         ) ack on true
        where w.company_id = $1
          and w.status = 'agent_running'
          and ack.occurred_at < now() - make_interval(hours => $2::int)
          and not exists (
            select 1
              from context_handoff_events cb
             where cb.company_id = $1
               and cb.work_item_id = w.id
               and cb.occurred_at > ack.occurred_at
               and cb.event_type = any($3::text[])
          )
          and not exists (
            select 1
              from context_handoff_events prior
             where prior.company_id = $1
               and prior.work_item_id = w.id
               and prior.idempotency_key = concat(
                 'context_work_item:lost_callback:',
                 w.id,
                 ':',
                 coalesce(ack.payload->>'mesh_task_id', 'unknown')
               )
          )
        order by ack.occurred_at asc
        limit $4
        for update of w skip locked`,
      [companyId, callbackMissingHours, [...CALLBACK_EVENT_TYPES], limit],
    )

    let reconciled = 0
    for (const row of candidates.rows) {
      const nextStatus = 'proposal_expired'
      const nextLane = row.lane === 'agent' ? 'both' : row.lane
      const meshTaskId = row.mesh_task_id?.trim() || null
      const eventKey = `context_work_item:lost_callback:${row.id}:${meshTaskId ?? 'unknown'}`
      await client.query(
        `insert into context_handoff_events (
           company_id, work_item_id, event_type, actor_kind, actor_ref,
           source_system, payload, metadata, idempotency_key, capture_session_id,
           redaction_version
         ) values ($1, $2, 'agent.callback_missing', 'system', 'work_dispatch_reconciler',
           'sitelayer-worker', $3::jsonb, $4::jsonb, $5, $6::uuid,
           'context-handoff-v1')
         on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing`,
        [
          companyId,
          row.id,
          JSON.stringify({
            message: 'Mesh dispatch was acknowledged, but no agent callback arrived within the configured window.',
            previous_status: row.status,
            previous_lane: row.lane,
            status: nextStatus,
            lane: nextLane,
            mesh_task_id: meshTaskId,
            dispatch_acknowledged_at: row.dispatch_acknowledged_at,
            callback_missing_hours: callbackMissingHours,
          }),
          JSON.stringify({ reason: 'lost_callback_reconciler', dispatcher: 'mesh' }),
          eventKey,
          row.capture_session_id,
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
      reconciled += rowsUpdated
      if (rowsUpdated > 0) {
        transitions.push({
          workItemId: row.id,
          severity: row.severity ?? null,
          route: row.route ?? null,
          entityType: row.entity_type ?? null,
          previousStatus: row.status,
          nextStatus,
          meshTaskId,
        })
      }
    }
    await client.query('commit')
    await emitLostCallbackObservations(companyId, transitions, meshObservationDeps)
    return { ran: true, reconciled, failed: 0 }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function emitLostCallbackObservations(
  companyId: string,
  transitions: ReconciledTransition[],
  deps?: PostObservationDeps,
): Promise<void> {
  if (transitions.length === 0) return
  const occurredAt = new Date().toISOString()
  for (const transition of transitions) {
    try {
      await postObservationEvent(
        {
          source: 'sitelayer',
          event_type: 'work_item_obstructed',
          subject: { type: 'work_item', id: transition.workItemId },
          status: transition.nextStatus,
          reason: 'Mesh dispatch was acknowledged but no callback arrived within the configured window',
          severity: transition.severity ?? 'normal',
          occurred_at: occurredAt,
          metadata: {
            company_id: companyId,
            route: transition.route,
            entity_type: transition.entityType,
            previous_status: transition.previousStatus,
            mesh_task_id: transition.meshTaskId,
            reconciler: 'lost_callback',
          },
        },
        deps,
      )
    } catch {
      // Best effort only; context_handoff_events is the local source of truth.
    }
  }
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}
