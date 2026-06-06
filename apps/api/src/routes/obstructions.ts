import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { withCompanyClient } from '../mutation-tx.js'
import { WORK_ITEM_LANES, type WorkItemLane, type WorkItemSeverity } from '../context-handoff.js'

// Wedge 4 — Obstruction signals as first-class queryable rows.
//
// Today sitelayer carries "obstruction" only as a terminal status on
// context_work_items (review_stale, proposal_expired, wont_do) or as a
// dead row in mutation_outbox for the mesh dispatch path. This endpoint
// promotes those latent states to a first-class signal surface so the
// operator dashboard (and the PEL view layer on mesh) can read them
// without learning the underlying schema.
//
// `dead` here is a derived status: a work item whose most recent
// dispatch_mesh_work_request mutation_outbox row is in 'failed' or 'dead'
// AND the work item itself is still non-terminal (i.e. not resolved/
// wont_do/reopened). Those are the stuck-on-dispatch cases that ADR 0023
// circuit-state guarded against; surfacing them here makes the
// "investigate dispatch outbox failure" path observable without joining
// 3 tables.

const TRIAGE_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'bookkeeper']
const DISPATCH_MUTATION_TYPE = 'dispatch_mesh_work_request'
const OBSTRUCTION_WORK_ITEM_STATUSES = ['review_stale', 'proposal_expired', 'wont_do'] as const

type ObstructionStatus = (typeof OBSTRUCTION_WORK_ITEM_STATUSES)[number] | 'dead'
const ALL_OBSTRUCTION_STATUSES: readonly ObstructionStatus[] = ['review_stale', 'proposal_expired', 'wont_do', 'dead']

const LANE_FILTERS = ['agent', 'human', 'both'] as const
type LaneFilter = (typeof LANE_FILTERS)[number]

export type ObstructionsRouteCtx = {
  pool: Pool
  company: ActiveCompany
  identity: Identity
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

export type ObstructionRow = {
  work_item_id: string
  title: string
  severity: WorkItemSeverity | 'normal'
  status: ObstructionStatus
  blocked_reason: string
  blocked_since: string
  route: string | null
  entity_type: string | null
  entity_id: string | null
  assignee_user_id: string | null
  suggested_action: string
  reversibility_available: boolean
  last_event: {
    type: string
    occurred_at: string
    actor_kind: string
  } | null
}

export type ObstructionsResponse = {
  obstructions: ObstructionRow[]
  total: number
  by_status: Record<ObstructionStatus, number>
}

export async function handleObstructionsRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ObstructionsRouteCtx,
): Promise<boolean> {
  if (url.pathname === '/api/work-requests/obstructions' && req.method === 'GET') {
    await getObstructions(ctx, url)
    return true
  }
  return false
}

function suggestedActionFor(status: ObstructionStatus): string {
  switch (status) {
    case 'review_stale':
      return 'Resume review or reassign — work item awaits human input'
    case 'proposal_expired':
      return 'Re-dispatch with refreshed context, or close as wont_do'
    case 'wont_do':
      return 'Archive — explicit decision recorded'
    case 'dead':
      return 'Investigate dispatch outbox failure; check integration_circuit_state'
  }
}

function blockedReasonFor(status: ObstructionStatus): string {
  switch (status) {
    case 'review_stale':
      return 'Review not picked up in the configured window'
    case 'proposal_expired':
      return 'Agent dispatch did not return a proposal within the window'
    case 'wont_do':
      return 'Operator declined the work item explicitly'
    case 'dead':
      return 'Mesh dispatch exhausted retries; outbox row marked dead'
  }
}

function parseLaneFilter(raw: string | null): LaneFilter | null {
  if (!raw) return null
  const cleaned = raw.trim().toLowerCase()
  if (cleaned === 'agent' || cleaned === 'human' || cleaned === 'both') return cleaned
  return null
}

function laneMatchesFilter(lane: WorkItemLane, filter: LaneFilter | null): boolean {
  if (filter === null) return true
  if (filter === 'both') return true
  if (filter === 'agent') return lane === 'agent' || lane === 'both'
  if (filter === 'human') return lane === 'human' || lane === 'both'
  return true
}

type RawObstructionRow = {
  work_item_id: string
  title: string
  status: string
  lane: WorkItemLane
  severity: WorkItemSeverity | null
  route: string | null
  entity_type: string | null
  entity_id: string | null
  assignee_user_id: string | null
  blocked_since: string
  derived_status: ObstructionStatus
  last_event_type: string | null
  last_event_occurred_at: string | null
  last_event_actor_kind: string | null
  reversibility_window_seconds: number | null
}

