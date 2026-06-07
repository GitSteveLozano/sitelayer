import { getRequestContext } from '@sitelayer/logger'
import { z } from 'zod'
// The work-item lifecycle vocabulary + reversibility helpers are now OWNED by
// the published @operator/projectkit "worklifecycle" core. Imported locally for
// in-module use (the Zod enums + assertIn guards below) AND re-exported just
// below so every existing sitelayer importer of these names keeps resolving them
// from './context-handoff.js' unchanged. A bare `export { … } from` would NOT
// bring the names into local scope, so the import is required for the in-module
// uses; the re-export keeps the public surface byte-identical.
import {
  WORK_ITEM_STATUSES,
  WORK_ITEM_LANES,
  WORK_ITEM_SEVERITIES,
  REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY,
  DEFAULT_REVERSIBILITY_WINDOW_SECONDS,
  reversibilityWindowForSeverity,
  type WorkItemStatus,
  type WorkItemLane,
  type WorkItemSeverity,
} from '@operator/projectkit'
import { currentTraceHeaders, type LedgerExecutor, withCompanyClient } from './mutation-tx.js'
import { sanitizeSupportJson } from './routes/support-packets.js'

export type JsonRecord = Record<string, unknown>

/**
 * The work-item status / lane / severity vocabulary and the
 * severity→reversibility-window map are re-exported VERBATIM from the published
 * @operator/projectkit "worklifecycle" core (the published literals/values are
 * byte-identical to the locals they replace — verified against
 * node_modules/@operator/projectkit/dist/worklifecycle.js).
 *
 * This is the DUPLICATION collapse from the worklifecycle re-point: sitelayer's
 * Postgres store, routes, Zod schemas, and ALL wire shapes stay identical, but
 * the status/lane/severity literals and the severity→reversibility-window map
 * now have a SINGLE source of truth in the shared contract. A sitelayer-internal
 * divergence is kept as a thin LOCAL extension (see WORK_ITEM_DOMAINS just
 * below), NOT by forking the published tuple. Non-behavioral by construction.
 *
 * The reversibility window mirrors the mesh-side
 * `tasks.reversibility_window_seconds` column (mesh migration 261); the default
 * (86400) matches what the outbound dispatch payload at
 * apps/worker/src/runners/context-work-dispatch.ts has been sending.
 */
export {
  WORK_ITEM_STATUSES,
  WORK_ITEM_LANES,
  WORK_ITEM_SEVERITIES,
  REVERSIBILITY_WINDOW_SECONDS_BY_SEVERITY,
  DEFAULT_REVERSIBILITY_WINDOW_SECONDS,
  reversibilityWindowForSeverity,
  type WorkItemStatus,
  type WorkItemLane,
  type WorkItemSeverity,
}

// The two non-bleeding work-item domains (migration 009 context_work_items.domain).
// app_issue = problems with the sitelayer SOFTWARE (capture-dock born, platform
// scope); field_request = contractor job problems/requests (WorkRequestAction /
// field_event born, company scope). The capture finalize writers stamp
// 'app_issue'; the WorkRequestAction path defaults to / stamps 'field_request'.
// This is a sitelayer-INTERNAL dimension NOT present in the published
// worklifecycle core, so it stays LOCAL (the "thin local extension" case).
export const WORK_ITEM_DOMAINS = ['app_issue', 'field_request'] as const
export type WorkItemDomain = (typeof WORK_ITEM_DOMAINS)[number]

export const HANDOFF_ACTOR_KINDS = ['user', 'agent', 'system', 'external'] as const
export type HandoffActorKind = (typeof HANDOFF_ACTOR_KINDS)[number]

