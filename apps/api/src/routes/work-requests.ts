import type http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Capability } from '@sitelayer/domain'
import type { Identity } from '../auth.js'
import { buildPaginationMeta, isValidUuid, parsePagination, PAGINATION_MAX_LIMIT } from '../http-utils.js'
import { getRequestContext } from '@sitelayer/logger'
import { currentTraceHeaders, type LedgerExecutor, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { safeTokenEqual } from '../debug-trace.js'
import { observeContextHandoff } from '../metrics.js'
import {
  AGENT_CALLBACK_EVENT_TYPES,
  AgentCallbackBodySchema,
  CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION,
  HANDOFF_EVENT_TYPES,
  WORK_ITEM_LANES,
  WORK_ITEM_SEVERITIES,
  WORK_ITEM_STATUSES,
  appendContextHandoffEventTx,
  createContextWorkItemWithDedupTx,
  getContextWorkItemWithEvents,
  listContextWorkItems,
  updateContextWorkItemWithEventTx,
  type ContextHandoffEventRow,
  type ContextWorkItemDetail,
  type ContextWorkItemRow,
  type HandoffEventType,
  type WorkItemDomain,
  type WorkItemLane,
  type WorkItemSeverity,
  type WorkItemStatus,
} from '../context-handoff.js'
import {
  buildSupportServerContext,
  collectEntityRefs,
  insertSupportPacket,
  readClientRoute,
  supportJsonRecord,
  type JsonRecord,
} from './support-packets.js'
import type { WorkRequest as ProjectkitWorkRequest } from '@operator/projectkit'
import {
  buildCallbackSnapshot,
  buildConcernSnapshot,
  buildWorkRequestSnapshot,
  isTerminalCallbackStatus,
  workItemStatusToCallbackStatus,
} from '@sitelayer/projectkit-bridge'

export type WorkRequestRouteCtx = {
  pool: Pool
  company: ActiveCompany
  identity: Identity
  tier: string
  buildSha: string
  /**
   * Capability gate for the field_request.* domain (migration 009). This board
   * is the COMPANY-scope field-request feature, so every gate here is a
   * field_request.* capability resolved on the company boundary (role defaults
   * ∪ custom_role_grants). Replaces the old CREATE_ROLES / LIST_ROLES /
   * TRIAGE_ROLES allowlists — the foundation's DEFAULT_COMPANY_CAPABILITIES map
   * reproduces them exactly (create/view → all 5 roles, triage/resolve →
   * admin/foreman/office/bookkeeper), so behavior is preserved. Returns true
   * when held; on false it has already sent the 403 and the handler should
   * return. See apps/api/src/capability.ts.
   */
  requireCapability: (capability: Capability) => Promise<boolean>
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

// This board is the field_request domain only — app-issues (capture-born,
// platform scope) live on the separate /issues surface gated by app_issue.*.
// Pin the row filter once so the list/board/detail reads can't drift.
const FIELD_REQUEST_DOMAIN: WorkItemDomain = 'field_request'
const MAX_TITLE_LENGTH = 240
const MAX_SUMMARY_LENGTH = 4000
const MAX_STALE_SWEEP_LIMIT = 50
const DEFAULT_CALLBACK_TOKEN_TTL_HOURS = 72
const DEFAULT_DISPATCH_MAX_PENDING = 50
const DEFAULT_DISPATCH_MAX_FAILED = 25
const DISPATCH_MUTATION_TYPE = 'dispatch_mesh_work_request'
const HEALTH_WORK_STATUSES = ['agent_running', 'review_ready', 'review_stale', 'proposal_expired'] as const
const HEALTH_DISPATCH_STATUSES = ['pending', 'processing', 'failed', 'dead'] as const
const HANDOFF_PACKET_AUDIENCES = ['operator', 'mesh', 'collaborator', 'github'] as const

type HandoffPacketAudience = (typeof HANDOFF_PACKET_AUDIENCES)[number]
type DiagnosticCheckStatus = 'ok' | 'pending' | 'warn' | 'error' | 'missing'

type DispatchOutboxSummary = {
  id: string
  mutation_type: typeof DISPATCH_MUTATION_TYPE
  idempotency_key: string
  status: string
  capture_session_id: string | null
  attempt_count: number
  next_attempt_at: string | null
  applied_at: string | null
  error: string | null
}

type DispatchBackpressureState = {
  pending_count: number
  failed_count: number
  oldest_pending_age_seconds: number | null
  pending_limit: number
  failed_limit: number
}

type DispatchPayload = {
  payload_version: typeof CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION
  work_item_id: string
  support_packet_id: string
  capture_session_id: string | null
  title: string
  summary: string | null
  route: string | null
  entity_type: string | null
  entity_id: string | null
  status: WorkItemStatus
  lane: WorkItemLane
  reversibility_window_seconds: number
  support_packet: unknown
  work_request_brief: WorkRequestBrief
  agent_brief_markdown: string
  callback: {
    path: string
    url: string | null
    token: string
    token_type: 'scoped_bearer'
    expires_at: string
  }
  /**
   * ADDITIVE projectkit seam: a first-class @operator/projectkit `WorkRequest`
   * (with the originating `Concern` embedded in its payload) carried NEXT TO
   * the existing context_work_dispatch.v1 fields — it does not replace them. A
   * subscriber other than mesh can read this to dispatch + call back using only
   * the published projectkit shapes (the One-Line Boundary Test). Validated by
   * apps/api/src/projectkit-concern.test.ts via validateWorkRequest /
   * validateConcern.
   */
  dispatch_request: ProjectkitWorkRequest
}

type WorkRequestBriefTimelineEntry = {
  event_type: string
  actor_kind: string
  actor_user_id: string | null
  actor_ref: string | null
  source_system: string
  recorded_at: string
  message: string | null
  url: string | null
  status: string | null
  lane: string | null
  artifacts_count: number | null
  payload_keys: string[]
}

type WorkRequestDiagnosticManifest = {
  schema: 'sitelayer.work_request_diagnostic_manifest.v1'
  generated_at: string
  work_item_id: string
  capture_session_id: string | null
  operator_next_step: string
  needs_attention: boolean
  readiness: {
    support_packet: 'ready' | 'missing'
    capture_session: 'ready' | 'not_captured'
    artifact_analysis: 'ready' | 'pending' | 'failed' | 'missing'
    dispatch: string
    callback: 'available_after_dispatch' | 'scoped_callback_ready'
  }
  source: {
    route: string | null
    request_id: string | null
    build_sha: string | null
    entity_type: string | null
    entity_id: string | null
  }
  evidence: {
    refs: Array<{ type: string; id: string }>
    timeline_total: number
    timeline_truncated: boolean
    artifact_analysis: {
      status: string | null
      eligible_artifact_count: number | null
      processed_artifact_count: number | null
      pending_artifact_count: number | null
      audio_mode: string | null
      video_mode: string | null
      updated_at: string | null
    }
  }
  checks: Array<{
    key: string
    label: string
    status: DiagnosticCheckStatus
    detail: string | null
  }>
}

type WorkRequestBrief = {
  schema: 'sitelayer.work_request_brief.v1'
  generated_at: string
  work_item: Omit<ReturnType<typeof workItemResponse>, 'metadata'> & { metadata_keys: string[] }
  state: {
    status: WorkItemStatus
    lane: WorkItemLane
    severity: WorkItemSeverity | null
    reversibility_window_seconds: number
    expires_at: string | null
    next_action: string
  }
  support_packet: ContextWorkItemDetail['work_item']['support_packet']
  diagnostics: {
    work_item_path: string
    support_packet_id: string
    request_id: string | null
    build_sha: string | null
    route: string | null
    entity_type: string | null
    entity_id: string | null
    capture_session_id: string | null
    dispatch_outbox_status: string | null
    evidence_refs: Array<{ type: string; id: string }>
  }
  diagnostic_manifest: WorkRequestDiagnosticManifest
  timeline: WorkRequestBriefTimelineEntry[]
  timeline_total: number
  timeline_truncated: boolean
  callback?: {
    path: string
    url: string | null
    token_type: 'scoped_bearer'
    expires_at: string
  }
  agent_brief_markdown: string
}

type WorkRequestHandoffPacket = {
  schema: 'sitelayer.context_handoff_packet.v1'
  generated_at: string
  audience: HandoffPacketAudience
  redaction_version: 'context-handoff-v1'
  source: {
    system: 'sitelayer'
    company_id: string
    work_item_id: string
    support_packet_id: string
    public_path: string
  }
  permissions: {
    intended_use: string
    raw_support_packet_included: boolean
    callback_token_included: false
    callback_available_after_dispatch: boolean
  }
  state: WorkRequestBrief['state']
  work_item: WorkRequestBrief['work_item']
  diagnostics: WorkRequestBrief['diagnostics']
  diagnostic_manifest: WorkRequestBrief['diagnostic_manifest']
  support_packet: ContextWorkItemDetail['work_item']['support_packet'] | null
  evidence_refs: WorkRequestBrief['diagnostics']['evidence_refs']
  timeline: WorkRequestBrief['timeline']
  timeline_total: number
  timeline_truncated: boolean
  agent_brief_markdown: string
  callback?: WorkRequestBrief['callback']
  packet_sha256: string
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...[truncated]` : trimmed
}

function requiredText(value: unknown, maxLength: number): { ok: true; value: string } | { ok: false } {
  const text = optionalText(value, maxLength)
  if (!text) return { ok: false }
  return { ok: true, value: text }
}

function parseAllowed<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (typeof value !== 'string') return null
  return (allowed as readonly string[]).includes(value) ? (value as T[number]) : null
}

function headerText(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function bearerToken(req: http.IncomingMessage): string {
  const authorization = headerText(req.headers.authorization)
  return authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
}

function workRequestDispatchUrl(): string {
  return (
    process.env.PROJECTKIT_WORK_REQUEST_DISPATCH_URL?.trim() || process.env.MESH_WORK_REQUEST_DISPATCH_URL?.trim() || ''
  )
}

function requireWorkRequestDispatchConfigured(ctx: WorkRequestRouteCtx): boolean {
  if (workRequestDispatchUrl()) return true
  ctx.sendJson(503, { error: 'projectkit dispatch is not configured' })
  return false
}

function newCallbackToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashCallbackToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function callbackTokenTtlHours(): number {
  return Math.min(
    720,
    Math.max(1, readPositiveNumberEnv('WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS', DEFAULT_CALLBACK_TOKEN_TTL_HOURS)),
  )
}

function dispatchMaxPending(): number {
  return Math.min(
    1000,
    Math.max(1, readPositiveNumberEnv('WORK_REQUEST_DISPATCH_MAX_PENDING', DEFAULT_DISPATCH_MAX_PENDING)),
  )
}

function dispatchMaxFailed(): number {
  return Math.min(
    1000,
    Math.max(1, readPositiveNumberEnv('WORK_REQUEST_DISPATCH_MAX_FAILED', DEFAULT_DISPATCH_MAX_FAILED)),
  )
}

function meshBearerToken(): string | null {
  return (
    optionalText(process.env.PROJECTKIT_WORK_REQUEST_DISPATCH_TOKEN, 10_000) ??
    optionalText(process.env.MESH_WORK_REQUEST_DISPATCH_TOKEN, 10_000) ??
    optionalText(process.env.MESH_API_TOKEN, 10_000) ??
    null
  )
}

function meshTaskCancelUrl(meshTaskId: string): string | null {
  const meshApi = process.env.MESH_API_URL?.trim() || ''
  if (meshApi) return `${meshApi.replace(/\/+$/, '')}/api/orchestrate/tasks/${encodeURIComponent(meshTaskId)}`

  const dispatchUrl = workRequestDispatchUrl()
  if (!dispatchUrl) return null
  return `${dispatchUrl.replace(/\/+$/, '')}/${encodeURIComponent(meshTaskId)}`
}

function callbackTokenExpiresAt(now = Date.now()): string {
  return new Date(now + callbackTokenTtlHours() * 60 * 60 * 1000).toISOString()
}

function normalizePublicBaseUrl(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function publicBaseUrlFromRequest(req: http.IncomingMessage): string | null {
  const configured = normalizePublicBaseUrl(
    process.env.SITELAYER_PUBLIC_BASE ?? process.env.PUBLIC_BASE_URL ?? process.env.APP_PUBLIC_BASE_URL ?? null,
  )
  if (configured) return configured
  const host = headerText(req.headers['x-forwarded-host']) ?? headerText(req.headers.host)
  if (!host) return null
  const proto =
    headerText(req.headers['x-forwarded-proto']) ?? (process.env.NODE_ENV === 'production' ? 'https' : 'http')
  return normalizePublicBaseUrl(`${proto}://${host}`)
}

function callbackUrlForPath(req: http.IncomingMessage, path: string): string | null {
  const base = publicBaseUrlFromRequest(req)
  return base ? `${base}${path}` : null
}

function buildClientPacket(body: Record<string, unknown>): JsonRecord {
  return supportJsonRecord(body.client ?? { source: 'work_request', body })
}

function firstEntityRef(client: JsonRecord): { entityType: string | null; entityId: string | null } {
  const ref = collectEntityRefs(client, 1)[0]
  return {
    entityType: ref?.entity_type ?? null,
    entityId: ref?.entity_id ?? null,
  }
}

/**
 * This surface is the field_request domain ONLY. A null detail OR an app_issue
 * row (capture-born, platform scope, lives on the /issues surface) both read as
 * "not found" here, so an app-issue id is never observable on the field-request
 * board — the two domains cannot bleed across this boundary.
 */
function isFieldRequestDetail(detail: ContextWorkItemDetail | null): detail is ContextWorkItemDetail {
  return detail !== null && detail.work_item.domain === FIELD_REQUEST_DOMAIN
}

function canReadWorkItem(role: CompanyRole, userId: string, row: ContextWorkItemRow): boolean {
  if (role === 'member') return row.created_by_user_id === userId || row.assignee_user_id === userId
  return true
}

function roleScopedCreatedBy(role: CompanyRole, userId: string, requested: string | null): string | null {
  if (role === 'member') return userId
  return requested
}

function workItemResponse(row: ContextWorkItemRow) {
  return {
    id: row.id,
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
    metadata: row.metadata,
  }
}

function workItemBriefResponse(row: ContextWorkItemRow): WorkRequestBrief['work_item'] {
  const { metadata, ...rest } = workItemResponse(row)
  return {
    ...rest,
    metadata_keys: Object.keys(metadata ?? {})
      .sort()
      .slice(0, 40),
  }
}

type WorkItemApiResponse = ReturnType<typeof workItemResponse>
type WorkRequestBoardGroupBy = 'lane' | 'status_group'
type WorkRequestBoardColumn = {
  id: string
  title: string
  lane: WorkItemLane | null
  statuses: WorkItemStatus[]
  work_items: WorkItemApiResponse[]
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

function titleForLane(lane: WorkItemLane): string {
  if (lane === 'triage') return 'Triage'
  if (lane === 'human') return 'Human'
  if (lane === 'agent') return 'Agent'
  if (lane === 'both') return 'Review'
  return 'Done'
}

function defaultLaneForStatus(status: WorkItemStatus): WorkItemLane {
  if (status === 'human_assigned') return 'human'
  if (status === 'agent_running') return 'agent'
  if (status === 'review_ready' || status === 'review_stale' || status === 'proposal_expired') return 'both'
  if (status === 'resolved' || status === 'wont_do' || status === 'reversed') return 'done'
  return 'triage'
}

function buildWorkRequestBoardColumns(
  rows: WorkItemApiResponse[],
  groupBy: WorkRequestBoardGroupBy,
): WorkRequestBoardColumn[] {
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

function timelineEntry(event: ContextHandoffEventRow): WorkRequestBriefTimelineEntry {
  const artifacts = Array.isArray(event.payload.artifacts) ? event.payload.artifacts.length : null
  return {
    event_type: event.event_type,
    actor_kind: event.actor_kind,
    actor_user_id: event.actor_user_id,
    actor_ref: event.actor_ref,
    source_system: event.source_system,
    recorded_at: event.recorded_at,
    message: optionalText(event.payload.message ?? event.payload.body, 500),
    url: optionalText(event.payload.url, 1000),
    status: optionalText(event.payload.status, 100),
    lane: optionalText(event.payload.lane, 100),
    artifacts_count: artifacts,
    payload_keys: Object.keys(event.payload).sort().slice(0, 40),
  }
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function numberFromMetadata(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function stringFromMetadata(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function buildDiagnosticManifest(input: {
  detail: ContextWorkItemDetail
  dispatchOutbox: DispatchOutboxSummary | null
  evidenceRefs: Array<{ type: string; id: string }>
  timelineTotal: number
  timelineTruncated: boolean
  nextAction: string
  generatedAt: string
}): WorkRequestDiagnosticManifest {
  const item = input.detail.work_item
  const support = item.support_packet
  const captureSessionId = item.capture_session_id
  const analysis = asJsonObject(item.metadata?.capture_artifact_analysis)
  const analysisStatus = stringFromMetadata(analysis?.status)
  const artifactAnalysisStatus =
    analysisStatus === 'ready'
      ? 'ready'
      : analysisStatus === 'failed' || analysisStatus === 'error'
        ? 'failed'
        : analysisStatus === 'pending' || analysisStatus === 'processing'
          ? 'pending'
          : captureSessionId
            ? 'missing'
            : 'missing'
  const dispatchState = input.dispatchOutbox?.status ?? 'not_queued'
  const checks: WorkRequestDiagnosticManifest['checks'] = [
    {
      key: 'support_packet',
      label: 'Support packet',
      status: support ? 'ok' : 'error',
      detail: support ? support.id : 'No support packet is attached to this work item.',
    },
    {
      key: 'capture_session',
      label: 'Capture session',
      status: captureSessionId ? 'ok' : 'missing',
      detail: captureSessionId ?? 'No screen/audio/video capture session is attached.',
    },
    {
      key: 'artifact_analysis',
      label: 'Artifact analysis',
      status:
        artifactAnalysisStatus === 'ready'
          ? 'ok'
          : artifactAnalysisStatus === 'pending'
            ? 'pending'
            : artifactAnalysisStatus === 'failed'
              ? 'error'
              : captureSessionId
                ? 'warn'
                : 'missing',
      detail:
        analysisStatus ?? (captureSessionId ? 'Capture exists, but analyzer readiness has not been recorded.' : null),
    },
    {
      key: 'dispatch',
      label: 'Agent dispatch',
      status:
        dispatchState === 'applied'
          ? 'ok'
          : dispatchState === 'pending' || dispatchState === 'processing'
            ? 'pending'
            : dispatchState === 'failed' || dispatchState === 'dead'
              ? 'error'
              : input.nextAction === 'dispatch_agent'
                ? 'warn'
                : 'missing',
      detail: input.dispatchOutbox
        ? `${input.dispatchOutbox.status}, ${input.dispatchOutbox.attempt_count} attempt${
            input.dispatchOutbox.attempt_count === 1 ? '' : 's'
          }`
        : 'No dispatch outbox row exists yet.',
    },
    {
      key: 'timeline',
      label: 'Handoff timeline',
      status: input.timelineTotal > 0 ? 'ok' : 'warn',
      detail: `${input.timelineTotal} event${input.timelineTotal === 1 ? '' : 's'} recorded`,
    },
  ]
  const operatorNextStep = !support
    ? 'repair_support_packet'
    : artifactAnalysisStatus === 'pending'
      ? 'wait_for_capture_analysis'
      : artifactAnalysisStatus === 'failed'
        ? 'repair_capture_analysis'
        : dispatchState === 'failed' || dispatchState === 'dead'
          ? 'retry_dispatch'
          : item.status === 'review_ready'
            ? 'review_agent_output'
            : input.nextAction
  return {
    schema: 'sitelayer.work_request_diagnostic_manifest.v1',
    generated_at: input.generatedAt,
    work_item_id: item.id,
    capture_session_id: captureSessionId,
    operator_next_step: operatorNextStep,
    needs_attention: checks.some(
      (check) => check.status === 'error' || check.status === 'pending' || check.status === 'warn',
    ),
    readiness: {
      support_packet: support ? 'ready' : 'missing',
      capture_session: captureSessionId ? 'ready' : 'not_captured',
      artifact_analysis: artifactAnalysisStatus,
      dispatch: dispatchState,
      callback: input.dispatchOutbox ? 'scoped_callback_ready' : 'available_after_dispatch',
    },
    source: {
      route: item.route ?? support?.route ?? null,
      request_id: support?.request_id ?? null,
      build_sha: support?.build_sha ?? null,
      entity_type: item.entity_type,
      entity_id: item.entity_id,
    },
    evidence: {
      refs: input.evidenceRefs,
      timeline_total: input.timelineTotal,
      timeline_truncated: input.timelineTruncated,
      artifact_analysis: {
        status: analysisStatus,
        eligible_artifact_count: numberFromMetadata(analysis?.eligible_artifact_count),
        processed_artifact_count: numberFromMetadata(analysis?.processed_artifact_count),
        pending_artifact_count: numberFromMetadata(analysis?.pending_artifact_count),
        audio_mode: stringFromMetadata(analysis?.audio_mode),
        video_mode: stringFromMetadata(analysis?.video_mode),
        updated_at: stringFromMetadata(analysis?.updated_at),
      },
    },
    checks,
  }
}

function nextActionForWorkItem(row: ContextWorkItemRow, outbox: DispatchOutboxSummary | null): string {
  if (row.status === 'resolved') return 'resolved'
  if (row.status === 'wont_do') return 'closed_without_action'
  if (row.status === 'reversed') return 'reversed'
  if (outbox?.status === 'failed' || outbox?.status === 'dead') return 'retry_or_reassign_dispatch'
  if (row.status === 'review_ready') return 'human_review'
  if (row.status === 'review_stale') return 'refresh_review_or_close'
  if (row.status === 'proposal_expired') return 'redispatch_or_assign_human'
  if (row.status === 'agent_running') return 'monitor_agent_callback'
  if (row.status === 'human_assigned') return 'assigned_human_followup'
  return row.lane === 'agent' || row.lane === 'both' ? 'dispatch_agent' : 'triage'
}

function buildAgentBriefMarkdown(input: {
  detail: ContextWorkItemDetail
  dispatchOutbox: DispatchOutboxSummary | null
  timeline: WorkRequestBriefTimelineEntry[]
  callback?: WorkRequestBrief['callback']
  nextAction: string
  diagnosticManifest: WorkRequestDiagnosticManifest
}): string {
  const item = input.detail.work_item
  const support = item.support_packet
  const lines = [
    `# Sitelayer Work Request`,
    '',
    `Work item: ${item.id}`,
    `Title: ${item.title}`,
    `Status: ${item.status}`,
    `Lane: ${item.lane}`,
    `Severity: ${item.severity ?? 'normal'}`,
    `Next action: ${input.nextAction}`,
  ]
  if (item.summary) lines.push('', 'Summary:', item.summary)
  lines.push(
    '',
    'Context:',
    `- Route: ${item.route ?? support?.route ?? 'unknown'}`,
    `- Entity: ${item.entity_type ?? 'unknown'}/${item.entity_id ?? 'unknown'}`,
    `- Support packet: ${item.support_packet_id}`,
    `- Capture session: ${item.capture_session_id ?? 'none'}`,
    `- Request ID: ${support?.request_id ?? 'unknown'}`,
    `- Build: ${support?.build_sha ?? 'unknown'}`,
    `- Reversibility expires: ${item.expires_at ?? 'unknown'}`,
    `- Dispatch outbox: ${input.dispatchOutbox?.status ?? 'none'}`,
    `- Diagnostic next step: ${input.diagnosticManifest.operator_next_step}`,
  )
  if (input.callback) {
    lines.push(`- Callback: ${input.callback.url ?? input.callback.path} (${input.callback.token_type})`)
  }
  lines.push('', 'Diagnostic checks:')
  for (const check of input.diagnosticManifest.checks) {
    lines.push(`- ${check.label}: ${check.status}${check.detail ? ` (${check.detail})` : ''}`)
  }
  lines.push('', 'Recent timeline:')
  if (input.timeline.length === 0) {
    lines.push('- no handoff events captured')
  } else {
    for (const event of input.timeline) {
      const detail = event.message ?? event.url ?? [event.status, event.lane].filter(Boolean).join('/') ?? ''
      lines.push(`- ${event.recorded_at} ${event.event_type} by ${event.actor_kind}${detail ? `: ${detail}` : ''}`)
    }
  }
  lines.push(
    '',
    'Agent instructions:',
    '- Treat this brief as the safe handoff surface.',
    '- Use the support_packet_id as an evidence reference; do not require raw support packet access unless needed.',
    '- Report progress through the callback when provided.',
  )
  return lines.join('\n')
}

function buildWorkRequestBrief(
  detail: ContextWorkItemDetail,
  dispatchOutbox: DispatchOutboxSummary | null,
  opts: { callback?: WorkRequestBrief['callback'] } = {},
): WorkRequestBrief {
  const timelineEvents = detail.events.slice(-12).map(timelineEntry)
  const nextAction = nextActionForWorkItem(detail.work_item, dispatchOutbox)
  const generatedAt = new Date().toISOString()
  const evidenceRefs = [
    { type: 'support_debug_packet', id: detail.work_item.support_packet_id },
    ...(detail.work_item.capture_session_id
      ? [{ type: 'capture_session', id: detail.work_item.capture_session_id }]
      : []),
  ]
  const timelineTruncated = detail.events_total > timelineEvents.length
  const diagnosticManifest = buildDiagnosticManifest({
    detail,
    dispatchOutbox,
    evidenceRefs,
    timelineTotal: detail.events_total,
    timelineTruncated,
    nextAction,
    generatedAt,
  })
  const partial = {
    schema: 'sitelayer.work_request_brief.v1' as const,
    generated_at: generatedAt,
    work_item: workItemBriefResponse(detail.work_item),
    state: {
      status: detail.work_item.status,
      lane: detail.work_item.lane,
      severity: detail.work_item.severity,
      reversibility_window_seconds: Number(detail.work_item.reversibility_window_seconds),
      expires_at: detail.work_item.expires_at,
      next_action: nextAction,
    },
    support_packet: detail.work_item.support_packet,
    diagnostics: {
      work_item_path: `/work/${detail.work_item.id}`,
      support_packet_id: detail.work_item.support_packet_id,
      request_id: detail.work_item.support_packet?.request_id ?? null,
      build_sha: detail.work_item.support_packet?.build_sha ?? null,
      route: detail.work_item.route ?? detail.work_item.support_packet?.route ?? null,
      entity_type: detail.work_item.entity_type,
      entity_id: detail.work_item.entity_id,
      capture_session_id: detail.work_item.capture_session_id,
      dispatch_outbox_status: dispatchOutbox?.status ?? null,
      evidence_refs: evidenceRefs,
    },
    diagnostic_manifest: diagnosticManifest,
    timeline: timelineEvents,
    timeline_total: detail.events_total,
    timeline_truncated: timelineTruncated,
    ...(opts.callback ? { callback: opts.callback } : {}),
  }
  const agentBriefMarkdown = buildAgentBriefMarkdown({
    detail,
    dispatchOutbox,
    timeline: timelineEvents,
    callback: opts.callback,
    nextAction,
    diagnosticManifest,
  })
  return {
    ...partial,
    agent_brief_markdown: agentBriefMarkdown,
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

function includeSupportPacketForAudience(audience: HandoffPacketAudience): boolean {
  return audience === 'operator' || audience === 'mesh'
}

function intendedUseForAudience(audience: HandoffPacketAudience): string {
  if (audience === 'mesh') return 'agent_execution'
  if (audience === 'github') return 'external_issue_export'
  if (audience === 'collaborator') return 'human_handoff'
  return 'operator_debugging'
}

function buildWorkRequestHandoffPacket(input: {
  companyId: string
  detail: ContextWorkItemDetail
  dispatchOutbox: DispatchOutboxSummary | null
  audience: HandoffPacketAudience
}): WorkRequestHandoffPacket {
  const brief = buildWorkRequestBrief(input.detail, input.dispatchOutbox)
  const includeSupportPacket = includeSupportPacketForAudience(input.audience)
  const packetWithoutHash = {
    schema: 'sitelayer.context_handoff_packet.v1' as const,
    generated_at: new Date().toISOString(),
    audience: input.audience,
    redaction_version: 'context-handoff-v1' as const,
    source: {
      system: 'sitelayer' as const,
      company_id: input.companyId,
      work_item_id: input.detail.work_item.id,
      support_packet_id: input.detail.work_item.support_packet_id,
      public_path: `/work/${input.detail.work_item.id}`,
    },
    permissions: {
      intended_use: intendedUseForAudience(input.audience),
      raw_support_packet_included: includeSupportPacket,
      callback_token_included: false as const,
      callback_available_after_dispatch: true,
    },
    state: brief.state,
    work_item: brief.work_item,
    diagnostics: brief.diagnostics,
    diagnostic_manifest: brief.diagnostic_manifest,
    support_packet: includeSupportPacket ? brief.support_packet : null,
    evidence_refs: brief.diagnostics.evidence_refs,
    timeline: brief.timeline,
    timeline_total: brief.timeline_total,
    timeline_truncated: brief.timeline_truncated,
    agent_brief_markdown: brief.agent_brief_markdown,
    ...(brief.callback ? { callback: brief.callback } : {}),
  }
  return {
    ...packetWithoutHash,
    packet_sha256: createHash('sha256').update(stableStringify(packetWithoutHash)).digest('hex'),
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505'
  )
}

// Sentinel thrown from inside the create tx when the dedup_key ON CONFLICT
// collapses to an existing row. Throwing rolls back the whole tx (discarding the
// orphan support packet we already inserted); the caller catches it and replies
// idempotently with the existing item.
class FieldRequestDedupConflict extends Error {
  constructor(readonly dedupKey: string) {
    super('field_request dedup conflict')
    this.name = 'FieldRequestDedupConflict'
  }
}

async function getWorkItemIdByClientRequestId(
  companyId: string,
  actorUserId: string,
  clientRequestId: string,
): Promise<string | null> {
  return withCompanyClient(companyId, async (c) => {
    const result = await c.query<{ id: string }>(
      `select id
         from context_work_items
        where company_id = $1
          and created_by_user_id = $2
          and metadata ->> 'client_request_id' = $3
        order by created_at asc
        limit 1`,
      [companyId, actorUserId, clientRequestId],
    )
    return result.rows[0]?.id ?? null
  })
}

async function getWorkItemIdByRequestRef(companyId: string, requestRef: string): Promise<string | null> {
  return withCompanyClient(companyId, async (c) => {
    const result = await c.query<{ id: string }>(
      `select id
         from context_work_items
        where company_id = $1
          and metadata ->> 'request_ref' = $2
        order by created_at asc
        limit 1`,
      [companyId, requestRef],
    )
    return result.rows[0]?.id ?? null
  })
}

async function getWorkItemIdByDedupKey(companyId: string, dedupKey: string): Promise<string | null> {
  return withCompanyClient(companyId, async (c) => {
    const result = await c.query<{ id: string }>(
      `select id
         from context_work_items
        where company_id = $1
          and dedup_key = $2
        order by created_at asc
        limit 1`,
      [companyId, dedupKey],
    )
    return result.rows[0]?.id ?? null
  })
}

// Coarse time bucket (seconds) for the field_request dedup fingerprint. A burst
// of identical retries / double-submits inside the same window collapses to one
// row; the same content filed in a later window is a legitimately distinct row.
// Override via WORK_REQUEST_DEDUP_WINDOW_SECONDS (clamped 1s..1h).
const DEFAULT_DEDUP_WINDOW_SECONDS = 120

function dedupWindowSeconds(): number {
  return Math.min(
    3600,
    Math.max(1, readPositiveNumberEnv('WORK_REQUEST_DEDUP_WINDOW_SECONDS', DEFAULT_DEDUP_WINDOW_SECONDS)),
  )
}

function normalizeFingerprintText(value: string | null): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Server-derived per-(actor, target-entity, content, coarse-time-bucket)
 * idempotency fingerprint for a field_request create. Bounds same-tenant create
 * spam + makes the create idempotent under client retry WITHOUT a client-supplied
 * key. Mirrors the company boundary: company_id + actor_user_id are part of the
 * hash so it never collapses two different tenants or two different members.
 */
export function computeFieldRequestDedupKey(input: {
  companyId: string
  actorUserId: string
  entityType: string | null
  entityId: string | null
  title: string
  summary: string | null
  nowMs?: number
}): string {
  const bucket = Math.floor((input.nowMs ?? Date.now()) / (dedupWindowSeconds() * 1000))
  const fingerprint = [
    'field_request',
    input.companyId,
    input.actorUserId,
    input.entityType ?? '',
    input.entityId ?? '',
    normalizeFingerprintText(input.title),
    normalizeFingerprintText(input.summary),
    String(bucket),
  ].join('')
  return createHash('sha256').update(fingerprint).digest('hex')
}

async function getExistingCreateResponseForWorkItem(companyId: string, workItemId: string) {
  if (!workItemId) return null
  const detail = await getContextWorkItemWithEvents(companyId, workItemId)
  if (!detail) return null
  return {
    work_item: workItemResponse(detail.work_item),
    support_packet: detail.work_item.support_packet
      ? {
          id: detail.work_item.support_packet.id,
          expires_at: detail.work_item.support_packet.expires_at,
        }
      : {
          id: detail.work_item.support_packet_id,
          expires_at: null,
        },
    event: detail.events[0] ?? null,
    idempotent_replay: true,
  }
}

async function getExistingCreateResponse(companyId: string, actorUserId: string, clientRequestId: string) {
  const workItemId = await getWorkItemIdByClientRequestId(companyId, actorUserId, clientRequestId)
  return workItemId ? getExistingCreateResponseForWorkItem(companyId, workItemId) : null
}

// The dedup_key already binds (company_id, actor_user_id), so a match is always
// the SAME actor's prior create — no cross-user read-scope conflict to guard
// against (unlike request_ref, which is company-wide). Resolve straight to the
// existing item for an idempotent replay.
async function getExistingCreateResponseByDedupKey(companyId: string, dedupKey: string) {
  const workItemId = await getWorkItemIdByDedupKey(companyId, dedupKey)
  return workItemId ? getExistingCreateResponseForWorkItem(companyId, workItemId) : null
}

async function getExistingCreateResponseByRequestRef(
  companyId: string,
  role: CompanyRole,
  userId: string,
  requestRef: string,
): Promise<
  | { kind: 'found'; response: NonNullable<Awaited<ReturnType<typeof getExistingCreateResponseForWorkItem>>> }
  | { kind: 'conflict' }
  | null
> {
  const workItemId = await getWorkItemIdByRequestRef(companyId, requestRef)
  if (!workItemId) return null
  const detail = await getContextWorkItemWithEvents(companyId, workItemId)
  if (!detail) return null
  if (!canReadWorkItem(role, userId, detail.work_item)) return { kind: 'conflict' }
  const response = await getExistingCreateResponseForWorkItem(companyId, workItemId)
  return response ? { kind: 'found', response } : null
}

async function getDispatchOutboxTx(
  executor: LedgerExecutor,
  companyId: string,
  idempotencyKey: string,
): Promise<DispatchOutboxSummary | null> {
  const result = await executor.query<DispatchOutboxSummary>(
    `select id, mutation_type, idempotency_key, status, capture_session_id,
            attempt_count,
            next_attempt_at, applied_at, error
       from mutation_outbox
      where company_id = $1
        and idempotency_key = $2
        and mutation_type = $3
      limit 1`,
    [companyId, idempotencyKey, DISPATCH_MUTATION_TYPE],
  )
  return result.rows[0] ?? null
}

async function getDispatchBackpressureTx(
  executor: LedgerExecutor,
  companyId: string,
): Promise<DispatchBackpressureState> {
  const pendingLimit = dispatchMaxPending()
  const failedLimit = dispatchMaxFailed()
  const result = await executor.query<{
    pending_count: number | string | null
    failed_count: number | string | null
    oldest_pending_age_seconds: number | string | null
  }>(
    `select count(*) filter (where status in ('pending', 'processing'))::int as pending_count,
            count(*) filter (where status in ('failed', 'dead'))::int as failed_count,
            extract(epoch from (now() - min(created_at) filter (where status in ('pending', 'processing'))))::int
              as oldest_pending_age_seconds
       from mutation_outbox
      where company_id = $1
        and mutation_type = $2`,
    [companyId, DISPATCH_MUTATION_TYPE],
  )
  const row = result.rows[0]
  return {
    pending_count: Number(row?.pending_count ?? 0),
    failed_count: Number(row?.failed_count ?? 0),
    oldest_pending_age_seconds:
      row?.oldest_pending_age_seconds === null || row?.oldest_pending_age_seconds === undefined
        ? null
        : Number(row.oldest_pending_age_seconds),
    pending_limit: pendingLimit,
    failed_limit: failedLimit,
  }
}

async function getHandoffEventByIdempotencyTx(
  executor: LedgerExecutor,
  companyId: string,
  idempotencyKey: string,
): Promise<ContextHandoffEventRow | null> {
  const result = await executor.query<ContextHandoffEventRow>(
    `select id, company_id, work_item_id, event_type, actor_kind, actor_user_id,
            actor_ref, source_system, payload, metadata, idempotency_key,
            causation_event_id, correlation_id, request_id, capture_session_id,
            sentry_trace, sentry_baggage, build_sha, redaction_version,
            occurred_at, recorded_at
       from context_handoff_events
      where company_id = $1 and idempotency_key = $2
      limit 1`,
    [companyId, idempotencyKey],
  )
  return result.rows[0] ?? null
}

async function enqueueDispatchOutboxTx(
  executor: LedgerExecutor,
  args: {
    companyId: string
    workItemId: string
    actorUserId: string | null
    idempotencyKey: string
    payload: DispatchPayload
  },
): Promise<DispatchOutboxSummary> {
  const trace = currentTraceHeaders()
  const requestId = getRequestContext()?.requestId ?? null
  await executor.query(
    `insert into mutation_outbox (
       company_id, device_id, actor_user_id, entity_type, entity_id,
       mutation_type, payload, idempotency_key, status,
       sentry_trace, sentry_baggage, request_id, capture_session_id
     ) values (
       $1, 'server', $2, 'context_work_item', $3,
       $4, $5::jsonb, $6, 'pending',
       $7, $8, $9, $10::uuid
     )
     on conflict (company_id, idempotency_key) do nothing`,
    [
      args.companyId,
      args.actorUserId,
      args.workItemId,
      DISPATCH_MUTATION_TYPE,
      JSON.stringify(args.payload),
      args.idempotencyKey,
      trace.sentryTrace,
      trace.baggage,
      requestId,
      args.payload.capture_session_id,
    ],
  )
  const row = await getDispatchOutboxTx(executor, args.companyId, args.idempotencyKey)
  if (!row) throw new Error('dispatch outbox insert returned no row')
  return row
}

async function retryDispatchOutboxTx(
  executor: LedgerExecutor,
  args: {
    companyId: string
    idempotencyKey: string
    actorUserId: string | null
    payload: DispatchPayload
  },
): Promise<{ outbox: DispatchOutboxSummary | null; retried: boolean }> {
  const trace = currentTraceHeaders()
  const requestId = getRequestContext()?.requestId ?? null
  const result = await executor.query<DispatchOutboxSummary>(
    `update mutation_outbox
        set status = 'pending',
            attempt_count = 0,
            next_attempt_at = now(),
            applied_at = null,
            error = null,
            payload = $4::jsonb,
            actor_user_id = $5,
            sentry_trace = $6,
            sentry_baggage = $7,
            request_id = $8,
            capture_session_id = $9::uuid,
            updated_at = now()
      where company_id = $1
        and idempotency_key = $2
        and mutation_type = $3
        and status in ('failed', 'dead')
      returning id, mutation_type, idempotency_key, status, capture_session_id,
                attempt_count,
                next_attempt_at, applied_at, error`,
    [
      args.companyId,
      args.idempotencyKey,
      DISPATCH_MUTATION_TYPE,
      JSON.stringify(args.payload),
      args.actorUserId,
      trace.sentryTrace,
      trace.baggage,
      requestId,
      args.payload.capture_session_id,
    ],
  )
  const updated = result.rows[0]
  if (updated) return { outbox: updated, retried: true }
  return {
    outbox: await getDispatchOutboxTx(executor, args.companyId, args.idempotencyKey),
    retried: false,
  }
}

async function setAgentCallbackTokenHashTx(
  executor: LedgerExecutor,
  args: {
    companyId: string
    workItemId: string
    tokenHash: string
  },
): Promise<void> {
  await executor.query(
    `update context_work_items
        set agent_callback_token_hash = $3,
            agent_callback_token_issued_at = now(),
            updated_at = now()
      where company_id = $1 and id = $2`,
    [args.companyId, args.workItemId, args.tokenHash],
  )
}

async function readAgentCallbackTokenAuth(
  companyId: string,
  workItemId: string,
): Promise<{ tokenHash: string | null; issuedAt: string | null } | null> {
  const result = await withCompanyClient(companyId, (c) =>
    c.query<{ agent_callback_token_hash: string | null; agent_callback_token_issued_at: string | null }>(
      `select agent_callback_token_hash, agent_callback_token_issued_at
         from context_work_items
        where company_id = $1 and id = $2
        limit 1`,
      [companyId, workItemId],
    ),
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    tokenHash: row.agent_callback_token_hash ?? null,
    issuedAt: row.agent_callback_token_issued_at ?? null,
  }
}

async function authorizeAgentCallback(
  companyId: string,
  workItemId: string,
  presentedToken: string,
): Promise<'ok' | 'missing' | 'invalid' | 'expired' | 'not_found'> {
  const scoped = await readAgentCallbackTokenAuth(companyId, workItemId)
  if (!scoped) return 'not_found'
  if (scoped?.tokenHash) {
    if (!presentedToken) return 'missing'
    const issuedAt = scoped.issuedAt ? Date.parse(scoped.issuedAt) : NaN
    if (Number.isFinite(issuedAt) && Date.now() - issuedAt > callbackTokenTtlHours() * 60 * 60 * 1000) {
      return 'expired'
    }
    return safeTokenEqual(hashCallbackToken(presentedToken), scoped.tokenHash) ? 'ok' : 'invalid'
  }
  const fallback = process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN
  if (!fallback) return 'not_found'
  if (!presentedToken) return 'missing'
  return safeTokenEqual(presentedToken, fallback) ? 'ok' : 'invalid'
}

function buildDispatchPayload(
  req: http.IncomingMessage,
  detail: ContextWorkItemDetail,
  callbackToken: string,
): DispatchPayload {
  const row = detail.work_item
  const dispatchStatus: WorkItemStatus = 'agent_running'
  const dispatchLane: WorkItemLane = 'agent'
  const dispatchDetail: ContextWorkItemDetail = {
    ...detail,
    work_item: {
      ...row,
      status: dispatchStatus,
      lane: dispatchLane,
    },
  }
  const callbackPath = `/api/work-requests/${row.id}/agent-callback`
  const callback = {
    path: callbackPath,
    url: callbackUrlForPath(req, callbackPath),
    token: callbackToken,
    token_type: 'scoped_bearer' as const,
    expires_at: callbackTokenExpiresAt(),
  }
  const brief = buildWorkRequestBrief(dispatchDetail, null, {
    callback: {
      path: callback.path,
      url: callback.url,
      token_type: callback.token_type,
      expires_at: callback.expires_at,
    },
  })
  // ADDITIVE projectkit seam: build the WorkRequest (with embedded Concern)
  // from the SAME dispatch facts the legacy payload carries. It rides alongside
  // the context_work_dispatch.v1 fields under `dispatch_request` — nothing
  // existing is replaced. request_ref/concern_ref = work_item_id; the callback
  // target is the adapter-agnostic { url, mode: 'webhook' } surface (the
  // scoped-bearer token stays in the legacy `callback.token`, not this snapshot).
  const dispatchRequest = buildWorkRequestSnapshot({
    workItemId: row.id,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    status: dispatchStatus,
    route: row.route,
    entityType: row.entity_type,
    entityId: row.entity_id,
    captureSessionId: row.capture_session_id,
    supportPacketId: row.support_packet_id,
    sourceEventRef: row.support_packet_id,
    lane: dispatchLane,
    kind: 'execute',
    intent: 'fix',
    callback: callback.url ? { url: callback.url, mode: 'webhook' } : { mode: 'webhook' },
  })
  return {
    payload_version: CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION,
    work_item_id: row.id,
    support_packet_id: row.support_packet_id,
    capture_session_id: row.capture_session_id,
    title: row.title,
    summary: row.summary,
    route: row.route,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    status: dispatchStatus,
    lane: dispatchLane,
    reversibility_window_seconds: Number(row.reversibility_window_seconds),
    support_packet: row.support_packet ?? null,
    work_request_brief: brief,
    agent_brief_markdown: brief.agent_brief_markdown,
    callback,
    dispatch_request: dispatchRequest,
  }
}

async function createWorkRequest(req: http.IncomingMessage, ctx: WorkRequestRouteCtx) {
  if (!(await ctx.requireCapability('field_request.create'))) return
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const title = requiredText(body.title ?? body.summary ?? body.problem, MAX_TITLE_LENGTH)
  if (!title.ok) {
    ctx.sendJson(400, { error: 'title is required' })
    return
  }
  const summary = optionalText(body.summary ?? body.problem, MAX_SUMMARY_LENGTH)
  const severity = parseAllowed(body.severity, WORK_ITEM_SEVERITIES) as WorkItemSeverity | null
  if (body.severity !== undefined && body.severity !== null && !severity) {
    ctx.sendJson(400, { error: `severity must be one of ${WORK_ITEM_SEVERITIES.join(', ')}` })
    return
  }
  const lane = (parseAllowed(body.lane, WORK_ITEM_LANES) ?? 'triage') as WorkItemLane
  const category = optionalText(body.category, 120)
  const client = buildClientPacket(body)
  const serverContext = await buildSupportServerContext({
    pool: ctx.pool,
    company: ctx.company,
    identity: ctx.identity,
    tier: ctx.tier,
    buildSha: ctx.buildSha,
    client,
  })
  const requestId = getRequestContext()?.requestId ?? null
  const captureSessionId = getRequestContext()?.captureSessionId ?? null
  const route = optionalText(body.route, 500) ?? readClientRoute(client)
  const entity = firstEntityRef(client)
  const retentionDays = Math.max(1, Math.min(90, Number(process.env.SUPPORT_PACKET_RETENTION_DAYS ?? 30)))
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const requestRef = optionalText(body.request_ref, 200)
  if (body.request_ref !== undefined && body.request_ref !== null && !requestRef) {
    ctx.sendJson(400, { error: 'request_ref must be a non-empty string when provided' })
    return
  }
  const clientIdempotency =
    optionalText(body.client_request_id, 160) ?? optionalText(headerText(req.headers['idempotency-key']), 160)
  // Server-derived per-(actor, target-entity, content, coarse-time-bucket)
  // idempotency fingerprint (migration 012). Bounds same-tenant create spam and
  // makes the create idempotent under client retry even when NO client_request_id
  // / request_ref is supplied. The (company_id, dedup_key) unique partial index
  // is the authority for concurrent dupes; this fast-path pre-check + the in-tx
  // ON CONFLICT both resolve to the existing item.
  const dedupKey = computeFieldRequestDedupKey({
    companyId: ctx.company.id,
    actorUserId: ctx.identity.userId,
    entityType: entity.entityType,
    entityId: entity.entityId,
    title: title.value,
    summary,
  })
  if (requestRef) {
    const existing = await getExistingCreateResponseByRequestRef(
      ctx.company.id,
      ctx.company.role,
      ctx.identity.userId,
      requestRef,
    )
    if (existing?.kind === 'found') {
      ctx.sendJson(200, existing.response)
      return
    }
    if (existing?.kind === 'conflict') {
      ctx.sendJson(409, { error: 'request_ref already exists' })
      return
    }
  }
  if (clientIdempotency) {
    const existing = await getExistingCreateResponse(ctx.company.id, ctx.identity.userId, clientIdempotency)
    if (existing) {
      ctx.sendJson(200, existing)
      return
    }
  }
  // Fast-path dedup pre-check: a rapid duplicate (same actor/entity/content in the
  // window) returns the EXISTING item without inserting an orphan support packet.
  {
    const existing = await getExistingCreateResponseByDedupKey(ctx.company.id, dedupKey)
    if (existing) {
      ctx.sendJson(200, existing)
      return
    }
  }

  let result: {
    packet: { id: string; expires_at: string | null }
    item: ContextWorkItemRow
    event: ContextHandoffEventRow
  }
  try {
    result = await withMutationTx(ctx.company.id, async (c) => {
      const packet = await insertSupportPacket(c, {
        companyId: ctx.company.id,
        actorUserId: ctx.identity.userId,
        requestId,
        route,
        captureSessionId,
        buildSha: ctx.buildSha,
        problem: summary ?? title.value,
        client,
        serverContext: serverContext as JsonRecord,
        expiresAt,
        redactionVersion: 'support-packet-v1',
      })
      const created = await createContextWorkItemWithDedupTx(c, {
        companyId: ctx.company.id,
        supportPacketId: packet.id,
        // WorkRequestAction / field_event flow → a field-request (contractor
        // operational problem on a real job). Explicit even though it matches
        // the column + arg default.
        domain: 'field_request',
        title: title.value,
        summary,
        status: 'new',
        lane,
        severity,
        route,
        captureSessionId,
        entityType: entity.entityType,
        entityId: entity.entityId,
        createdByUserId: ctx.identity.userId,
        // Server-derived dedup fingerprint (migration 012). ON CONFLICT
        // (company_id, dedup_key) DO NOTHING collapses a concurrent duplicate
        // that raced past the fast-path pre-check.
        dedupKey,
        metadata: {
          category,
          source: 'work_request',
          request_ref: requestRef,
          capture_session_id: captureSessionId,
          client_request_id: clientIdempotency,
          support_packet_expires_at: packet.expires_at ?? expiresAt,
        },
      })
      // A concurrent duplicate already won the (company_id, dedup_key) race.
      // Throw to roll back THIS tx (incl. the support packet we just inserted) so
      // we don't leave an orphan; the caller resolves to the existing item.
      if (!created.created) throw new FieldRequestDedupConflict(dedupKey)
      const item = created.item
      // ADDITIVE seam (projectkit Concern snapshot): stamp a portable,
      // adapter-agnostic @operator/projectkit `Concern` onto metadata.concern.
      // concern_ref = the work_item_id (only known after insert), so we merge it
      // in with a JSONB `||` that preserves every existing metadata key — no
      // behavior change, no schema change. This is the One-Line Boundary Test
      // surface: a subscriber other than mesh can read the Concern shape here.
      const concernSnapshot = buildConcernSnapshot({
        workItemId: item.id,
        title: item.title,
        summary: item.summary,
        severity: item.severity,
        status: item.status,
        route: item.route,
        entityType: item.entity_type,
        entityId: item.entity_id,
        captureSessionId: item.capture_session_id,
        supportPacketId: packet.id,
        sourceEventRef: packet.id,
        dispatchedAt: item.created_at,
      })
      const merged = await c.query<{ metadata: JsonRecord }>(
        `update context_work_items
            set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('concern', $3::jsonb)
          where company_id = $1 and id = $2
          returning metadata`,
        [ctx.company.id, item.id, JSON.stringify(concernSnapshot)],
      )
      const itemWithConcern: ContextWorkItemRow = merged.rows[0] ? { ...item, metadata: merged.rows[0].metadata } : item
      const event = await appendContextHandoffEventTx(c, {
        companyId: ctx.company.id,
        workItemId: item.id,
        eventType: 'work_item.created',
        actorKind: 'user',
        actorUserId: ctx.identity.userId,
        payload: {
          title: item.title,
          summary: item.summary,
          status: item.status,
          lane: item.lane,
          severity: item.severity,
          route: item.route,
          entity_type: item.entity_type,
          entity_id: item.entity_id,
          capture_session_id: item.capture_session_id,
          support_packet_id: packet.id,
        },
        metadata: {
          category,
          capture_session_id: captureSessionId,
          evidence_refs: [{ type: 'support_debug_packet', id: packet.id }],
        },
        idempotencyKey: `work_item:create:${packet.id}`,
        captureSessionId,
        buildSha: ctx.buildSha,
      })
      return { packet, item: itemWithConcern, event }
    })
  } catch (error) {
    // Concurrent duplicate collapsed by the dedup_key unique index: resolve to
    // the existing item for an idempotent reply. Scoped to the sentinel so a
    // request_ref unique violation still flows to its own handler (which can
    // return 409 on a cross-user request_ref reuse).
    if (error instanceof FieldRequestDedupConflict) {
      const existing = await getExistingCreateResponseByDedupKey(ctx.company.id, dedupKey)
      if (existing) {
        ctx.sendJson(200, existing)
        return
      }
    }
    if (requestRef && isUniqueViolation(error)) {
      const existing = await getExistingCreateResponseByRequestRef(
        ctx.company.id,
        ctx.company.role,
        ctx.identity.userId,
        requestRef,
      )
      if (existing?.kind === 'found') {
        ctx.sendJson(200, existing.response)
        return
      }
      if (existing?.kind === 'conflict') {
        ctx.sendJson(409, { error: 'request_ref already exists' })
        return
      }
    }
    if (clientIdempotency && isUniqueViolation(error)) {
      const existing = await getExistingCreateResponse(ctx.company.id, ctx.identity.userId, clientIdempotency)
      if (existing) {
        ctx.sendJson(200, existing)
        return
      }
    }
    throw error
  }

  ctx.sendJson(201, {
    work_item: workItemResponse(result.item),
    support_packet: {
      id: result.packet.id,
      expires_at: result.packet.expires_at ?? expiresAt,
    },
    event: result.event,
  })
  observeContextHandoff('work_item.created')
}

async function listWorkRequests(ctx: WorkRequestRouteCtx, url: URL) {
  if (!(await ctx.requireCapability('field_request.view'))) return
  const pagination = parsePagination(url.searchParams, { defaultLimit: 50, maxLimit: PAGINATION_MAX_LIMIT })
  if (!pagination.ok) {
    ctx.sendJson(400, { error: pagination.error })
    return
  }
  const memberVisibleUserId = ctx.company.role === 'member' ? ctx.identity.userId : null
  const rows = await listContextWorkItems(ctx.company.id, {
    domain: FIELD_REQUEST_DOMAIN,
    status: url.searchParams.get('status'),
    lane: url.searchParams.get('lane'),
    entityType: url.searchParams.get('entity_type'),
    entityId: url.searchParams.get('entity_id'),
    createdByUserId:
      memberVisibleUserId === null
        ? roleScopedCreatedBy(ctx.company.role, ctx.identity.userId, url.searchParams.get('created_by_user_id'))
        : null,
    assigneeUserId: memberVisibleUserId === null ? url.searchParams.get('assignee_user_id') : null,
    visibleToUserId: memberVisibleUserId,
    limit: pagination.value.limit,
    offset: pagination.value.offset,
  })
  ctx.sendJson(200, {
    work_items: rows.rows.map(workItemResponse),
    pagination: buildPaginationMeta(pagination.value, rows.rowCount ?? rows.rows.length),
  })
}

async function listWorkRequestBoard(ctx: WorkRequestRouteCtx, url: URL) {
  if (!(await ctx.requireCapability('field_request.view'))) return
  const pagination = parsePagination(url.searchParams, { defaultLimit: 200, maxLimit: PAGINATION_MAX_LIMIT })
  if (!pagination.ok) {
    ctx.sendJson(400, { error: pagination.error })
    return
  }
  const groupByRaw = url.searchParams.get('group_by')
  const groupBy =
    groupByRaw === null
      ? 'status_group'
      : (parseAllowed(groupByRaw, BOARD_GROUP_BY_VALUES) as WorkRequestBoardGroupBy | null)
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
  const memberVisibleUserId = ctx.company.role === 'member' ? ctx.identity.userId : null
  const rows = await listContextWorkItems(ctx.company.id, {
    domain: FIELD_REQUEST_DOMAIN,
    status,
    lane,
    entityType: url.searchParams.get('entity_type'),
    entityId: url.searchParams.get('entity_id'),
    createdByUserId:
      memberVisibleUserId === null
        ? roleScopedCreatedBy(ctx.company.role, ctx.identity.userId, url.searchParams.get('created_by_user_id'))
        : null,
    assigneeUserId: memberVisibleUserId === null ? url.searchParams.get('assignee_user_id') : null,
    visibleToUserId: memberVisibleUserId,
    limit: pagination.value.limit,
    offset: pagination.value.offset,
  })
  const workItems = rows.rows.map(workItemResponse)
  ctx.sendJson(200, {
    group_by: groupBy,
    columns: buildWorkRequestBoardColumns(workItems, groupBy),
    work_items: workItems,
    pagination: buildPaginationMeta(pagination.value, rows.rowCount ?? rows.rows.length),
  })
}

async function getWorkRequestQueueHealth(ctx: WorkRequestRouteCtx) {
  if (!(await ctx.requireCapability('field_request.triage'))) return
  const health = await withCompanyClient(ctx.company.id, async (c) => {
    const workStatuses = await c.query<{ status: string; count: number }>(
      `select status, count(*)::int as count
         from context_work_items
        where company_id = $1
          and domain = $3
          and status = any($2::text[])
        group by status`,
      [ctx.company.id, [...HEALTH_WORK_STATUSES], FIELD_REQUEST_DOMAIN],
    )
    const dispatchStatuses = await c.query<{ status: string; count: number }>(
      `select status, count(*)::int as count
         from mutation_outbox
        where company_id = $1
          and mutation_type = $2
          and status = any($3::text[])
        group by status`,
      [ctx.company.id, DISPATCH_MUTATION_TYPE, [...HEALTH_DISPATCH_STATUSES]],
    )
    const oldestDispatch = await c.query<{ oldest_pending_age_seconds: number | null }>(
      `select extract(epoch from (now() - min(created_at)))::int as oldest_pending_age_seconds
         from mutation_outbox
        where company_id = $1
          and mutation_type = $2
          and status in ('pending', 'processing')`,
      [ctx.company.id, DISPATCH_MUTATION_TYPE],
    )
    const capture = await c.query<{
      captured_work_items: number
      analysis_ready: number
      analysis_pending: number
      analysis_failed: number
      analysis_missing: number
    }>(
      `select (count(*) filter (where capture_session_id is not null))::int as captured_work_items,
              (count(*) filter (
                where capture_session_id is not null
                  and metadata -> 'capture_artifact_analysis' ->> 'status' = 'ready'
              ))::int as analysis_ready,
              (count(*) filter (
                where capture_session_id is not null
                  and metadata -> 'capture_artifact_analysis' ->> 'status' in ('pending', 'processing')
              ))::int as analysis_pending,
              (count(*) filter (
                where capture_session_id is not null
                  and metadata -> 'capture_artifact_analysis' ->> 'status' in ('failed', 'error')
              ))::int as analysis_failed,
              (count(*) filter (
                where capture_session_id is not null
                  and coalesce(metadata -> 'capture_artifact_analysis' ->> 'status', '') = ''
              ))::int as analysis_missing
         from context_work_items
        where company_id = $1
          and domain = $2`,
      [ctx.company.id, FIELD_REQUEST_DOMAIN],
    )
    return {
      config: {
        mesh_dispatch_configured: Boolean(workRequestDispatchUrl()),
        projectkit_dispatch_configured: Boolean(workRequestDispatchUrl()),
        callback_configured: true,
        scoped_callbacks_enabled: true,
        callback_fallback_configured: Boolean(process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN),
        dispatch_max_pending: dispatchMaxPending(),
        dispatch_max_failed: dispatchMaxFailed(),
      },
      work_items: countsFor(HEALTH_WORK_STATUSES, workStatuses.rows),
      dispatch_outbox: {
        ...countsFor(HEALTH_DISPATCH_STATUSES, dispatchStatuses.rows),
        oldest_pending_age_seconds: oldestDispatch.rows[0]?.oldest_pending_age_seconds ?? null,
      },
      capture: {
        captured_work_items: capture.rows[0]?.captured_work_items ?? 0,
        analysis_ready: capture.rows[0]?.analysis_ready ?? 0,
        analysis_pending: capture.rows[0]?.analysis_pending ?? 0,
        analysis_failed: capture.rows[0]?.analysis_failed ?? 0,
        analysis_missing: capture.rows[0]?.analysis_missing ?? 0,
      },
    }
  })
  ctx.sendJson(200, health)
}

async function getWorkRequest(ctx: WorkRequestRouteCtx, id: string, url: URL) {
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
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
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!(await ctx.requireCapability('field_request.view'))) return
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const dispatchOutbox = await getDispatchOutbox(ctx.company.id, id)
  const workRequestBrief = buildWorkRequestBrief(detail, dispatchOutbox)
  ctx.sendJson(200, {
    work_item: workItemResponse(detail.work_item),
    support_packet: detail.work_item.support_packet,
    dispatch_outbox: dispatchOutbox,
    work_request_brief: workRequestBrief,
    events: detail.events,
    events_pagination: {
      limit: detail.events_limit,
      offset: detail.events_offset,
      total: detail.events_total,
      has_more: detail.events_truncated,
    },
  })
}

async function getWorkRequestBrief(ctx: WorkRequestRouteCtx, id: string, url: URL) {
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  const requestedEventsLimit = Number(url.searchParams.get('events_limit') ?? 200)
  const eventsLimit = Number.isFinite(requestedEventsLimit)
    ? Math.max(12, Math.min(500, Math.floor(requestedEventsLimit)))
    : 200
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id, { eventsLimit })
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!(await ctx.requireCapability('field_request.view'))) return
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const dispatchOutbox = await getDispatchOutbox(ctx.company.id, id)
  const workRequestBrief = buildWorkRequestBrief(detail, dispatchOutbox)
  ctx.sendJson(200, {
    work_request_brief: workRequestBrief,
  })
}

async function getWorkRequestHandoffPacket(ctx: WorkRequestRouteCtx, id: string, url: URL) {
  if (!(await ctx.requireCapability('field_request.triage'))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  const audienceRaw = url.searchParams.get('audience')
  const audience =
    audienceRaw === null
      ? 'operator'
      : (parseAllowed(audienceRaw, HANDOFF_PACKET_AUDIENCES) as HandoffPacketAudience | null)
  if (!audience) {
    ctx.sendJson(400, { error: `audience must be one of ${HANDOFF_PACKET_AUDIENCES.join(', ')}` })
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id, { eventsLimit: 200 })
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const dispatchOutbox = await getDispatchOutbox(ctx.company.id, id)
  ctx.sendJson(200, {
    handoff_packet: buildWorkRequestHandoffPacket({
      companyId: ctx.company.id,
      detail,
      dispatchOutbox,
      audience,
    }),
  })
}

async function recordHandoffPacketExportAccess(
  ctx: WorkRequestRouteCtx,
  detail: ContextWorkItemDetail,
  packet: WorkRequestHandoffPacket,
  purpose: string,
): Promise<void> {
  const requestContext = getRequestContext()
  try {
    await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into support_packet_access_log (
           company_id, support_packet_id, actor_user_id, access_type,
           route, request_id, metadata
         ) values ($1, $2, $3, 'export', $4, $5, $6::jsonb)`,
        [
          ctx.company.id,
          detail.work_item.support_packet_id,
          ctx.identity.userId,
          requestContext?.route ?? null,
          requestContext?.requestId ?? null,
          JSON.stringify(
            supportJsonRecord({
              work_item_id: detail.work_item.id,
              audience: packet.audience,
              purpose,
              packet_sha256: packet.packet_sha256,
              redaction_version: packet.redaction_version,
              intended_use: packet.permissions.intended_use,
            }),
          ),
        ],
      ),
    )
  } catch {
    // Export is already represented in context_handoff_events; this secondary
    // support-packet access trail must not block the handoff.
  }
}

async function exportWorkRequestHandoffPacket(ctx: WorkRequestRouteCtx, id: string) {
  if (!(await ctx.requireCapability('field_request.triage'))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const audience = parseAllowed(body.audience, HANDOFF_PACKET_AUDIENCES) as HandoffPacketAudience | null
  if (body.audience !== undefined && body.audience !== null && !audience) {
    ctx.sendJson(400, { error: `audience must be one of ${HANDOFF_PACKET_AUDIENCES.join(', ')}` })
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id, { eventsLimit: 200 })
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const packetAudience = audience ?? 'collaborator'
  const purpose = optionalText(body.purpose, 500) ?? intendedUseForAudience(packetAudience)
  const dispatchOutbox = await getDispatchOutbox(ctx.company.id, id)
  const packet = buildWorkRequestHandoffPacket({
    companyId: ctx.company.id,
    detail,
    dispatchOutbox,
    audience: packetAudience,
  })
  const packetBody = stableStringify(packet)
  const event = await withMutationTx(ctx.company.id, (c) =>
    appendContextHandoffEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType: 'handoff_packet.exported',
      actorKind: 'user',
      actorUserId: ctx.identity.userId,
      payload: {
        audience: packet.audience,
        purpose,
        schema: packet.schema,
        packet_sha256: packet.packet_sha256,
        packet_length: packetBody.length,
        support_packet_id: detail.work_item.support_packet_id,
        timeline_total: packet.timeline_total,
      },
      metadata: {
        evidence_refs: packet.evidence_refs,
        intended_use: packet.permissions.intended_use,
        redaction_version: packet.redaction_version,
      },
      idempotencyKey:
        optionalText(body.idempotency_key, 200) ??
        `context_work_item:handoff_packet_export:${id}:${ctx.identity.userId}:${packetAudience}:${Math.floor(
          Date.now() / 60_000,
        )}`,
    }),
  )
  await recordHandoffPacketExportAccess(ctx, detail, packet, purpose)
  ctx.sendJson(200, { handoff_packet: packet, event })
  observeContextHandoff('handoff_packet.exported')
}

async function getDispatchOutbox(companyId: string, workItemId: string): Promise<DispatchOutboxSummary | null> {
  const idempotencyKey = `context_work_item:dispatch_mesh:${workItemId}`
  return withCompanyClient(companyId, (c) => getDispatchOutboxTx(c, companyId, idempotencyKey))
}

function countsFor<const T extends readonly string[]>(
  statuses: T,
  rows: Array<{ status: string; count: number }>,
): Record<T[number], number> {
  const out = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<T[number], number>
  for (const row of rows) {
    if ((statuses as readonly string[]).includes(row.status)) out[row.status as T[number]] = Number(row.count)
  }
  return out
}

async function getGithubExport(ctx: WorkRequestRouteCtx, id: string, opts: { recordEvent?: boolean } = {}) {
  if (!(await ctx.requireCapability('field_request.triage'))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const support = detail.work_item.support_packet
  let timelineEvents = detail.events.slice(-8)
  if (detail.events_truncated) {
    const latest = await getContextWorkItemWithEvents(ctx.company.id, id, {
      eventsLimit: 8,
      eventsOffset: Math.max(0, detail.events_total - 8),
    })
    timelineEvents = latest?.events ?? timelineEvents
  }
  const timeline = timelineEvents.map((event) => {
    const message = optionalText(event.payload.message, 500) ?? optionalText(event.payload.body, 500)
    const url = optionalText(event.payload.url, 500)
    return `- ${event.event_type} (${event.actor_kind})${message ? `: ${message}` : url ? `: ${url}` : ''}`
  })
  const body = [
    '## Observed',
    detail.work_item.summary || detail.work_item.title,
    '',
    '## Reproduction',
    `Route: ${detail.work_item.route || support?.route || 'unknown'}`,
    detail.work_item.entity_type && detail.work_item.entity_id
      ? `Entity: ${detail.work_item.entity_type}/${detail.work_item.entity_id}`
      : 'Entity: unknown',
    '',
    '## Safe diagnostics',
    `Internal work item: /work/${detail.work_item.id}`,
    `Support packet: ${detail.work_item.support_packet_id}`,
    `Request ID: ${support?.request_id || 'unknown'}`,
    `Build: ${support?.build_sha || 'unknown'}`,
    '',
    '## Timeline',
    timeline.length ? timeline.join('\n') : '- no timeline events',
  ].join('\n')
  const response = {
    title: detail.work_item.title,
    body,
    labels: ['sitelayer', 'context-handoff'],
  }
  let event: ContextHandoffEventRow | null = null
  if (opts.recordEvent) {
    event = await withMutationTx(ctx.company.id, (c) =>
      appendContextHandoffEventTx(c, {
        companyId: ctx.company.id,
        workItemId: id,
        eventType: 'external.github_export_prepared',
        actorKind: 'user',
        actorUserId: ctx.identity.userId,
        payload: {
          title: response.title,
          labels: response.labels,
          body_sha256: createHash('sha256').update(body).digest('hex'),
          body_length: body.length,
        },
        metadata: {
          export_target: 'github',
          redaction_version: 'context-handoff-v1',
          support_packet_id: detail.work_item.support_packet_id,
        },
        idempotencyKey: `context_work_item:github_export:${id}:${ctx.identity.userId}:${Math.floor(Date.now() / 60_000)}`,
      }),
    )
  }
  ctx.sendJson(200, {
    ...response,
    ...(event ? { event } : {}),
  })
  observeContextHandoff('github_export.generated')
  if (event) observeContextHandoff('external.github_export_prepared')
}

async function moveWorkRequest(req: http.IncomingMessage, ctx: WorkRequestRouteCtx, id: string) {
  if (!(await ctx.requireCapability('field_request.triage'))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const status = parseAllowed(body.status, WORK_ITEM_STATUSES) as WorkItemStatus | null
  const lane = parseAllowed(body.lane, WORK_ITEM_LANES) as WorkItemLane | null
  if (body.status !== undefined && body.status !== null && !status) {
    ctx.sendJson(400, { error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` })
    return
  }
  if (status === 'reversed') {
    ctx.sendJson(400, { error: 'status reversed must use the reverse endpoint' })
    return
  }
  if (body.lane !== undefined && body.lane !== null && !lane) {
    ctx.sendJson(400, { error: `lane must be one of ${WORK_ITEM_LANES.join(', ')}` })
    return
  }
  const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'assignee_user_id')
  let assigneeUserId: string | null | undefined
  if (hasAssignee) {
    if (
      body.assignee_user_id !== null &&
      body.assignee_user_id !== undefined &&
      typeof body.assignee_user_id !== 'string'
    ) {
      ctx.sendJson(400, { error: 'assignee_user_id must be a string or null' })
      return
    }
    assigneeUserId = optionalText(body.assignee_user_id, 200)
  }
  if (!status && !lane && !hasAssignee) {
    ctx.sendJson(400, { error: 'status, lane, or assignee_user_id is required' })
    return
  }
  const expectedUpdatedAt = optionalText(body.expected_updated_at, 100)
  if (!expectedUpdatedAt || !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    ctx.sendJson(400, { error: 'expected_updated_at is required' })
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id, { eventsLimit: 1 })
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const idempotencyKey =
    optionalText(body.idempotency_key, 200) ?? optionalText(headerText(req.headers['idempotency-key']), 200)
  const movedAt = new Date().toISOString()
  const result = await withMutationTx(ctx.company.id, async (c) => {
    const locked = await c.query<
      Pick<ContextWorkItemRow, 'status' | 'lane' | 'assignee_user_id' | 'updated_at' | 'resolved_at'>
    >(
      `select status, lane, assignee_user_id, updated_at, resolved_at
         from context_work_items
        where company_id = $1 and id = $2
        for update`,
      [ctx.company.id, id],
    )
    const current = locked.rows[0]
    if (!current) return { kind: 'not_found' as const }
    if (current.updated_at !== expectedUpdatedAt) {
      return { kind: 'stale' as const, currentUpdatedAt: current.updated_at }
    }
    if (isReversedTerminal(current.status)) {
      return { kind: 'terminal' as const, status: current.status }
    }
    const nextStatus = status ?? current.status
    const nextLane = lane ?? (status ? defaultLaneForStatus(status) : current.lane)
    const nextResolvedAt =
      status === 'resolved' ? (current.resolved_at ?? movedAt) : status === 'reopened' ? null : undefined
    const updated = await updateContextWorkItemWithEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType: 'work_item.status_changed',
      actorKind: 'user',
      actorUserId: ctx.identity.userId,
      status: nextStatus,
      lane: nextLane,
      ...(hasAssignee ? { assigneeUserId: assigneeUserId ?? null } : {}),
      ...(nextResolvedAt !== undefined ? { resolvedAt: nextResolvedAt } : {}),
      payload: {
        message: optionalText(body.message, MAX_SUMMARY_LENGTH),
        previous_status: current.status,
        previous_lane: current.lane,
        previous_assignee_user_id: current.assignee_user_id,
        status: nextStatus,
        lane: nextLane,
        ...(hasAssignee ? { assignee_user_id: assigneeUserId ?? null } : {}),
      },
      metadata: {
        move_source: optionalText(body.source, 120) ?? 'issue_board',
        evidence_refs: [{ type: 'support_debug_packet', id: detail.work_item.support_packet_id }],
      },
      ...(idempotencyKey ? { idempotencyKey } : {}),
    })
    return updated ? { kind: 'ok' as const, updated } : { kind: 'not_found' as const }
  })
  if (result.kind === 'not_found') {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (result.kind === 'stale') {
    ctx.sendJson(409, { error: 'work item changed', current_updated_at: result.currentUpdatedAt })
    return
  }
  if (result.kind === 'terminal') {
    ctx.sendJson(409, { error: `work item is ${result.status} and cannot be moved` })
    return
  }
  ctx.sendJson(200, {
    work_item: workItemResponse(result.updated.workItem),
    event: result.updated.event,
  })
  observeContextHandoff('work_item.status_changed')
}

async function appendWorkRequestEvent(ctx: WorkRequestRouteCtx, id: string) {
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const eventType = parseAllowed(body.event_type, HANDOFF_EVENT_TYPES) as HandoffEventType | null
  if (!eventType) {
    ctx.sendJson(400, { error: `event_type must be one of ${HANDOFF_EVENT_TYPES.join(', ')}` })
    return
  }
  if (eventType === 'work_item.reversed') {
    ctx.sendJson(400, { error: 'use the reverse endpoint for work_item.reversed' })
    return
  }
  // message.added / resolution.reopened stay open to every role that can see
  // the item (field_request.view is the floor all 5 roles hold — unchanged from
  // the old "any reader" behavior); all other event types are triage-class.
  const eventCapability: Capability =
    eventType === 'message.added' || eventType === 'resolution.reopened' ? 'field_request.view' : 'field_request.triage'
  if (!(await ctx.requireCapability(eventCapability))) return
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  if (isReversedTerminal(detail.work_item.status) && eventType !== 'message.added') {
    ctx.sendJson(409, { error: `work item is ${detail.work_item.status} and cannot be changed` })
    return
  }
  const status = parseAllowed(body.status, WORK_ITEM_STATUSES) as WorkItemStatus | null
  const lane = parseAllowed(body.lane, WORK_ITEM_LANES) as WorkItemLane | null
  if (body.status !== undefined && body.status !== null && !status) {
    ctx.sendJson(400, { error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` })
    return
  }
  if (status === 'reversed') {
    ctx.sendJson(400, { error: 'status reversed must use the reverse endpoint' })
    return
  }
  if (body.lane !== undefined && body.lane !== null && !lane) {
    ctx.sendJson(400, { error: `lane must be one of ${WORK_ITEM_LANES.join(', ')}` })
    return
  }
  const next = deriveEventState(eventType, status, lane, body)
  const updateArgs = {
    companyId: ctx.company.id,
    workItemId: id,
    eventType,
    actorKind: 'user' as const,
    actorUserId: ctx.identity.userId,
    payload: {
      message: optionalText(body.message, MAX_SUMMARY_LENGTH),
      body: optionalText(body.body, MAX_SUMMARY_LENGTH),
      url: optionalText(body.url, 1000),
      status: next.status ?? null,
      lane: next.lane ?? null,
      assignee_user_id: next.assigneeUserId ?? null,
    },
    metadata: body.metadata ?? {},
    ...(next.status ? { status: next.status } : {}),
    ...(next.lane ? { lane: next.lane } : {}),
    ...(next.assigneeUserId !== undefined ? { assigneeUserId: next.assigneeUserId } : {}),
    ...(next.resolvedAt !== undefined ? { resolvedAt: next.resolvedAt } : {}),
    ...(optionalText(body.idempotency_key, 200) ? { idempotencyKey: optionalText(body.idempotency_key, 200) } : {}),
  }
  const updated = await withMutationTx(ctx.company.id, (c) => updateContextWorkItemWithEventTx(c, updateArgs))
  if (!updated) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  ctx.sendJson(201, {
    work_item: workItemResponse(updated.workItem),
    event: updated.event,
  })
  observeContextHandoff(eventType)
}

async function dispatchWorkRequestToMesh(req: http.IncomingMessage, ctx: WorkRequestRouteCtx, id: string) {
  if (!(await ctx.requireCapability('field_request.triage'))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  if (!requireWorkRequestDispatchConfigured(ctx)) return
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const idempotencyKey = `context_work_item:dispatch_mesh:${id}`
  const callbackToken = newCallbackToken()
  const callbackTokenHash = hashCallbackToken(callbackToken)
  const payload = buildDispatchPayload(req, detail, callbackToken)
  const result = await withMutationTx(ctx.company.id, async (c) => {
    const existingOutbox = await getDispatchOutboxTx(c, ctx.company.id, idempotencyKey)
    if (existingOutbox) {
      return {
        kind: 'ready' as const,
        workItem: detail.work_item,
        event: await getHandoffEventByIdempotencyTx(c, ctx.company.id, idempotencyKey),
        outbox: existingOutbox,
        dispatchQueued: false,
      }
    }
    const backpressure = await getDispatchBackpressureTx(c, ctx.company.id)
    if (backpressure.pending_count >= backpressure.pending_limit) {
      return { kind: 'backpressure' as const, status: 429, reason: 'pending' as const, backpressure }
    }
    if (backpressure.failed_count >= backpressure.failed_limit) {
      return { kind: 'backpressure' as const, status: 503, reason: 'failed' as const, backpressure }
    }
    const updated = await updateContextWorkItemWithEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType: 'agent.dispatch_requested',
      actorKind: 'user',
      actorUserId: ctx.identity.userId,
      status: 'agent_running',
      lane: 'agent',
      payload,
      metadata: {
        dispatch_surface: 'projectkit',
        dispatch_adapter: 'mesh',
        evidence_refs: [{ type: 'support_debug_packet', id: detail.work_item.support_packet_id }],
      },
      idempotencyKey,
    })
    if (!updated) return null
    await setAgentCallbackTokenHashTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      tokenHash: callbackTokenHash,
    })
    const outbox = await enqueueDispatchOutboxTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      actorUserId: ctx.identity.userId,
      idempotencyKey,
      payload,
    })
    return { kind: 'ready' as const, ...updated, outbox, dispatchQueued: true }
  })
  if (!result) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (result.kind === 'backpressure') {
    ctx.sendJson(result.status, {
      error:
        result.reason === 'pending'
          ? 'projectkit dispatch backlog is full'
          : 'projectkit dispatch failure backlog requires operator attention',
      dispatch_outbox: result.backpressure,
    })
    return
  }
  ctx.sendJson(202, {
    work_item: workItemResponse(result.workItem),
    event: result.event,
    outbox: {
      id: result.outbox.id,
      mutation_type: result.outbox.mutation_type,
      idempotency_key: result.outbox.idempotency_key,
      status: result.outbox.status,
      capture_session_id: result.outbox.capture_session_id,
      attempt_count: result.outbox.attempt_count,
      next_attempt_at: result.outbox.next_attempt_at,
      applied_at: result.outbox.applied_at,
      error: result.outbox.error,
    },
    dispatch_queued: result.dispatchQueued,
  })
  if (result.dispatchQueued) observeContextHandoff('agent.dispatch_requested')
}

async function retryWorkRequestMeshDispatch(req: http.IncomingMessage, ctx: WorkRequestRouteCtx, id: string) {
  if (!(await ctx.requireCapability('field_request.triage'))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  if (!requireWorkRequestDispatchConfigured(ctx)) return
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const idempotencyKey = `context_work_item:dispatch_mesh:${id}`
  const retryKey =
    optionalText(body.idempotency_key, 200) ??
    optionalText(headerText(req.headers['idempotency-key']), 200) ??
    `context_work_item:dispatch_mesh_retry:${id}:${Math.floor(Date.now() / 60_000)}`
  const callbackToken = newCallbackToken()
  const callbackTokenHash = hashCallbackToken(callbackToken)
  const payload = buildDispatchPayload(req, detail, callbackToken)
  const result = await withMutationTx(ctx.company.id, async (c) => {
    const retry = await retryDispatchOutboxTx(c, {
      companyId: ctx.company.id,
      idempotencyKey,
      actorUserId: ctx.identity.userId,
      payload,
    })
    if (!retry.outbox) return null
    if (!retry.retried) {
      return {
        workItem: detail.work_item,
        event: await getHandoffEventByIdempotencyTx(c, ctx.company.id, retryKey),
        outbox: retry.outbox,
        dispatchQueued: false,
      }
    }
    const updated = await updateContextWorkItemWithEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType: 'agent.dispatch_retried',
      actorKind: 'user',
      actorUserId: ctx.identity.userId,
      status: 'agent_running',
      lane: 'agent',
      payload: {
        ...payload,
        retry: true,
        outbox_id: retry.outbox.id,
      },
      metadata: {
        dispatch_surface: 'projectkit',
        dispatch_adapter: 'mesh',
        reason: optionalText(body.reason, 500),
        evidence_refs: [{ type: 'support_debug_packet', id: detail.work_item.support_packet_id }],
      },
      idempotencyKey: retryKey,
    })
    if (!updated) return null
    await setAgentCallbackTokenHashTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      tokenHash: callbackTokenHash,
    })
    return { ...updated, outbox: retry.outbox, dispatchQueued: true }
  })
  if (!result) {
    ctx.sendJson(409, { error: 'dispatch has not failed or has not been queued' })
    return
  }
  ctx.sendJson(202, {
    work_item: workItemResponse(result.workItem),
    event: result.event,
    outbox: {
      id: result.outbox.id,
      mutation_type: result.outbox.mutation_type,
      idempotency_key: result.outbox.idempotency_key,
      status: result.outbox.status,
      capture_session_id: result.outbox.capture_session_id,
      attempt_count: result.outbox.attempt_count,
      next_attempt_at: result.outbox.next_attempt_at,
      applied_at: result.outbox.applied_at,
      error: result.outbox.error,
    },
    dispatch_queued: result.dispatchQueued,
  })
  if (result.dispatchQueued) observeContextHandoff('agent.dispatch_retried')
}

async function receiveAgentCallback(req: http.IncomingMessage, ctx: WorkRequestRouteCtx, id: string) {
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  const presented = bearerToken(req)
  const auth = await authorizeAgentCallback(ctx.company.id, id, presented)
  if (auth === 'not_found') {
    ctx.sendJson(404, { error: 'not found' })
    return
  }
  if (auth === 'expired') {
    ctx.sendJson(410, { error: 'callback token expired' })
    return
  }
  if (auth !== 'ok') {
    ctx.sendJson(401, { error: 'invalid callback token' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const eventType = parseAllowed(body.event_type, AGENT_CALLBACK_EVENT_TYPES) as HandoffEventType | null
  if (!eventType) {
    ctx.sendJson(400, { error: 'event_type must be an agent callback event' })
    return
  }
  const parsed = AgentCallbackBodySchema.safeParse(body)
  if (!parsed.success) {
    ctx.sendJson(400, {
      error: 'invalid agent callback payload',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    })
    return
  }
  const callbackBody = parsed.data
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (isReversedTerminal(detail.work_item.status)) {
    ctx.sendJson(409, { error: `work item is ${detail.work_item.status} and cannot accept agent callbacks` })
    return
  }
  const next = deriveAgentCallbackState(eventType, callbackBody)
  if (next.status === 'reversed') {
    ctx.sendJson(400, { error: 'status reversed must use the reverse endpoint' })
    return
  }
  // ADDITIVE projectkit seam (RETURN leg): alongside the existing handoff-event
  // payload, stamp a portable, adapter-agnostic @operator/projectkit `Callback`
  // snapshot under the new `projectkit_callback` key — the return-direction
  // mirror of the dispatch leg's `dispatch_request`. concern_ref = work_item_id;
  // status maps from the work item's NEXT status (so the same shape a different
  // dispatch adapter would POST back is recorded here). TOKEN SAFETY: the
  // bearer callback token is NEVER carried in this snapshot. NO behavior change:
  // every pre-existing payload field is untouched; this key is purely added.
  const callbackStatus = workItemStatusToCallbackStatus(next.status)
  const callbackMessage = optionalText(callbackBody.message, MAX_SUMMARY_LENGTH)
  const callbackSnapshot = callbackStatus
    ? buildCallbackSnapshot({
        workItemId: id,
        status: next.status,
        artifacts: callbackBody.artifacts,
        // Surface the agent message as the failure detail only on a failed
        // Callback (its sole contract meaning); leave it on the existing
        // payload.message for every other status.
        ...(callbackStatus === 'failed' && callbackMessage ? { error: callbackMessage } : {}),
        // completed_at only on terminal states; default to the callback instant
        // when the agent omitted it so the terminal Callback is well-formed.
        ...(isTerminalCallbackStatus(callbackStatus)
          ? { completedAt: optionalText(body.completed_at, 64) ?? new Date().toISOString() }
          : {}),
      })
    : null
  const updated = await withMutationTx(ctx.company.id, (c) =>
    updateContextWorkItemWithEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType,
      actorKind: 'agent',
      actorRef: optionalText(callbackBody.agent_ref, 200) ?? 'mesh',
      payload: {
        message: optionalText(callbackBody.message, MAX_SUMMARY_LENGTH),
        body: optionalText(callbackBody.body, MAX_SUMMARY_LENGTH),
        url: optionalText(callbackBody.url, 1000),
        artifacts: callbackBody.artifacts ?? null,
        status: next.status ?? null,
        lane: next.lane ?? null,
        // ADDITIVE: portable projectkit Callback snapshot (token-free).
        ...(callbackSnapshot ? { projectkit_callback: callbackSnapshot } : {}),
      },
      metadata: callbackBody.metadata ?? {},
      ...(next.status ? { status: next.status } : {}),
      ...(next.lane ? { lane: next.lane } : {}),
      ...(optionalText(callbackBody.idempotency_key, 200)
        ? { idempotencyKey: optionalText(callbackBody.idempotency_key, 200) }
        : {}),
    }),
  )
  if (!updated) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  ctx.sendJson(202, {
    work_item: workItemResponse(updated.workItem),
    event: updated.event,
  })
  observeContextHandoff(eventType)
}

function isTerminalForReverse(status: WorkItemStatus): boolean {
  // 'cancelled' is not a sitelayer status (the CHECK constraint never accepted
  // it), so we treat the terminal set as resolved/wont_do/reversed. 'reversed'
  // catches idempotent re-reverse attempts.
  return status === 'resolved' || status === 'wont_do' || status === 'reversed'
}

function isReversedTerminal(status: WorkItemStatus): boolean {
  return status === 'reversed'
}

function pickLatestMeshTaskId(events: ContextHandoffEventRow[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event) continue
    if (event.event_type !== 'agent.dispatch_acknowledged') continue
    const candidate = (event.payload as Record<string, unknown>).mesh_task_id
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate)
  }
  return null
}

async function callMeshCancelTask(meshTaskId: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url = meshTaskCancelUrl(meshTaskId)
  if (!url) return { ok: false, error: 'MESH_API_URL or PROJECTKIT_WORK_REQUEST_DISPATCH_URL not configured' }
  const headers: Record<string, string> = {}
  const token = meshBearerToken()
  if (token) headers.authorization = `Bearer ${token}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(url, { method: 'DELETE', headers, signal: controller.signal })
    if (response.ok || response.status === 404) return { ok: true, status: response.status }
    const text = await response.text().catch(() => '')
    return { ok: false, status: response.status, error: text.slice(0, 200) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'mesh cancel failed' }
  } finally {
    clearTimeout(timer)
  }
}

async function reverseWorkRequest(ctx: WorkRequestRouteCtx, id: string) {
  // Reversing a resolution is a resolve-class state mutation → field_request.resolve.
  // The catalog default for resolve is admin/foreman/office/bookkeeper (member
  // excluded), preserving the old TRIAGE_ROLES gate exactly. Member-level
  // callers still cannot reverse arbitrary items (they can reopen their own
  // through resolution.reopened, which stays on field_request.view).
  if (!(await ctx.requireCapability('field_request.resolve'))) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const reason = optionalText(body.reason, MAX_SUMMARY_LENGTH)
  if (!reason) {
    ctx.sendJson(400, { error: 'reason is required' })
    return
  }

  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!isFieldRequestDetail(detail)) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const latestDetail = detail.events_truncated
    ? await getContextWorkItemWithEvents(ctx.company.id, id, {
        eventsLimit: 500,
        eventsOffset: Math.max(0, detail.events_total - 500),
      })
    : detail
  const events = latestDetail?.events ?? detail.events

  // Idempotent re-reverse: if already reversed, return the current row + the
  // existing event, do not insert a duplicate handoff event.
  if (detail.work_item.status === 'reversed') {
    const existingReverseEvent = events.find((event) => event.event_type === 'work_item.reversed') ?? null
    ctx.sendJson(200, {
      work_item: workItemResponse(detail.work_item),
      event: existingReverseEvent,
      mesh_cancel: null,
      idempotent_replay: true,
    })
    return
  }
  if (isTerminalForReverse(detail.work_item.status)) {
    ctx.sendJson(409, { error: `work item is ${detail.work_item.status} and cannot be reversed` })
    return
  }

  // expires_at is a computed column (created_at + reversibility_window_seconds);
  // if it is null something is wrong upstream — treat as closed window so we
  // never silently let an unguarded reverse through.
  const expiresAt = detail.work_item.expires_at ? Date.parse(detail.work_item.expires_at) : NaN
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    ctx.sendJson(410, { error: 'reversibility window closed' })
    return
  }

  const meshTaskId = pickLatestMeshTaskId(events)

  const idempotencyKey = `context_work_item:reverse:${id}`
  const reversedAt = new Date().toISOString()
  const result = await withMutationTx(ctx.company.id, async (c) => {
    const locked = await c.query<{
      status: WorkItemStatus
      lane: WorkItemLane
      created_at: string
      expires_at: string | null
    }>(
      `select status,
              lane,
              created_at,
              (created_at + reversibility_window_seconds * interval '1 second') as expires_at
         from context_work_items
        where company_id = $1 and id = $2
        for update`,
      [ctx.company.id, id],
    )
    const current = locked.rows[0]
    if (!current) return { kind: 'not_found' as const }
    if (current.status === 'reversed') return { kind: 'already_reversed' as const }
    if (isTerminalForReverse(current.status)) return { kind: 'terminal' as const, status: current.status }
    const lockedExpiresAt = current.expires_at ? Date.parse(current.expires_at) : NaN
    if (!Number.isFinite(lockedExpiresAt) || Date.now() > lockedExpiresAt) {
      return { kind: 'expired' as const }
    }
    const lockedReversedWithinSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(current.created_at)) / 1000))
    const updated = await updateContextWorkItemWithEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType: 'work_item.reversed',
      actorKind: 'user',
      actorUserId: ctx.identity.userId,
      status: 'reversed',
      lane: 'done',
      payload: {
        reason,
        reversed_within_seconds: lockedReversedWithinSeconds,
        previous_status: current.status,
        previous_lane: current.lane,
        mesh_task_id: meshTaskId,
        mesh_cancel_deferred: Boolean(meshTaskId),
      },
      metadata: { evidence_refs: [{ type: 'support_debug_packet', id: detail.work_item.support_packet_id }] },
      resolvedAt: reversedAt,
      reversedAt,
      idempotencyKey,
    })
    return updated ? { kind: 'ok' as const, updated } : { kind: 'not_found' as const }
  })
  if (result.kind === 'not_found') {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (result.kind === 'already_reversed') {
    const latest = await getContextWorkItemWithEvents(ctx.company.id, id, {
      eventsLimit: 500,
      eventsOffset: Math.max(0, detail.events_total - 500),
    })
    const existingReverseEvent = latest?.events.find((event) => event.event_type === 'work_item.reversed') ?? null
    ctx.sendJson(200, {
      work_item: latest ? workItemResponse(latest.work_item) : workItemResponse(detail.work_item),
      event: existingReverseEvent,
      mesh_cancel: null,
      idempotent_replay: true,
    })
    return
  }
  if (result.kind === 'terminal') {
    ctx.sendJson(409, { error: `work item is ${result.status} and cannot be reversed` })
    return
  }
  if (result.kind === 'expired') {
    ctx.sendJson(410, { error: 'reversibility window closed' })
    return
  }

  let meshCancelOutcome: { ok: boolean; status?: number; error?: string } | null = null
  if (meshTaskId) {
    const outcome = await callMeshCancelTask(meshTaskId)
    meshCancelOutcome = outcome
    if (!outcome.ok) {
      console.warn(
        `[reverseWorkRequest] mesh cancel failed for work_item=${id} mesh_task_id=${meshTaskId}: ${outcome.error ?? outcome.status ?? 'unknown'}`,
      )
    }
    try {
      await withMutationTx(ctx.company.id, (c) =>
        appendContextHandoffEventTx(c, {
          companyId: ctx.company.id,
          workItemId: id,
          eventType: 'agent.dispatch_cancel_requested',
          actorKind: 'system',
          actorRef: 'sitelayer-api',
          sourceSystem: 'mesh',
          payload: {
            mesh_task_id: meshTaskId,
            reason: 'work_item.reversed',
            reverse_event_id: result.updated.event.id,
            ok: outcome.ok,
            status: outcome.status ?? null,
            error: outcome.error ?? null,
          },
          metadata: { dispatch_surface: 'projectkit', dispatch_adapter: 'mesh' },
          idempotencyKey: `context_work_item:mesh_cancel:${id}:${meshTaskId}`,
        }),
      )
      observeContextHandoff('agent.dispatch_cancel_requested')
    } catch (err) {
      console.warn(
        `[reverseWorkRequest] failed to append mesh cancel event for work_item=${id} mesh_task_id=${meshTaskId}: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      )
    }
  }

  ctx.sendJson(200, {
    work_item: workItemResponse(result.updated.workItem),
    event: result.updated.event,
    mesh_cancel: meshCancelOutcome,
  })
  observeContextHandoff('work_item.reversed')
}

async function sweepStaleWorkRequests(ctx: WorkRequestRouteCtx) {
  if (!(await ctx.requireCapability('field_request.triage'))) return
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const thresholdHoursRaw = Number(body.threshold_hours ?? 72)
  const thresholdHours = Number.isFinite(thresholdHoursRaw) ? Math.max(1, Math.min(720, thresholdHoursRaw)) : 72
  const limitRaw = Number(body.limit ?? MAX_STALE_SWEEP_LIMIT)
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(MAX_STALE_SWEEP_LIMIT, Math.floor(limitRaw)))
    : MAX_STALE_SWEEP_LIMIT
  const results = await withMutationTx(ctx.company.id, async (c) => {
    const stale = await c.query<{ id: string; status: WorkItemStatus; lane: WorkItemLane }>(
      `select id, status, lane
         from context_work_items
        where company_id = $1
          and domain = $4
          and status in ('agent_running', 'review_ready')
          and updated_at < now() - make_interval(hours => $2::int)
        order by updated_at asc
        limit $3
        for update skip locked`,
      [ctx.company.id, Math.floor(thresholdHours), limit, FIELD_REQUEST_DOMAIN],
    )
    const updated = []
    for (const row of stale.rows) {
      const result = await updateContextWorkItemWithEventTx(c, {
        companyId: ctx.company.id,
        workItemId: row.id,
        eventType: 'work_item.status_changed',
        actorKind: 'system',
        actorRef: 'stale_sweep',
        status: row.status === 'review_ready' ? 'review_stale' : 'proposal_expired',
        lane: row.lane === 'agent' ? 'both' : row.lane,
        payload: {
          previous_status: row.status,
          previous_lane: row.lane,
          threshold_hours: thresholdHours,
        },
        metadata: { reason: 'stale_work_request' },
        idempotencyKey: `context_work_item:stale:${row.id}:${Math.floor(Date.now() / 3_600_000)}`,
      })
      if (result) updated.push(result)
    }
    return updated
  })
  ctx.sendJson(200, {
    updated: results.map((result) => ({
      work_item: workItemResponse(result.workItem),
      event: result.event,
    })),
  })
  if (results.length > 0) observeContextHandoff('stale_sweep.updated', results.length)
}

function deriveEventState(
  eventType: HandoffEventType,
  requestedStatus: WorkItemStatus | null,
  requestedLane: WorkItemLane | null,
  body: Record<string, unknown>,
): {
  status?: WorkItemStatus
  lane?: WorkItemLane
  assigneeUserId?: string | null
  resolvedAt?: string | null
} {
  if (eventType === 'human.assigned') {
    return {
      status: requestedStatus ?? 'human_assigned',
      lane: requestedLane ?? 'human',
      assigneeUserId: optionalText(body.assignee_user_id, 200),
    }
  }
  if (eventType === 'resolution.accepted') {
    return { status: 'resolved', lane: 'done', resolvedAt: new Date().toISOString() }
  }
  if (eventType === 'resolution.reopened') {
    return { status: 'reopened', lane: requestedLane ?? 'triage', resolvedAt: null }
  }
  if (eventType === 'work_item.status_changed') {
    return {
      ...(requestedStatus ? { status: requestedStatus } : {}),
      ...(requestedLane ? { lane: requestedLane } : {}),
    }
  }
  return {}
}

function deriveAgentCallbackState(
  eventType: HandoffEventType,
  body: Record<string, unknown>,
): { status?: WorkItemStatus; lane?: WorkItemLane } {
  const requestedStatus = parseAllowed(body.status, WORK_ITEM_STATUSES) as WorkItemStatus | null
  const requestedLane = parseAllowed(body.lane, WORK_ITEM_LANES) as WorkItemLane | null
  if (eventType === 'agent.dispatch_acknowledged') {
    return { status: requestedStatus ?? 'agent_running', lane: requestedLane ?? 'agent' }
  }
  if (
    eventType === 'agent.proposal_ready' ||
    eventType === 'agent.completed' ||
    eventType === 'human.review_requested'
  ) {
    return { status: requestedStatus ?? 'review_ready', lane: requestedLane ?? 'both' }
  }
  return {
    ...(requestedStatus ? { status: requestedStatus } : {}),
    ...(requestedLane ? { lane: requestedLane } : {}),
  }
}

export async function handleWorkRequestRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: WorkRequestRouteCtx,
): Promise<boolean> {
  if (url.pathname === '/api/work-requests' && req.method === 'POST') {
    await createWorkRequest(req, ctx)
    return true
  }

  if (url.pathname === '/api/work-requests' && req.method === 'GET') {
    await listWorkRequests(ctx, url)
    return true
  }

  if (url.pathname === '/api/work-requests/board' && req.method === 'GET') {
    await listWorkRequestBoard(ctx, url)
    return true
  }

  if (url.pathname === '/api/work-requests/queue-health' && req.method === 'GET') {
    await getWorkRequestQueueHealth(ctx)
    return true
  }

  if (url.pathname === '/api/work-requests/stale-sweep' && req.method === 'POST') {
    await sweepStaleWorkRequests(ctx)
    return true
  }

  const eventMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/events$/)
  if (eventMatch && req.method === 'POST') {
    await appendWorkRequestEvent(ctx, decodeURIComponent(eventMatch[1]!))
    return true
  }

  const moveMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/move$/)
  if (moveMatch && req.method === 'POST') {
    await moveWorkRequest(req, ctx, decodeURIComponent(moveMatch[1]!))
    return true
  }

  const dispatchMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/dispatch\/(?:projectkit|mesh)$/)
  if (dispatchMatch && req.method === 'POST') {
    await dispatchWorkRequestToMesh(req, ctx, decodeURIComponent(dispatchMatch[1]!))
    return true
  }

  const dispatchRetryMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/dispatch\/(?:projectkit|mesh)\/retry$/)
  if (dispatchRetryMatch && req.method === 'POST') {
    await retryWorkRequestMeshDispatch(req, ctx, decodeURIComponent(dispatchRetryMatch[1]!))
    return true
  }

  const githubExportMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/github-export$/)
  if (githubExportMatch && req.method === 'GET') {
    await getGithubExport(ctx, decodeURIComponent(githubExportMatch[1]!))
    return true
  }
  if (githubExportMatch && req.method === 'POST') {
    await getGithubExport(ctx, decodeURIComponent(githubExportMatch[1]!), { recordEvent: true })
    return true
  }

  const callbackMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/agent-callback$/)
  if (callbackMatch && req.method === 'POST') {
    await receiveAgentCallback(req, ctx, decodeURIComponent(callbackMatch[1]!))
    return true
  }

  const reverseMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/reverse$/)
  if (reverseMatch && req.method === 'POST') {
    await reverseWorkRequest(ctx, decodeURIComponent(reverseMatch[1]!))
    return true
  }

  const briefMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/brief$/)
  if (briefMatch && req.method === 'GET') {
    await getWorkRequestBrief(ctx, decodeURIComponent(briefMatch[1]!), url)
    return true
  }

  const handoffPacketMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/handoff-packet$/)
  if (handoffPacketMatch && req.method === 'GET') {
    await getWorkRequestHandoffPacket(ctx, decodeURIComponent(handoffPacketMatch[1]!), url)
    return true
  }
  if (handoffPacketMatch && req.method === 'POST') {
    await exportWorkRequestHandoffPacket(ctx, decodeURIComponent(handoffPacketMatch[1]!))
    return true
  }

  const detailMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)$/)
  if (detailMatch && req.method === 'GET') {
    await getWorkRequest(ctx, decodeURIComponent(detailMatch[1]!), url)
    return true
  }

  return false
}
