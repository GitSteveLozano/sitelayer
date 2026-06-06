import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import type { Capability } from '@sitelayer/domain'
import { buildPaginationMeta, isValidUuid, parsePagination, PAGINATION_MAX_LIMIT } from '../http-utils.js'
import {
  WORK_ITEM_LANES,
  WORK_ITEM_STATUSES,
  getContextWorkItemWithEvents,
  listContextWorkItems,
  type ContextWorkItemRow,
  type WorkItemLane,
  type WorkItemStatus,
} from '../context-handoff.js'

/**
 * The internal APP-ISSUE surface — a READ-ONLY board/list/detail over the
 * `app_issue` half of `context_work_items` (migration 009 `domain` column).
 *
 * These are problems with the sitelayer SOFTWARE itself (capture-dock born,
 * PLATFORM scope, cross-tenant in spirit). Every route here gates on the
 * PLATFORM capability `app_issue.view`, which the foundation's requireCapability
 * resolver only ever grants to a verified-Clerk superadmin OR a person opted in
 * via the platform_admin_grants table — unreachable via a company role, the dev
 * `x-sitelayer-act-as` override, or the header identity fallback. The two
 * domains cannot bleed: this surface NEVER reads a `field_request` row (the
 * `domain: 'app_issue'` filter is pinned on every query), and the field-request
 * work board (work-requests.ts) NEVER reads an `app_issue` row.
 *
 * Deliberately read-only: triage/resolve/dispatch of app-issues is the
 * `app_issue.triage` capability and a later surface. This is the operator's
 * window into the app-issue backlog, gated so only platform admins can see the
 * captured internal data behind it.
 */

export type IssueRouteCtx = {
  pool: Pool
  company: ActiveCompany
  /**
   * Platform/company-domain capability gate (server.ts closure). app_issue.*
   * resolves on the platform boundary (superadmin ∪ platform_admin_grants) over
   * the RAW pre-act-as identity. On denial it has already sent the 403 and
   * returns false; the handler must `return`.
   */
  requireCapability: (capability: Capability) => Promise<boolean>
  sendJson: (status: number, body: unknown) => void
}

const APP_ISSUE_VIEW: Capability = 'app_issue.view'

function issueResponse(row: ContextWorkItemRow) {
  return {
    id: row.id,
    support_packet_id: row.support_packet_id,
    capture_session_id: row.capture_session_id,
    domain: row.domain,
    title: row.title,
    summary: row.summary,
    status: row.status,
    lane: row.lane,
    severity: row.severity,
    route: row.route,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    assignee_user_id: row.assignee_user_id,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
    reversed_at: row.reversed_at,
    reversibility_window_seconds: Number(row.reversibility_window_seconds),
    expires_at: row.expires_at,
    metadata: row.metadata,
  }
}

type IssueApiResponse = ReturnType<typeof issueResponse>
type IssueBoardGroupBy = 'lane' | 'status_group'
type IssueBoardColumn = {
  id: string
  title: string
  lane: WorkItemLane | null
  statuses: WorkItemStatus[]
  work_items: IssueApiResponse[]
}

const BOARD_GROUP_BY_VALUES = ['lane', 'status_group'] as const
// Mirrors the field-request work board so /issues can reuse the same web board
// components. Keep these column shapes aligned with work-requests.ts.
const STATUS_BOARD_COLUMNS: Array<{ id: string; title: string; statuses: WorkItemStatus[] }> = [
  { id: 'new', title: 'New', statuses: ['new'] },
  { id: 'triaged', title: 'Triaged', statuses: ['triaged', 'human_assigned', 'reopened'] },
  {
    id: 'in_progress',
    title: 'In Progress',
    statuses: ['agent_running', 'review_ready', 'review_stale', 'proposal_expired'],
  },
  { id: 'done', title: 'Done', statuses: ['resolved', 'wont_do', 'reversed'] },
]

function parseAllowed<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (typeof value !== 'string') return null
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : null
}

function titleForLane(lane: WorkItemLane): string {
  if (lane === 'triage') return 'Triage'
  if (lane === 'human') return 'Human'
  if (lane === 'agent') return 'Agent'
  if (lane === 'both') return 'Review'
  return 'Done'
}

function buildIssueBoardColumns(rows: IssueApiResponse[], groupBy: IssueBoardGroupBy): IssueBoardColumn[] {
  if (groupBy === 'status_group') {
    return STATUS_BOARD_COLUMNS.map((column) => ({
      id: column.id,
      title: column.title,
      lane: null,
      statuses: column.statuses,
      work_items: rows.filter((row) => column.statuses.includes(row.status)),
    }))
  }
  return WORK_ITEM_LANES.map((lane) => ({
    id: lane,
    title: titleForLane(lane),
    lane,
    statuses: [...WORK_ITEM_STATUSES],
    work_items: rows.filter((row) => row.lane === lane),
  }))
}