export const HANDOFF_EVENT_TYPES = [
  'work_item.created',
  'work_item.updated',
  'work_item.status_changed',
  'message.added',
  'support_packet.linked',
  'agent.dispatch_requested',
  'agent.dispatch_acknowledged',
  'agent.dispatch_retried',
  'agent.dispatch_cancel_requested',
  'agent.callback_missing',
  'agent.message_received',
  'agent.artifact_attached',
  'agent.proposal_ready',
  'agent.completed',
  'human.assigned',
  'human.review_requested',
  'human.reviewed',
  'external.github_export_prepared',
  'handoff_packet.exported',
  'external.github_linked',
  'resolution.accepted',
  'resolution.reopened',
  'work_item.reversed',
] as const

export type HandoffEventType = (typeof HANDOFF_EVENT_TYPES)[number]

export const CONTEXT_WORK_DISPATCH_PAYLOAD_VERSION = 'sitelayer.context_work_dispatch.v1' as const

export const AGENT_CALLBACK_EVENT_TYPES = [
  'agent.dispatch_acknowledged',
  'agent.message_received',
  'agent.artifact_attached',
  'agent.proposal_ready',
  'agent.completed',
  'human.review_requested',
] as const satisfies readonly HandoffEventType[]

export const AgentCallbackBodySchema = z
  .object({
    event_type: z.enum(AGENT_CALLBACK_EVENT_TYPES),
    agent_ref: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().min(1).max(4000).optional().nullable(),
    body: z.string().trim().min(1).max(4000).optional().nullable(),
    url: z.string().trim().min(1).max(1000).optional().nullable(),
    artifacts: z.unknown().optional().nullable(),
    status: z.enum(WORK_ITEM_STATUSES).optional().nullable(),
    lane: z.enum(WORK_ITEM_LANES).optional().nullable(),
    metadata: z.unknown().optional(),
    idempotency_key: z.string().trim().min(1).max(200).optional().nullable(),
  })
  .passthrough()

export type AgentCallbackBody = z.infer<typeof AgentCallbackBodySchema>

export type ContextWorkItemRow = {
  id: string
  company_id: string
  support_packet_id: string
  domain: WorkItemDomain
  title: string
  summary: string | null
  status: WorkItemStatus
  lane: WorkItemLane
  severity: WorkItemSeverity | null
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
  metadata: JsonRecord
  /**
   * Server-derived per-(actor, entity, content, coarse-time-bucket) idempotency
   * fingerprint (migration 012). Only the field_request create path sets it; it
   * collapses rapid duplicate creates via the (company_id, dedup_key) unique
   * partial index. NULL for app_issue rows and any pre-012 row.
   */
  dedup_key: string | null
}

export type ContextHandoffEventRow = {
  id: string
  company_id: string
  work_item_id: string
  event_type: HandoffEventType
  actor_kind: HandoffActorKind
  actor_user_id: string | null
  actor_ref: string | null
  source_system: string
  payload: JsonRecord
  metadata: JsonRecord
  idempotency_key: string | null
  causation_event_id: string | null
  correlation_id: string | null
  request_id: string | null
  capture_session_id: string | null
  sentry_trace: string | null
  sentry_baggage: string | null
  build_sha: string | null
  redaction_version: string
  occurred_at: string
  recorded_at: string
}

export type ContextWorkItemDetail = {
  work_item: ContextWorkItemRow & {
    support_packet: {
      id: string
      route: string | null
      problem: string | null
      request_id: string | null
      capture_session_id: string | null
      build_sha: string | null
      created_at: string
      expires_at: string | null
      redaction_version: string
    } | null
  }
  events: ContextHandoffEventRow[]
  events_total: number
  events_limit: number
  events_offset: number
  events_truncated: boolean
}

const WORK_ITEM_COLUMN_NAMES = [
  'id',
  'company_id',
  'support_packet_id',
  'domain',
  'title',
  'summary',
  'status',
  'lane',
  'severity',
  'route',
  'capture_session_id',
  'entity_type',
  'entity_id',
  'assignee_user_id',
  'created_by_user_id',
  'created_at',
  'updated_at',
  'resolved_at',
  'reversed_at',
  'reversibility_window_seconds',
  'metadata',
  'dedup_key',
] as const

