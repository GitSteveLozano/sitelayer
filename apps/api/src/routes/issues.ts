import type http from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import { getRequestContext } from '@sitelayer/logger'
import { assembleDebugBundle, type DebugBundle } from '@sitelayer/queue'
import type { ActiveCompany } from '../auth-types.js'
import type { Identity } from '../auth.js'
import type { Capability } from '@sitelayer/domain'
import {
  buildPaginationMeta,
  isValidUuid,
  parseJsonBody,
  parsePagination,
  PAGINATION_MAX_LIMIT,
} from '../http-utils.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import {
  WORK_ITEM_LANES,
  WORK_ITEM_STATUSES,
  appendContextHandoffEventTx,
  getContextWorkItemWithEvents,
  listContextWorkItems,
  updateContextWorkItemWithEventTx,
  type ContextWorkItemDetail,
  type ContextWorkItemRow,
  type HandoffEventType,
  type WorkItemLane,
  type WorkItemStatus,
} from '../context-handoff.js'
import { sanitizeSupportJson } from './support-packets.js'
import { getBuildSha } from '../lib/build-sha.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

/**
 * The internal APP-ISSUE surface — board/list/detail plus the narrow triage
 * write leg over the `app_issue` half of `context_work_items` (migration 009
 * `domain` column).
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
 * The read surface (list/board/detail) gates on `app_issue.view`. The WRITE
 * half is the narrow triage surface promised by the lifecycle docs ("agents
 * can only reach review_ready — a human accepts to resolve"):
 * POST /api/issues/:id/events with {action: accept|resolve|wont_do}, gated on
 * the platform capability `app_issue.triage` (same boundary as escalate).
 * Dispatch of app-issues stays elsewhere (admin-work-requests.ts).
 */

