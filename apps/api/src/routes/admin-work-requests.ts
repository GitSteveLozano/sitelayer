import type { IncomingMessage } from 'node:http'
import type { Identity } from '../auth.js'
import { authorizePlatformAdmin, parseSuperadminEnvIds, type AdminQueryExecutor } from '../admin-auth.js'
import { buildPaginationMeta, isValidUuid, parsePagination, PAGINATION_MAX_LIMIT } from '../http-utils.js'
import { WORK_ITEM_LANES, WORK_ITEM_STATUSES, type WorkItemLane, type WorkItemStatus } from '../context-handoff.js'

/**
 * Read-only platform-admin work-request board.
 *
 * This is intentionally mounted before company resolution. The normal
 * `/api/work-requests/*` routes are company/RLS-scoped and require an active
 * tenant membership; the operator board is a cross-tenant fleet view gated only
 * by `authorizePlatformAdmin`.
 */

export interface AdminWorkRequestRouteDeps {
  pool: AdminQueryExecutor
  identity: Identity
  sendJson: (status: number, body: unknown) => void
  envIds?: ReadonlySet<string>
}

type BoardGroupBy = 'lane' | 'status_group'

type AdminWorkItemRow = {
  id: string
  company_id: string
  company_slug: string
  company_name: string
  support_packet_id: string
  title: string
  summary: string | null
  status: WorkItemStatus
  lane: WorkItemLane
  severity: string | null
  route: string | null
  capture_session_id: string | null
  entity_type: string | null
  entity_id: string | null
  assignee_user_id: string | null
  created_by_user_id: string | null
  created_at: string
  updated_at: string
  resolved_at: string | null
  reversed_at: string | null
  reversibility_window_seconds: number
  expires_at: string | null
}

type AdminWorkItemResponse = ReturnType<typeof adminWorkItemResponse>

type AdminBoardColumn = {
  id: string
  title: string
  lane: WorkItemLane | null
  statuses: WorkItemStatus[]
  work_items: AdminWorkItemResponse[]
}

const BOARD_GROUP_BY_VALUES = ['lane', 'status_group'] as const
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

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function titleForLane(lane: WorkItemLane): string {
  if (lane === 'triage') return 'Triage'
  if (lane === 'human') return 'Human'
  if (lane === 'agent') return 'Agent'
  if (lane === 'both') return 'Review'
  return 'Done'
}

function adminWorkItemResponse(row: AdminWorkItemRow) {
  return {
    id: row.id,
    company_id: row.company_id,
    company_slug: row.company_slug,
    company_name: row.company_name,
    support_packet_id: row.support_packet_id,
    capture_session_id: row.capture_session_id,
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
  }
}

function buildBoardColumns(rows: AdminWorkItemResponse[], groupBy: BoardGroupBy): AdminBoardColumn[] {
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

export async function handleAdminWorkRequestRoutes(
  req: IncomingMessage,
  url: URL,
  deps: AdminWorkRequestRouteDeps,
): Promise<boolean> {
  if (url.pathname !== '/api/admin/work-requests/board') return false

  const gate = await authorizePlatformAdmin(
    deps.pool,
    deps.identity,
    deps.envIds ?? parseSuperadminEnvIds(process.env.PLATFORM_SUPERADMIN_CLERK_IDS),
  )
  if (!gate.ok) {
    deps.sendJson(gate.status, { error: gate.message })
    return true
  }

  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    deps.sendJson(405, { error: 'method not allowed' })
    return true
  }

  const pagination = parsePagination(url.searchParams, { defaultLimit: 200, maxLimit: PAGINATION_MAX_LIMIT })
  if (!pagination.ok) {
    deps.sendJson(400, { error: pagination.error })
    return true
  }

  const groupByRaw = url.searchParams.get('group_by')
  const groupBy =
    groupByRaw === null ? 'status_group' : (parseAllowed(groupByRaw, BOARD_GROUP_BY_VALUES) as BoardGroupBy | null)
  if (!groupBy) {
    deps.sendJson(400, { error: `group_by must be one of ${BOARD_GROUP_BY_VALUES.join(', ')}` })
    return true
  }

  const companyId = url.searchParams.get('company_id')
  if (companyId !== null && !isValidUuid(companyId)) {
    deps.sendJson(400, { error: 'company_id must be a uuid' })
    return true
  }
  const status = url.searchParams.get('status')
  if (status !== null && !parseAllowed(status, WORK_ITEM_STATUSES)) {
    deps.sendJson(400, { error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` })
    return true
  }
  const lane = url.searchParams.get('lane')
  if (lane !== null && !parseAllowed(lane, WORK_ITEM_LANES)) {
    deps.sendJson(400, { error: `lane must be one of ${WORK_ITEM_LANES.join(', ')}` })
    return true
  }

  const clauses: string[] = []
  const values: unknown[] = []
  const pushClause = (sql: string, value: unknown) => {
    values.push(value)
    clauses.push(sql.replace('?', `$${values.length}`))
  }

  if (companyId) pushClause('w.company_id = ?', companyId)
  const companySlug = optionalText(url.searchParams.get('company_slug'), 120)
  if (companySlug) pushClause('c.slug = ?', companySlug)
  if (status) pushClause('w.status = ?', status)
  if (lane) pushClause('w.lane = ?', lane)
  const assigneeUserId = optionalText(url.searchParams.get('assignee_user_id'), 200)
  if (assigneeUserId) pushClause('w.assignee_user_id = ?', assigneeUserId)
  const createdByUserId = optionalText(url.searchParams.get('created_by_user_id'), 200)
  if (createdByUserId) pushClause('w.created_by_user_id = ?', createdByUserId)
  const entityType = optionalText(url.searchParams.get('entity_type'), 120)
  if (entityType) pushClause('w.entity_type = ?', entityType)
  const entityId = optionalText(url.searchParams.get('entity_id'), 200)
  if (entityId) pushClause('w.entity_id = ?', entityId)

  values.push(pagination.value.limit, pagination.value.offset)
  const where = clauses.length ? `where ${clauses.join(' and ')}` : ''
  const result = (await deps.pool.query(
    `select w.id, w.company_id, c.slug as company_slug, c.name as company_name,
            w.support_packet_id, w.title, w.summary, w.status, w.lane, w.severity,
            w.route, w.capture_session_id, w.entity_type, w.entity_id,
            w.assignee_user_id, w.created_by_user_id, w.created_at, w.updated_at,
            w.resolved_at, w.reversed_at, w.reversibility_window_seconds,
            (w.created_at + w.reversibility_window_seconds * interval '1 second') as expires_at
       from context_work_items w
       join companies c on c.id = w.company_id
       ${where}
      order by w.updated_at desc, w.created_at desc
      limit $${values.length - 1} offset $${values.length}`,
    values,
  )) as { rows?: AdminWorkItemRow[]; rowCount?: number }

  const workItems = (result.rows ?? []).map(adminWorkItemResponse)
  deps.sendJson(200, {
    group_by: groupBy,
    columns: buildBoardColumns(workItems, groupBy),
    work_items: workItems,
    pagination: buildPaginationMeta(pagination.value, result.rowCount ?? workItems.length),
  })
  return true
}