// Computed `expires_at` (created_at + reversibility_window_seconds seconds) is
// selected alongside the base columns for API/UI callers. Migration 093 indexes
// the underlying columns because Postgres cannot expression-index timestamptz
// arithmetic.
const WORK_ITEM_EXPIRES_AT_EXPR = "(created_at + reversibility_window_seconds * interval '1 second') as expires_at"
const PREFIXED_WORK_ITEM_EXPIRES_AT_EXPR =
  "(w.created_at + w.reversibility_window_seconds * interval '1 second') as expires_at"

const HANDOFF_EVENT_COLUMN_NAMES = [
  'id',
  'company_id',
  'work_item_id',
  'event_type',
  'actor_kind',
  'actor_user_id',
  'actor_ref',
  'source_system',
  'payload',
  'metadata',
  'idempotency_key',
  'causation_event_id',
  'correlation_id',
  'request_id',
  'capture_session_id',
  'sentry_trace',
  'sentry_baggage',
  'build_sha',
  'redaction_version',
  'occurred_at',
  'recorded_at',
] as const

const WORK_ITEM_COLUMNS = `${WORK_ITEM_COLUMN_NAMES.join(', ')}, ${WORK_ITEM_EXPIRES_AT_EXPR}`
const HANDOFF_EVENT_COLUMNS = HANDOFF_EVENT_COLUMN_NAMES.join(', ')
const PREFIXED_WORK_ITEM_COLUMNS = `${WORK_ITEM_COLUMN_NAMES.map((column) => `w.${column}`).join(', ')}, ${PREFIXED_WORK_ITEM_EXPIRES_AT_EXPR}`

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toJsonRecord(value: unknown): JsonRecord {
  const sanitized = sanitizeSupportJson(value)
  return isRecord(sanitized) ? sanitized : { value: sanitized }
}

function assertIn<const T extends readonly string[]>(allowed: T, value: string, label: string): T[number] {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value as T[number]
}

function optionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function sanitizeHandoffJson(value: unknown): unknown {
  return sanitizeSupportJson(value)
}

export async function createContextWorkItemTx(
  executor: LedgerExecutor,
  args: {
    companyId: string
    supportPacketId: string
    /**
     * Which non-bleeding domain this work item belongs to (migration 009).
     * Defaults to 'field_request' so the WorkRequestAction / field_event path
     * stays unchanged; the capture finalize writers pass 'app_issue' explicitly.
     */
    domain?: WorkItemDomain
    title: string
    summary?: string | null
    status?: WorkItemStatus
    lane?: WorkItemLane
    severity?: WorkItemSeverity | null
    route?: string | null
    entityType?: string | null
    entityId?: string | null
    captureSessionId?: string | null
    assigneeUserId?: string | null
    createdByUserId?: string | null
    metadata?: unknown
    reversibilityWindowSeconds?: number | null
  },
): Promise<ContextWorkItemRow> {
  const title = optionalText(args.title)
  if (!title) throw new Error('title is required')
  const status = args.status ?? 'new'
  const lane = args.lane ?? 'triage'
  // Default 'field_request' mirrors the column DEFAULT (migration 009): the
  // WorkRequestAction / field_event path keeps working unchanged, the capture
  // finalize writers pass 'app_issue' explicitly.
  const domain = args.domain ?? 'field_request'
  assertIn(WORK_ITEM_STATUSES, status, 'status')
  assertIn(WORK_ITEM_LANES, lane, 'lane')
  assertIn(WORK_ITEM_DOMAINS, domain, 'domain')
  if (args.severity) assertIn(WORK_ITEM_SEVERITIES, args.severity, 'severity')

  const reversibilityWindowSeconds =
    typeof args.reversibilityWindowSeconds === 'number' && Number.isFinite(args.reversibilityWindowSeconds)
      ? Math.max(0, Math.floor(args.reversibilityWindowSeconds))
      : reversibilityWindowForSeverity(args.severity ?? null)

  const result = await executor.query<ContextWorkItemRow>(
    `insert into context_work_items (
       company_id, support_packet_id, domain, title, summary, status, lane, severity,
       route, capture_session_id, entity_type, entity_id, assignee_user_id, created_by_user_id, metadata,
       reversibility_window_seconds
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12, $13, $14, $15::jsonb, $16)
     returning ${WORK_ITEM_COLUMNS}`,
    [
      args.companyId,
      args.supportPacketId,
      domain,
      title,
      optionalText(args.summary),
      status,
      lane,
      args.severity ?? null,
      optionalText(args.route),
      optionalText(args.captureSessionId),
      optionalText(args.entityType),
      optionalText(args.entityId),
      optionalText(args.assigneeUserId),
      optionalText(args.createdByUserId),
      JSON.stringify(toJsonRecord(args.metadata ?? {})),
      reversibilityWindowSeconds,
    ],
  )
  const row = result.rows[0]
  if (!row) throw new Error('context_work_items insert returned no row')
  return row
}