export type IssueRouteCtx = {
  pool: Pool
  company: ActiveCompany
  identity: Identity
  buildSha: string
  /**
   * Platform/company-domain capability gate (server.ts closure). app_issue.*
   * resolves on the platform boundary (superadmin ∪ platform_admin_grants) over
   * the RAW pre-act-as identity. On denial it has already sent the 403 and
   * returns false; the handler must `return`.
   */
  requireCapability: (capability: Capability) => Promise<boolean>
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const APP_ISSUE_VIEW: Capability = 'app_issue.view'
// Triage/escalate of app-issues — the WRITE half of the platform surface.
const APP_ISSUE_TRIAGE: Capability = 'app_issue.triage'

// Escalation tiers. tier 2 = re-run the same Sentry+Axiom enrichment the
// finalize bundle worker runs; tier 3 = the deeper pull (here, the same fetch
// set — the value-add is the auditable per-pull access log, not a different
// API). Kept narrow so a vague body can't request an unbounded fan-out.
const ESCALATION_TIERS = ['2', '3'] as const
type EscalationTier = (typeof ESCALATION_TIERS)[number]

const IssueEscalateBodySchema = z
  .object({
    tier: z.union([z.string(), z.number()]).nullish(),
  })
  .loose()

// The app_issue triage write surface (POST /api/issues/:id/events). Three
// human verbs over the existing status vocabulary — never a free-form status
// write, so the surface cannot invent transitions:
//   accept  — pull a fresh/bounced issue into triage (new|reopened plus the
//             sweep bounce states review_stale|proposal_expired → triaged).
//   resolve — the doc-promised "human accepts to resolve" leg
//             (review_ready → resolved; also allowed from the other
//             non-terminal states so a human can close directly).
//   wont_do — decline (same sources as resolve → wont_do).
// `reversed` stays exclusively on the field-request reverse endpoint; agents
// can only ever reach review_ready (agent-feed.ts / work-requests.ts).
const ISSUE_TRIAGE_ACTIONS = ['accept', 'resolve', 'wont_do'] as const
type IssueTriageAction = (typeof ISSUE_TRIAGE_ACTIONS)[number]

const IssueTriageBodySchema = z
  .object({
    action: z.enum(ISSUE_TRIAGE_ACTIONS),
    message: z.string().trim().min(1).max(4000).optional().nullable(),
    idempotency_key: z.string().trim().min(1).max(200).optional().nullable(),
  })
  .loose()

const ACCEPT_FROM_STATUSES: readonly WorkItemStatus[] = ['new', 'reopened', 'review_stale', 'proposal_expired']
const CLOSE_FROM_STATUSES: readonly WorkItemStatus[] = [
  'new',
  'triaged',
  'human_assigned',
  'reopened',
  'agent_running',
  'review_ready',
  'review_stale',
  'proposal_expired',
]

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
type IssueDiagnosticCheckStatus = 'ok' | 'pending' | 'warn' | 'error' | 'missing'
type IssueDiagnosticManifest = {
  schema: 'sitelayer.diagnostic_manifest.v1'
  generated_at: string
  subject: {
    kind: 'app_issue'
    issue_id: string
    support_packet_id: string
    capture_session_id: string | null
  }
  operator_next_step: string
  needs_attention: boolean
  capture_readiness: {
    support_packet: 'ready' | 'missing'
    capture_session: 'ready' | 'not_captured'
    artifact_analysis: 'ready' | 'pending' | 'failed' | 'missing'
  }
  evidence_refs: Array<{ type: string; id: string }>
  worker_health_refs: Array<{ kind: string; path: string }>
  checks: Array<{
    key: string
    label: string
    status: IssueDiagnosticCheckStatus
    detail: string | null
  }>
}
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

function issueJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function issueString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function buildIssueDiagnosticManifest(detail: ContextWorkItemDetail): IssueDiagnosticManifest {
  const item = detail.work_item
  const support = item.support_packet
  const captureSessionId = item.capture_session_id
  const analysis = issueJsonObject(item.metadata?.capture_artifact_analysis)
  const analysisStatus = issueString(analysis?.status)
  const artifactAnalysis =
    analysisStatus === 'ready'
      ? 'ready'
      : analysisStatus === 'failed' || analysisStatus === 'error'
        ? 'failed'
        : analysisStatus === 'pending' || analysisStatus === 'processing'
          ? 'pending'
          : 'missing'
  const evidenceRefs = [
    { type: 'support_debug_packet', id: item.support_packet_id },
    ...(captureSessionId ? [{ type: 'capture_session', id: captureSessionId }] : []),
  ]
  const checks: IssueDiagnosticManifest['checks'] = [
    {
      key: 'support_packet',
      label: 'Support packet',
      status: support ? 'ok' : 'error',
      detail: support ? item.support_packet_id : 'No live support packet summary is attached.',
    },
    {
      key: 'capture_session',
      label: 'Capture session',
      status: captureSessionId ? 'ok' : 'missing',
      detail: captureSessionId ?? 'This issue was not filed with capture media.',
    },
    {
      key: 'artifact_analysis',
      label: 'Artifact analysis',
      status:
        artifactAnalysis === 'ready'
          ? 'ok'
          : artifactAnalysis === 'pending'
            ? 'pending'
            : artifactAnalysis === 'failed'
              ? 'error'
              : captureSessionId
                ? 'warn'
                : 'missing',
      detail:
        analysisStatus ?? (captureSessionId ? 'Capture exists, but analyzer readiness has not been recorded.' : null),
    },
    {
      key: 'timeline',
      label: 'Handoff timeline',
      status: detail.events_total > 0 ? 'ok' : 'warn',
      detail: `${detail.events_total} event${detail.events_total === 1 ? '' : 's'} recorded`,
    },
  ]
  const operatorNextStep = !support
    ? 'repair_support_packet'
    : artifactAnalysis === 'pending'
      ? 'wait_for_capture_analysis'
      : artifactAnalysis === 'failed'
        ? 'repair_capture_analysis'
        : item.status === 'review_ready'
          ? 'review_agent_output'
          : captureSessionId
            ? 'triage_capture_context'
            : 'triage_redacted_context'
  return {
    schema: 'sitelayer.diagnostic_manifest.v1',
    generated_at: new Date().toISOString(),
    subject: {
      kind: 'app_issue',
      issue_id: item.id,
      support_packet_id: item.support_packet_id,
      capture_session_id: captureSessionId,
    },
    operator_next_step: operatorNextStep,
    needs_attention: checks.some(
      (check) => check.status === 'error' || check.status === 'pending' || check.status === 'warn',
    ),
    capture_readiness: {
      support_packet: support ? 'ready' : 'missing',
      capture_session: captureSessionId ? 'ready' : 'not_captured',
      artifact_analysis: artifactAnalysis,
    },
    evidence_refs: evidenceRefs,
    worker_health_refs: [
      { kind: 'dispatch_lane', path: '/api/admin/dispatch-lanes#capture_artifact_analysis' },
      { kind: 'job_health', path: '/api/admin/jobs#capture_artifact_analysis' },
    ],
    checks,
  }
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
    diagnostic_manifest: buildIssueDiagnosticManifest(detail),
    events: detail.events,
    events_pagination: {
      limit: detail.events_limit,
      offset: detail.events_offset,
      total: detail.events_total,
      has_more: detail.events_truncated,
    },
  })
}

