import type { IncomingMessage } from 'node:http'
import { CONTRACT_VERSION, type Concern } from '@operator/projectkit'
import type { Identity } from '../auth.js'
import { authorizePlatformAdmin, parseSuperadminEnvIds, type AdminQueryExecutor } from '../admin-auth.js'
import { buildPaginationMeta, isValidUuid, parsePagination, PAGINATION_MAX_LIMIT } from '../http-utils.js'
import { WORK_ITEM_LANES, WORK_ITEM_STATUSES, type WorkItemLane, type WorkItemStatus } from '../context-handoff.js'
import { buildAgentPrompt, type SupportPacketRow } from './support-packets.js'
import {
  agentFeedBaseUrl,
  insertAgentFeedConcernTx,
  mapCaptureArtifactsToConcernRefs,
  type CaptureArtifactSummaryRow,
} from './agent-feed.js'

/**
 * Platform-admin work-request board + the agent dispatch door.
 *
 * This is intentionally mounted before company resolution. The normal
 * `/api/work-requests/*` routes are company/RLS-scoped and require an active
 * tenant membership; the operator board is a cross-tenant fleet view gated only
 * by `authorizePlatformAdmin`.
 *
 * POST /api/admin/work-requests/:id/dispatch-to-agent {audience} addresses a
 * work item to a projectkit pull-executor lane (e.g. 'steve' — the
 * collaborator's Claude Code): it builds a @operator/projectkit Concern from
 * the work item + its support packet (including the same agent_prompt the
 * support-packet read endpoint serves) and inserts it into agent_feed_concerns,
 * idempotent on concern_ref `wi:<work_item_id>:<audience>`. The executor polls
 * GET /api/agent-feed/concerns and reports back via POST
 * /api/agent-feed/callbacks (routes/agent-feed.ts).
 */

export interface AdminWorkRequestRouteDeps {
  pool: AdminQueryExecutor
  identity: Identity
  sendJson: (status: number, body: unknown) => void
  readBody?: () => Promise<Record<string, unknown>>
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

type DispatchWorkItemRow = {
  id: string
  company_id: string
  support_packet_id: string
  title: string
  summary: string | null
  severity: string | null
  route: string | null
  capture_session_id: string | null
  metadata: Record<string, unknown> | null
}

/** Bounded string[] acceptance criteria from work-item metadata, else []. */
function acceptanceFromMetadata(metadata: Record<string, unknown> | null): string[] {
  const raw = metadata?.acceptance
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 500))
    .slice(0, 25)
}

/**
 * POST /api/admin/work-requests/:id/dispatch-to-agent — address a work item to
 * a pull-executor audience. Idempotent on concern_ref `wi:<id>:<audience>`:
 * a repeat dispatch returns the existing feed row (200), a first dispatch the
 * created one (201).
 */
async function handleDispatchToAgent(deps: AdminWorkRequestRouteDeps, workItemId: string): Promise<void> {
  if (!isValidUuid(workItemId)) {
    deps.sendJson(400, { error: 'work item id must be a uuid' })
    return
  }
  const body = deps.readBody ? await deps.readBody() : {}
  const audience = optionalText(body.audience, 80)
  if (!audience) {
    deps.sendJson(400, { error: 'audience is required' })
    return
  }

  const workItemResult = (await deps.pool.query(
    `select w.id, w.company_id, w.support_packet_id, w.title, w.summary, w.severity,
            w.route, w.capture_session_id, w.metadata
       from context_work_items w
      where w.id = $1::uuid
      limit 1`,
    [workItemId],
  )) as { rows?: DispatchWorkItemRow[] }
  const workItem = workItemResult.rows?.[0]
  if (!workItem) {
    deps.sendJson(404, { error: 'work item not found' })
    return
  }

  // The same agent prompt the support-packet read endpoint serves
  // (support-packets.ts buildAgentPrompt — copy-agent-bundle's source text).
  const packetResult = (await deps.pool.query(
    `select id, company_id, actor_user_id, request_id, route, capture_session_id, build_sha, problem,
            client, server_context, created_at, expires_at, redaction_version
       from support_debug_packets
      where company_id = $1 and id = $2
      limit 1`,
    [workItem.company_id, workItem.support_packet_id],
  )) as { rows?: SupportPacketRow[] }
  const packet = packetResult.rows?.[0] ?? null
  const agentPrompt = packet ? buildAgentPrompt(packet) : null

  // Same artifact-ref mapping as the capture-analyzer enqueue at finalize.
  let artifacts: ReturnType<typeof mapCaptureArtifactsToConcernRefs> = []
  if (workItem.capture_session_id) {
    const artifactRows = (await deps.pool.query(
      `select id, kind, content_type, byte_size, duration_ms
         from capture_artifacts
        where company_id = $1
          and capture_session_id = $2::uuid
          and deleted_at is null
          and storage_key is not null
        order by created_at asc
        limit 25`,
      [workItem.company_id, workItem.capture_session_id],
    )) as { rows?: CaptureArtifactSummaryRow[] }
    artifacts = mapCaptureArtifactsToConcernRefs(artifactRows.rows ?? [], agentFeedBaseUrl())
  }

  const concernRef = `wi:${workItem.id}:${audience}`
  const concern: Concern = {
    schema_version: CONTRACT_VERSION,
    project_key: 'sitelayer',
    dispatched_at: new Date().toISOString(),
    concern_ref: concernRef,
    kind: 'execute',
    title: workItem.title,
    ...(workItem.summary ? { summary: workItem.summary } : {}),
    audience,
    assignee: audience,
    acceptance: acceptanceFromMetadata(workItem.metadata),
    source_event_ref: workItem.support_packet_id,
    inputs: {
      work_item_id: workItem.id,
      support_packet_id: workItem.support_packet_id,
      url: workItem.route,
      agent_prompt: agentPrompt,
      artifacts,
    },
  }

  const insertedId = await insertAgentFeedConcernTx(deps.pool as Parameters<typeof insertAgentFeedConcernTx>[0], {
    companyId: workItem.company_id,
    audience,
    concern,
    workItemId: workItem.id,
    captureSessionId: workItem.capture_session_id,
  })

  const rowResult = (await deps.pool.query(
    `select id, company_id, audience, project_key, concern_ref, concern, status,
            callback, work_item_id, capture_session_id, claimed_at, completed_at,
            created_at, updated_at
       from agent_feed_concerns
      where company_id = $1 and project_key = 'sitelayer' and concern_ref = $2
      limit 1`,
    [workItem.company_id, concernRef],
  )) as { rows?: Array<Record<string, unknown>> }
  const row = rowResult.rows?.[0]
  if (!row) {
    deps.sendJson(500, { error: 'agent feed concern insert returned no row' })
    return
  }
  deps.sendJson(insertedId ? 201 : 200, { concern: row, created: Boolean(insertedId) })
}

export async function handleAdminWorkRequestRoutes(
  req: IncomingMessage,
  url: URL,
  deps: AdminWorkRequestRouteDeps,
): Promise<boolean> {
  const dispatchMatch = url.pathname.match(/^\/api\/admin\/work-requests\/([^/]+)\/dispatch-to-agent$/)
  if (url.pathname !== '/api/admin/work-requests/board' && !dispatchMatch) return false

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

  if (dispatchMatch) {
    if (method !== 'POST') {
      deps.sendJson(405, { error: 'method not allowed' })
      return true
    }
    await handleDispatchToAgent(deps, decodeURIComponent(dispatchMatch[1]!))
    return true
  }

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