async function getContextWorkItemByDedupKeyTx(
  executor: LedgerExecutor,
  companyId: string,
  dedupKey: string,
): Promise<ContextWorkItemRow | null> {
  const result = await executor.query<ContextWorkItemRow>(
    `select ${WORK_ITEM_COLUMNS}
       from context_work_items
      where company_id = $1 and dedup_key = $2
      limit 1`,
    [companyId, dedupKey],
  )
  return result.rows[0] ?? null
}

/**
 * field_request-only create with a server-derived idempotency fingerprint
 * (migration 012). Inserts with the SAME column set as createContextWorkItemTx
 * plus `dedup_key`, using ON CONFLICT (company_id, dedup_key) DO NOTHING so two
 * identical creates in the same coarse-time window collapse to one row — the
 * second resolves to the EXISTING item (idempotent) instead of minting a new one.
 *
 * This bounds same-tenant create spam + makes the create idempotent under client
 * retry WITHOUT requiring a client-supplied key. The (company_id, dedup_key)
 * unique partial index is the authority, so a concurrent duplicate (two requests
 * racing past any app-level pre-check) still collapses to one row.
 *
 * Returns `{ item, created }`: `created=false` signals a dedup hit (the caller
 * should reply idempotently rather than 201). app_issue rows never pass a
 * dedupKey, so the capture finalize path is unaffected.
 */
export async function createContextWorkItemWithDedupTx(
  executor: LedgerExecutor,
  args: Parameters<typeof createContextWorkItemTx>[1] & { dedupKey: string },
): Promise<{ item: ContextWorkItemRow; created: boolean }> {
  const dedupKey = optionalText(args.dedupKey)
  if (!dedupKey) {
    return { item: await createContextWorkItemTx(executor, args), created: true }
  }
  const title = optionalText(args.title)
  if (!title) throw new Error('title is required')
  const status = args.status ?? 'new'
  const lane = args.lane ?? 'triage'
  const domain = args.domain ?? 'field_request'
  assertIn(WORK_ITEM_STATUSES, status, 'status')
  assertIn(WORK_ITEM_LANES, lane, 'lane')
  assertIn(WORK_ITEM_DOMAINS, domain, 'domain')
  if (args.severity) assertIn(WORK_ITEM_SEVERITIES, args.severity, 'severity')

  const reversibilityWindowSeconds =
    typeof args.reversibilityWindowSeconds === 'number' && Number.isFinite(args.reversibilityWindowSeconds)
      ? Math.max(0, Math.floor(args.reversibilityWindowSeconds))
      : reversibilityWindowForSeverity(args.severity ?? null)

  const result = await executor.query<ContextWorkItemRow>(
    `insert into context_work_items (
       company_id, support_packet_id, domain, title, summary, status, lane, severity,
       route, capture_session_id, entity_type, entity_id, assignee_user_id, created_by_user_id, metadata,
       reversibility_window_seconds, dedup_key
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid, $11, $12, $13, $14, $15::jsonb, $16, $17)
     on conflict (company_id, dedup_key) where dedup_key is not null do nothing
     returning ${WORK_ITEM_COLUMNS}`,
    [
      args.companyId,
      args.supportPacketId,
      domain,
      title,
      optionalText(args.summary),
      status,
      lane,
      args.severity ?? null,
      optionalText(args.route),
      optionalText(args.captureSessionId),
      optionalText(args.entityType),
      optionalText(args.entityId),
      optionalText(args.assigneeUserId),
      optionalText(args.createdByUserId),
      JSON.stringify(toJsonRecord(args.metadata ?? {})),
      reversibilityWindowSeconds,
      dedupKey,
    ],
  )
  const inserted = result.rows[0]
  if (inserted) return { item: inserted, created: true }

  // Conflict (DO NOTHING returned no row): a duplicate already exists for this
  // (company_id, dedup_key). Resolve to the existing item so the create is
  // idempotent under retry / concurrent double-submit.
  const existing = await getContextWorkItemByDedupKeyTx(executor, args.companyId, dedupKey)
  if (!existing) throw new Error('context_work_items dedup conflict resolved to no row')
  return { item: existing, created: false }
}