function stringArrayField(serverContext: Record<string, unknown>, key: string, limit: number): string[] {
  const raw = serverContext[key]
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
    if (out.length >= limit) break
  }
  return out
}

/** The per-anchor event_refs the finalize path PINNED into server_context.anchors.
 * Escalation enriches around these — it never re-derives a transition. */
function pinnedEventRefs(serverContext: Record<string, unknown>, limit: number): string[] {
  const raw = serverContext.anchors
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const ref = (entry as { event_ref?: unknown }).event_ref
    if (typeof ref !== 'string') continue
    const trimmed = ref.trim()
    if (!trimmed || out.includes(trimmed)) continue
    out.push(trimmed)
    if (out.length >= limit) break
  }
  return out
}

type IssuePacketRow = {
  support_packet_id: string
  capture_session_id: string | null
  server_context: Record<string, unknown>
}

/**
 * STEP6 — POST /api/issues/:workItemId/escalate.
 *
 * "Go deeper" on a filed app-issue: re-run the tier-2/3 external enrichment
 * (Sentry trace spans + Axiom log lines) around the trace_id / request_id /
 * event_ref the support packet ALREADY PINNED at finalize. It NEVER re-derives
 * the ids — it reads them straight off the packet's server_context — so an
 * escalation is a bounded, auditable re-fetch, not a fresh correlation pass.
 *
 * Gated on the PLATFORM capability `app_issue.triage` (the WRITE half; view is
 * insufficient). Each external pull is recorded as a `support_packet_access_log`
 * row (access_type='escalate', migration 010 widens the CHECK) so the per-issue
 * cost ledger can show exactly which evidence the operator paid to fetch. The
 * assembled bundle is also stamped as an `agent.message_received` handoff event
 * on the work item so the triage thread shows the deeper context inline.
 */