async function getObstructions(ctx: ObstructionsRouteCtx, url: URL): Promise<void> {
  if (!ctx.requireRole(TRIAGE_ROLES)) return
  const laneFilterRaw = url.searchParams.get('lane')
  const laneFilter = parseLaneFilter(laneFilterRaw)
  if (laneFilterRaw && !laneFilter) {
    ctx.sendJson(400, { error: `invalid lane filter; allowed: ${LANE_FILTERS.join(', ')}` })
    return
  }

  // One round-trip: union the work-item-status obstructions and the
  // dead-dispatch obstructions, then left-join the latest event for the
  // (work_item) so we can fill last_event without a per-row follow-up.
  //
  // Reversibility is now a first-class context_work_items column. Keep the
  // availability calculation in app code so the response can explain an
  // obstruction without duplicating timer semantics in SQL.
  const rows = await withCompanyClient(ctx.company.id, async (c) => {
    const result = await c.query<RawObstructionRow>(
      `with status_obstructions as (
         select
           w.id as work_item_id,
           w.title,
           w.status::text as status,
           w.lane,
           w.severity,
           w.route,
           w.entity_type,
           w.entity_id,
           w.assignee_user_id,
           w.updated_at as blocked_since,
           w.status::text as derived_status,
           w.reversibility_window_seconds as reversibility_window_seconds
         from context_work_items w
         where w.company_id = $1
           and w.status in ('review_stale', 'proposal_expired', 'wont_do')
       ),
       dead_dispatches as (
         select distinct on (w.id)
           w.id as work_item_id,
           w.title,
           w.status::text as status,
           w.lane,
           w.severity,
           w.route,
           w.entity_type,
           w.entity_id,
           w.assignee_user_id,
           coalesce(o.next_attempt_at, o.applied_at, w.updated_at) as blocked_since,
           'dead'::text as derived_status,
           w.reversibility_window_seconds as reversibility_window_seconds
         from context_work_items w
         join mutation_outbox o
           on o.company_id = w.company_id
          and o.entity_type = 'context_work_item'
          and o.entity_id::text = w.id::text
          and o.mutation_type = $2
          and o.status in ('failed', 'dead')
         where w.company_id = $1
           and w.status not in ('resolved', 'wont_do')
         order by w.id, o.attempt_count desc nulls last, o.applied_at desc nulls last
       ),
       merged as (
         select * from status_obstructions
         union all
         select * from dead_dispatches
         where work_item_id not in (select work_item_id from status_obstructions)
       ),
       latest_events as (
         select distinct on (e.work_item_id)
           e.work_item_id,
           e.event_type as last_event_type,
           e.recorded_at as last_event_occurred_at,
           e.actor_kind as last_event_actor_kind
         from context_handoff_events e
         where e.company_id = $1
           and e.work_item_id in (select work_item_id from merged)
         order by e.work_item_id, e.recorded_at desc, e.id desc
       )
       select
         m.work_item_id,
         m.title,
         m.status,
         m.lane,
         m.severity,
         m.route,
         m.entity_type,
         m.entity_id,
         m.assignee_user_id,
         m.blocked_since,
         m.derived_status,
         m.reversibility_window_seconds,
         le.last_event_type,
         le.last_event_occurred_at,
         le.last_event_actor_kind
       from merged m
       left join latest_events le on le.work_item_id = m.work_item_id
       order by m.blocked_since asc nulls last, m.work_item_id asc
       limit 500`,
      [ctx.company.id, DISPATCH_MUTATION_TYPE],
    )
    return result.rows
  })

  const filteredRows = rows.filter((row) => laneMatchesFilter(row.lane, laneFilter))

  const obstructions: ObstructionRow[] = filteredRows.map((row) => {
    const status: ObstructionStatus = row.derived_status
    const severity = (row.severity ?? 'normal') as WorkItemSeverity | 'normal'
    return {
      work_item_id: row.work_item_id,
      title: row.title,
      severity,
      status,
      blocked_reason: blockedReasonFor(status),
      blocked_since: row.blocked_since,
      route: row.route,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      assignee_user_id: row.assignee_user_id,
      suggested_action: suggestedActionFor(status),
      reversibility_available: computeReversibilityAvailable(row, status),
      last_event:
        row.last_event_type && row.last_event_occurred_at
          ? {
              type: row.last_event_type,
              occurred_at: row.last_event_occurred_at,
              actor_kind: row.last_event_actor_kind ?? 'system',
            }
          : null,
    }
  })

  const byStatus: Record<ObstructionStatus, number> = {
    review_stale: 0,
    proposal_expired: 0,
    wont_do: 0,
    dead: 0,
  }
  for (const row of obstructions) {
    byStatus[row.status] += 1
  }

  const response: ObstructionsResponse = {
    obstructions,
    total: obstructions.length,
    by_status: byStatus,
  }
  ctx.sendJson(200, response)
}

function computeReversibilityAvailable(row: RawObstructionRow, status: ObstructionStatus): boolean {
  // 'wont_do' is an operator-declined decision; per the wedge spec, the
  // reversibility window is closed regardless of the timer.
  if (status === 'wont_do') return false
  // No reversibility data on the row → optimistically open for historical rows
  // or partially migrated environments. New rows should always carry it.
  if (row.reversibility_window_seconds === null) return true
  if (row.reversibility_window_seconds <= 0) return false
  const blockedAt = Date.parse(row.blocked_since)
  if (!Number.isFinite(blockedAt)) return true
  const ageSeconds = Math.floor((Date.now() - blockedAt) / 1000)
  return ageSeconds < row.reversibility_window_seconds
}

export const __testHooks = {
  ALL_OBSTRUCTION_STATUSES,
  blockedReasonFor,
  suggestedActionFor,
  computeReversibilityAvailable,
  parseLaneFilter,
  laneMatchesFilter,
  OBSTRUCTION_WORK_ITEM_STATUSES,
  LANE_FILTERS,
  // Help downstream tests reason about lanes consistently with the
  // canonical enum without importing context-handoff just to assert.
  WORK_ITEM_LANES,
}