export async function appendContextHandoffEventTx(
  executor: LedgerExecutor,
  args: {
    companyId: string
    workItemId: string
    eventType: HandoffEventType
    actorKind: HandoffActorKind
    actorUserId?: string | null
    actorRef?: string | null
    sourceSystem?: string
    payload?: unknown
    metadata?: unknown
    idempotencyKey?: string | null
    causationEventId?: string | null
    correlationId?: string | null
    requestId?: string | null
    captureSessionId?: string | null
    sentryTrace?: string | null
    sentryBaggage?: string | null
    buildSha?: string | null
    redactionVersion?: string
    occurredAt?: string | null
  },
): Promise<ContextHandoffEventRow> {
  assertIn(HANDOFF_EVENT_TYPES, args.eventType, 'event_type')
  assertIn(HANDOFF_ACTOR_KINDS, args.actorKind, 'actor_kind')
  const trace = currentTraceHeaders()
  const requestId = args.requestId ?? getRequestContext()?.requestId ?? null
  const captureSessionId = args.captureSessionId ?? getRequestContext()?.captureSessionId ?? null
  const sentryTrace = args.sentryTrace ?? trace.sentryTrace
  const sentryBaggage = args.sentryBaggage ?? trace.baggage
  const idempotencyKey = optionalText(args.idempotencyKey)
  const values = [
    args.companyId,
    args.workItemId,
    args.eventType,
    args.actorKind,
    optionalText(args.actorUserId),
    optionalText(args.actorRef),
    optionalText(args.sourceSystem) ?? 'sitelayer',
    JSON.stringify(toJsonRecord(args.payload ?? {})),
    JSON.stringify(toJsonRecord(args.metadata ?? {})),
    idempotencyKey,
    optionalText(args.causationEventId),
    optionalText(args.correlationId),
    requestId,
    optionalText(captureSessionId),
    sentryTrace,
    sentryBaggage,
    optionalText(args.buildSha),
    args.redactionVersion ?? 'context-handoff-v1',
    args.occurredAt ?? null,
  ]
  const result = await executor.query<ContextHandoffEventRow>(
    `insert into context_handoff_events (
       company_id, work_item_id, event_type, actor_kind, actor_user_id,
       actor_ref, source_system, payload, metadata, idempotency_key,
       causation_event_id, correlation_id, request_id, capture_session_id,
       sentry_trace, sentry_baggage, build_sha, redaction_version, occurred_at
     ) values (
       $1, $2, $3, $4, $5,
       $6, $7, $8::jsonb, $9::jsonb, $10,
       $11::uuid, $12::uuid, $13, $14::uuid,
       $15, $16, $17, $18, coalesce($19::timestamptz, now())
     )
     on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing
     returning ${HANDOFF_EVENT_COLUMNS}`,
    values,
  )
  const inserted = result.rows[0]
  if (inserted) return inserted
  if (!idempotencyKey) throw new Error('context_handoff_events insert returned no row')
  const existing = await executor.query<ContextHandoffEventRow>(
    `select ${HANDOFF_EVENT_COLUMNS}
       from context_handoff_events
      where company_id = $1 and idempotency_key = $2
      limit 1`,
    [args.companyId, idempotencyKey],
  )
  const row = existing.rows[0]
  if (!row) throw new Error('context_handoff_events idempotency lookup returned no row')
  return row
}