async function listIssues(ctx: IssueRouteCtx, url: URL) {
  if (!(await ctx.requireCapability(APP_ISSUE_VIEW))) return
  const pagination = parsePagination(url.searchParams, { defaultLimit: 50, maxLimit: PAGINATION_MAX_LIMIT })
  if (!pagination.ok) {
    ctx.sendJson(400, { error: pagination.error })
    return
  }
  const status = url.searchParams.get('status')
  if (status !== null && !parseAllowed(status, WORK_ITEM_STATUSES)) {
    ctx.sendJson(400, { error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` })
    return
  }
  const lane = url.searchParams.get('lane')
  if (lane !== null && !parseAllowed(lane, WORK_ITEM_LANES)) {
    ctx.sendJson(400, { error: `lane must be one of ${WORK_ITEM_LANES.join(', ')}` })
    return
  }
  const rows = await listContextWorkItems(ctx.company.id, {
    // PIN the domain so the /issues surface never sees a field_request row.
    domain: 'app_issue',
    status,
    lane,
    entityType: url.searchParams.get('entity_type'),
    entityId: url.searchParams.get('entity_id'),
    limit: pagination.value.limit,
    offset: pagination.value.offset,
  })
  ctx.sendJson(200, {
    issues: rows.rows.map(issueResponse),
    pagination: buildPaginationMeta(pagination.value, rows.rowCount ?? rows.rows.length),
  })
}

async function listIssueBoard(ctx: IssueRouteCtx, url: URL) {
  if (!(await ctx.requireCapability(APP_ISSUE_VIEW))) return
  const pagination = parsePagination(url.searchParams, { defaultLimit: 200, maxLimit: PAGINATION_MAX_LIMIT })
  if (!pagination.ok) {
    ctx.sendJson(400, { error: pagination.error })
    return
  }
  const groupByRaw = url.searchParams.get('group_by')
  const groupBy =
    groupByRaw === null ? 'status_group' : (parseAllowed(groupByRaw, BOARD_GROUP_BY_VALUES) as IssueBoardGroupBy | null)
  if (!groupBy) {
    ctx.sendJson(400, { error: `group_by must be one of ${BOARD_GROUP_BY_VALUES.join(', ')}` })
    return
  }
  const status = url.searchParams.get('status')
  if (status !== null && !parseAllowed(status, WORK_ITEM_STATUSES)) {
    ctx.sendJson(400, { error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` })
    return
  }
  const lane = url.searchParams.get('lane')
  if (lane !== null && !parseAllowed(lane, WORK_ITEM_LANES)) {
    ctx.sendJson(400, { error: `lane must be one of ${WORK_ITEM_LANES.join(', ')}` })
    return
  }
  const rows = await listContextWorkItems(ctx.company.id, {
    domain: 'app_issue',
    status,
    lane,
    entityType: url.searchParams.get('entity_type'),
    entityId: url.searchParams.get('entity_id'),
    limit: pagination.value.limit,
    offset: pagination.value.offset,
  })
  const issues = rows.rows.map(issueResponse)
  ctx.sendJson(200, {
    group_by: groupBy,
    columns: buildIssueBoardColumns(issues, groupBy),
    issues,
    pagination: buildPaginationMeta(pagination.value, rows.rowCount ?? rows.rows.length),
  })
}

async function getIssue(ctx: IssueRouteCtx, id: string, url: URL) {
  if (!(await ctx.requireCapability(APP_ISSUE_VIEW))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid issue id' })
    return
  }
  const eventsPagination = parsePagination(url.searchParams, { defaultLimit: 200, maxLimit: 500 })
  if (!eventsPagination.ok) {
    ctx.sendJson(400, { error: eventsPagination.error })
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id, {
    eventsLimit: eventsPagination.value.limit,
    eventsOffset: eventsPagination.value.offset,
  })
  // 404 the same way for a missing row AND a field_request row: a non-app_issue
  // id must never confirm its existence through this platform surface.
  if (!detail || detail.work_item.domain !== 'app_issue') {
    ctx.sendJson(404, { error: 'issue not found' })
    return
  }
  ctx.sendJson(200, {
    issue: issueResponse(detail.work_item),
    support_packet: detail.work_item.support_packet,
    events: detail.events,
    events_pagination: {
      limit: detail.events_limit,
      offset: detail.events_offset,
      total: detail.events_total,
      has_more: detail.events_truncated,
    },
  })
}

export async function handleIssueRoutes(req: http.IncomingMessage, url: URL, ctx: IssueRouteCtx): Promise<boolean> {
  if (url.pathname === '/api/issues' && req.method === 'GET') {
    await listIssues(ctx, url)
    return true
  }

  if (url.pathname === '/api/issues/board' && req.method === 'GET') {
    await listIssueBoard(ctx, url)
    return true
  }

  const detailMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/)
  if (detailMatch && req.method === 'GET') {
    await getIssue(ctx, decodeURIComponent(detailMatch[1]!), url)
    return true
  }

  return false
}