async function escalateIssue(ctx: IssueRouteCtx, id: string) {
  if (!(await ctx.requireCapability(APP_ISSUE_TRIAGE))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid issue id' })
    return
  }
  const parsed = parseJsonBody(IssueEscalateBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return
  }
  const tierRaw = parsed.value.tier
  const tier: EscalationTier =
    tierRaw === undefined || tierRaw === null
      ? '2'
      : (ESCALATION_TIERS as readonly string[]).includes(String(tierRaw))
        ? (String(tierRaw) as EscalationTier)
        : ('invalid' as EscalationTier)
  if ((tier as string) === 'invalid') {
    ctx.sendJson(400, { error: `tier must be one of ${ESCALATION_TIERS.join(', ')}` })
    return
  }

  // Load the issue (pinned to app_issue) + its support packet server_context.
  // 404 the same way for a missing row AND a field_request row so a non-app_issue
  // id never confirms its existence through this platform surface.
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id, { eventsLimit: 1 })
  if (!detail || detail.work_item.domain !== 'app_issue') {
    ctx.sendJson(404, { error: 'issue not found' })
    return
  }
  const packetRow = await withCompanyClient(ctx.company.id, (c) =>
    c.query<IssuePacketRow>(
      `select id as support_packet_id, capture_session_id::text as capture_session_id, server_context
         from support_debug_packets
        where company_id = $1 and id = $2 and (expires_at is null or expires_at > now())
        limit 1`,
      [ctx.company.id, detail.work_item.support_packet_id],
    ),
  )
  const packet = packetRow.rows[0]
  if (!packet) {
    ctx.sendJson(409, { error: 'issue has no live support packet to escalate' })
    return
  }

  // PINNED ids — read off server_context, never re-derived.
  const serverContext = (packet.server_context ?? {}) as Record<string, unknown>
  const traceIds = stringArrayField(serverContext, 'trace_ids', 8)
  const requestIds = stringArrayField(serverContext, 'request_ids', 12)
  const eventRefs = pinnedEventRefs(serverContext, 10)
  const captureSessionId = packet.capture_session_id

  // Run the SAME enrichment the bundle worker runs, around the pinned ids. One
  // bundle per pinned event_ref (so a per-anchor escalation re-fetches around
  // each transition); when no anchor was pinned, one bundle around the
  // trace/request set. assembleDebugBundle owns the env-gated Sentry+Axiom
  // fetches (8s timeout, silent no-op when unset).
  const pulls = eventRefs.length > 0 ? eventRefs : [null]
  const bundles: DebugBundle[] = []
  for (const eventRef of pulls) {
    const bundle = await assembleDebugBundle({
      support_packet_id: packet.support_packet_id,
      capture_session_id: captureSessionId,
      trace_ids: traceIds,
      request_ids: requestIds,
      event_ref: eventRef,
      tier,
    })
    bundles.push(bundle)
  }

  const requestContext = getRequestContext()
  // Record one access-log row PER pull (the cost ledger), then stamp a single
  // handoff event carrying the assembled bundles, all in one tx.
  await withMutationTx(ctx.company.id, async (c) => {
    for (const bundle of bundles) {
      await c.query(
        `insert into support_packet_access_log (
           company_id, support_packet_id, actor_user_id, access_type,
           route, request_id, metadata
         ) values ($1, $2, $3, 'escalate', $4, $5, $6::jsonb)`,
        [
          ctx.company.id,
          packet.support_packet_id,
          ctx.identity.userId,
          requestContext?.route ?? null,
          requestContext?.requestId ?? null,
          JSON.stringify(
            sanitizeSupportJson({
              tier,
              work_item_id: id,
              event_ref: bundle.event_ref,
              trace_ids: bundle.trace_ids,
              request_ids: bundle.request_ids,
              sentry_status: bundle.sentry.status,
              axiom_status: bundle.axiom.status,
            }),
          ),
        ],
      )
    }
    await appendContextHandoffEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType: 'agent.message_received',
      actorKind: 'system',
      actorUserId: ctx.identity.userId,
      payload: sanitizeSupportJson({
        escalation_tier: tier,
        support_packet_id: packet.support_packet_id,
        capture_session_id: captureSessionId,
        bundle_count: bundles.length,
        bundles,
      }),
      metadata: {
        source: 'issue_escalate',
        escalation_tier: tier,
        pulls: bundles.length,
      },
      captureSessionId,
      buildSha: ctx.buildSha,
    })
  })

  ctx.sendJson(200, {
    work_item_id: id,
    tier,
    support_packet_id: packet.support_packet_id,
    capture_session_id: captureSessionId,
    pulls: bundles.length,
    bundles,
  })
}

/**
 * POST /api/issues/:workItemId/events — the app_issue TRIAGE write surface.
 *
 * Gated on the PLATFORM capability `app_issue.triage` (the same boundary the
 * escalate endpoint uses — unreachable via a company role / dev act-as /
 * header fallback) and pinned to the app_issue domain: a field_request id
 * 404s identically to a missing row, so the two domains never bleed.
 *
 * Routes every transition through updateContextWorkItemWithEventTx so the
 * status change and its context_handoff_events row land atomically — the same
 * helper the field-request lifecycle uses, never a parallel event system.
 */