export async function updateContextWorkItemWithEventTx(
  executor: LedgerExecutor,
  args: {
    companyId: string
    workItemId: string
    eventType: HandoffEventType
    actorKind: HandoffActorKind
    actorUserId?: string | null
    actorRef?: string | null
    payload?: unknown
    metadata?: unknown
    status?: WorkItemStatus
    lane?: WorkItemLane
    assigneeUserId?: string | null
    resolvedAt?: string | null
    reversedAt?: string | null
    idempotencyKey?: string | null
  },
): Promise<{ workItem: ContextWorkItemRow; event: ContextHandoffEventRow } | null> {
  const current = await executor.query<ContextWorkItemRow>(
    `select ${WORK_ITEM_COLUMNS}
       from context_work_items
      where company_id = $1 and id = $2
      for update`,
    [args.companyId, args.workItemId],
  )
  const existing = current.rows[0]
  if (!existing) return null
  const status = args.status ?? existing.status
  const lane = args.lane ?? existing.lane
  assertIn(WORK_ITEM_STATUSES, status, 'status')
  assertIn(WORK_ITEM_LANES, lane, 'lane')
  const eventArgs = {
    companyId: args.companyId,
    workItemId: args.workItemId,
    eventType: args.eventType,
    actorKind: args.actorKind,
    ...(args.actorUserId !== undefined ? { actorUserId: args.actorUserId } : {}),
    ...(args.actorRef !== undefined ? { actorRef: args.actorRef } : {}),
    ...(args.payload !== undefined ? { payload: args.payload } : {}),
    ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    captureSessionId: existing.capture_session_id,
  }
  const event = await appendContextHandoffEventTx(executor, eventArgs)
  const result = await executor.query<ContextWorkItemRow>(
    `update context_work_items
        set status = $3,
            lane = $4,
            assignee_user_id = $5,
            resolved_at = $6::timestamptz,
            reversed_at = $7::timestamptz,
            updated_at = now()
      where company_id = $1 and id = $2
      returning ${WORK_ITEM_COLUMNS}`,
    [
      args.companyId,
      args.workItemId,
      status,
      lane,
      args.assigneeUserId === undefined ? existing.assignee_user_id : optionalText(args.assigneeUserId),
      args.resolvedAt === undefined ? existing.resolved_at : args.resolvedAt,
      args.reversedAt === undefined ? existing.reversed_at : args.reversedAt,
    ],
  )
  const workItem = result.rows[0]
  if (!workItem) throw new Error('context_work_items update returned no row')
  return { workItem, event }
}

export async function listContextWorkItems(
  companyId: string,
  filters: {
    /**
     * Restrict to one of the two non-bleeding work-item domains (migration
     * 009). The work-requests.ts board/list/detail surface is the
     * field_request feature, so it always passes domain: 'field_request'; the
     * /issues surface passes 'app_issue'. Omitted = no domain filter.
     */
    domain?: WorkItemDomain | null
    status?: string | null
    lane?: string | null
    entityType?: string | null
    entityId?: string | null
    createdByUserId?: string | null
    assigneeUserId?: string | null
    visibleToUserId?: string | null
    limit: number
    offset: number
  },
): Promise<{ rows: ContextWorkItemRow[]; rowCount: number }> {
  const clauses = ['company_id = $1']
  const values: unknown[] = [companyId]
  if (filters.domain) {
    values.push(filters.domain)
    clauses.push(`domain = $${values.length}`)
  }
  if (filters.status) {
    values.push(filters.status)
    clauses.push(`status = $${values.length}`)
  }
  if (filters.lane) {
    values.push(filters.lane)
    clauses.push(`lane = $${values.length}`)
  }
  if (filters.entityType) {
    values.push(filters.entityType)
    clauses.push(`entity_type = $${values.length}`)
  }
  if (filters.entityId) {
    values.push(filters.entityId)
    clauses.push(`entity_id = $${values.length}`)
  }
  if (filters.createdByUserId) {
    values.push(filters.createdByUserId)
    clauses.push(`created_by_user_id = $${values.length}`)
  }
  if (filters.assigneeUserId) {
    values.push(filters.assigneeUserId)
    clauses.push(`assignee_user_id = $${values.length}`)
  }
  if (filters.visibleToUserId) {
    values.push(filters.visibleToUserId)
    clauses.push(`(created_by_user_id = $${values.length} or assignee_user_id = $${values.length})`)
  }
  values.push(filters.limit)
  values.push(filters.offset)
  return withCompanyClient(companyId, async (c) => {
    const result = await c.query<ContextWorkItemRow>(
      `select ${WORK_ITEM_COLUMNS}
         from context_work_items
        where ${clauses.join(' and ')}
        order by updated_at desc, created_at desc
        limit $${values.length - 1} offset $${values.length}`,
      values,
    )
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length }
  })
}

export async function getContextWorkItemWithEvents(
  companyId: string,
  workItemId: string,
  opts: { eventsLimit?: number; eventsOffset?: number } = {},
): Promise<ContextWorkItemDetail | null> {
  return withCompanyClient(companyId, async (c) => {
    const eventsLimit = Math.max(1, Math.min(500, Math.floor(opts.eventsLimit ?? 200)))
    const eventsOffset = Math.max(0, Math.floor(opts.eventsOffset ?? 0))
    const workItem = await c.query<
      ContextWorkItemRow & {
        support_packet: ContextWorkItemDetail['work_item']['support_packet']
      }
    >(
      `select ${PREFIXED_WORK_ITEM_COLUMNS},
              case when s.id is null then null else jsonb_build_object(
                'id', s.id,
                'route', s.route,
                'problem', s.problem,
                'request_id', s.request_id,
                'capture_session_id', s.capture_session_id,
                'build_sha', s.build_sha,
                'created_at', s.created_at,
                'expires_at', s.expires_at,
                'redaction_version', s.redaction_version
              ) end as support_packet
         from context_work_items w
         left join support_debug_packets s
           on s.company_id = w.company_id
          and s.id = w.support_packet_id
          and (s.expires_at is null or s.expires_at > now())
        where w.company_id = $1 and w.id = $2
        limit 1`,
      [companyId, workItemId],
    )
    const row = workItem.rows[0]
    if (!row) return null
    const events = await c.query<ContextHandoffEventRow>(
      `select ${HANDOFF_EVENT_COLUMNS}
         from context_handoff_events
        where company_id = $1 and work_item_id = $2
        order by recorded_at asc, id asc
        limit $3 offset $4`,
      [companyId, workItemId, eventsLimit, eventsOffset],
    )
    const eventCount = await c.query<{ count: string }>(
      `select count(*)::text as count
         from context_handoff_events
        where company_id = $1 and work_item_id = $2`,
      [companyId, workItemId],
    )
    const eventsTotal = Number(eventCount.rows[0]?.count ?? events.rows.length)
    return {
      work_item: row,
      events: events.rows,
      events_total: eventsTotal,
      events_limit: eventsLimit,
      events_offset: eventsOffset,
      events_truncated: eventsOffset + events.rows.length < eventsTotal,
    }
  })
}