async function triageIssue(ctx: IssueRouteCtx, id: string) {
  if (!(await ctx.requireCapability(APP_ISSUE_TRIAGE))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid issue id' })
    return
  }
  const parsed = parseJsonBody(IssueTriageBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return
  }
  const action: IssueTriageAction = parsed.value.action
  const message = parsed.value.message?.trim() ? parsed.value.message.trim() : null
  const idempotencyKey = parsed.value.idempotency_key?.trim() ? parsed.value.idempotency_key.trim() : null

  // 404 the same way for a missing row AND a field_request row: a non-app_issue
  // id must never confirm its existence through this platform surface.
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id, { eventsLimit: 1 })
  if (!detail || detail.work_item.domain !== 'app_issue') {
    ctx.sendJson(404, { error: 'issue not found' })
    return
  }

  const decidedAt = new Date().toISOString()
  const result = await withMutationTx(ctx.company.id, async (c) => {
    // Re-check under the row lock so a concurrent transition cannot slip a
    // terminal state past the gate between read and write.
    const locked = await c.query<{ status: WorkItemStatus; lane: WorkItemLane }>(
      `select status, lane
         from context_work_items
        where company_id = $1 and id = $2
        for update`,
      [ctx.company.id, id],
    )
    const current = locked.rows[0]
    if (!current) return { kind: 'not_found' as const }
    const allowedFrom = action === 'accept' ? ACCEPT_FROM_STATUSES : CLOSE_FROM_STATUSES
    if (!allowedFrom.includes(current.status)) {
      return { kind: 'conflict' as const, status: current.status }
    }
    const next: {
      eventType: HandoffEventType
      status: WorkItemStatus
      lane: WorkItemLane
      resolvedAt?: string
    } =
      action === 'accept'
        ? { eventType: 'work_item.status_changed', status: 'triaged', lane: 'triage' }
        : action === 'resolve'
          ? { eventType: 'resolution.accepted', status: 'resolved', lane: 'done', resolvedAt: decidedAt }
          : { eventType: 'work_item.status_changed', status: 'wont_do', lane: 'done', resolvedAt: decidedAt }
    const updated = await updateContextWorkItemWithEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType: next.eventType,
      actorKind: 'user',
      actorUserId: ctx.identity.userId,
      payload: {
        action,
        message,
        previous_status: current.status,
        previous_lane: current.lane,
        status: next.status,
        lane: next.lane,
      },
      metadata: {
        source: 'issue_triage',
        action,
        evidence_refs: [{ type: 'support_debug_packet', id: detail.work_item.support_packet_id }],
      },
      status: next.status,
      lane: next.lane,
      ...(next.resolvedAt !== undefined ? { resolvedAt: next.resolvedAt } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
    return updated ? { kind: 'ok' as const, updated } : { kind: 'not_found' as const }
  })
  if (result.kind === 'not_found') {
    ctx.sendJson(404, { error: 'issue not found' })
    return
  }
  if (result.kind === 'conflict') {
    ctx.sendJson(409, { error: `issue is ${result.status} and cannot ${action}` })
    return
  }
  ctx.sendJson(201, {
    issue: issueResponse(result.updated.workItem),
    event: result.updated.event,
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

  const escalateMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/escalate$/)
  if (escalateMatch && req.method === 'POST') {
    await escalateIssue(ctx, decodeURIComponent(escalateMatch[1]!))
    return true
  }

  const triageMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/events$/)
  if (triageMatch && req.method === 'POST') {
    await triageIssue(ctx, decodeURIComponent(triageMatch[1]!))
    return true
  }

  const detailMatch = url.pathname.match(/^\/api\/issues\/([^/]+)$/)
  if (detailMatch && req.method === 'GET') {
    await getIssue(ctx, decodeURIComponent(detailMatch[1]!), url)
    return true
  }

  return false
}

/**
 * Self-registered dispatch descriptor for the `issues` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const issuesRouteDescriptor: DispatchRouteDescriptor = {
  name: 'issues',
  order: 220,
  handle: ({ req, url, pool, company, identity, ctx, readBody, sendJson }) =>
    handleIssueRoutes(req, url, {
      pool,
      company,
      identity,
      buildSha: getBuildSha(),
      requireCapability: ctx.requireCapability,
      readBody,
      sendJson,
    }),
}
