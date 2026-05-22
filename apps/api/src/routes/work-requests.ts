import type http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { buildPaginationMeta, isValidUuid, parsePagination, PAGINATION_MAX_LIMIT } from '../http-utils.js'
import { getRequestContext } from '@sitelayer/logger'
import { currentTraceHeaders, type LedgerExecutor, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { safeTokenEqual } from '../debug-trace.js'
import { observeContextHandoff } from '../metrics.js'
import {
  HANDOFF_EVENT_TYPES,
  WORK_ITEM_LANES,
  WORK_ITEM_SEVERITIES,
  WORK_ITEM_STATUSES,
  appendContextHandoffEventTx,
  createContextWorkItemTx,
  getContextWorkItemWithEvents,
  listContextWorkItems,
  updateContextWorkItemWithEventTx,
  type ContextHandoffEventRow,
  type ContextWorkItemRow,
  type HandoffEventType,
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

export type WorkRequestRouteCtx = {
  pool: Pool
  company: ActiveCompany
  identity: Identity
  tier: string
  buildSha: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const CREATE_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'member', 'bookkeeper']
const TRIAGE_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'bookkeeper']
const LIST_ROLES: readonly CompanyRole[] = CREATE_ROLES
const MAX_TITLE_LENGTH = 240
const MAX_SUMMARY_LENGTH = 4000
const MAX_STALE_SWEEP_LIMIT = 50
const DEFAULT_CALLBACK_TOKEN_TTL_HOURS = 72
const DISPATCH_MUTATION_TYPE = 'dispatch_mesh_work_request'
const HEALTH_WORK_STATUSES = ['agent_running', 'review_ready', 'review_stale', 'proposal_expired'] as const
const HEALTH_DISPATCH_STATUSES = ['pending', 'processing', 'failed', 'dead'] as const

type DispatchOutboxSummary = {
  id: string
  mutation_type: typeof DISPATCH_MUTATION_TYPE
  idempotency_key: string
  status: string
  attempt_count: number
  next_attempt_at: string | null
  applied_at: string | null
  error: string | null
}

type DispatchPayload = {
  work_item_id: string
  support_packet_id: string
  title: string
  summary: string | null
  route: string | null
  entity_type: string | null
  entity_id: string | null
  status: WorkItemStatus
  lane: WorkItemLane
  support_packet: unknown
  callback: {
    path: string
    url: string | null
    token: string
    token_type: 'scoped_bearer'
    expires_at: string
  }
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

function requireMeshDispatchConfigured(ctx: WorkRequestRouteCtx): boolean {
  if (process.env.MESH_WORK_REQUEST_DISPATCH_URL) return true
  ctx.sendJson(503, { error: 'mesh dispatch is not configured' })
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
    metadata: row.metadata,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505'
  )
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

async function getExistingCreateResponse(companyId: string, actorUserId: string, clientRequestId: string) {
  const workItemId = await getWorkItemIdByClientRequestId(companyId, actorUserId, clientRequestId)
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

async function getDispatchOutboxTx(
  executor: LedgerExecutor,
  companyId: string,
  idempotencyKey: string,
): Promise<DispatchOutboxSummary | null> {
  const result = await executor.query<DispatchOutboxSummary>(
    `select id, mutation_type, idempotency_key, status, attempt_count,
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

async function getHandoffEventByIdempotencyTx(
  executor: LedgerExecutor,
  companyId: string,
  idempotencyKey: string,
): Promise<ContextHandoffEventRow | null> {
  const result = await executor.query<ContextHandoffEventRow>(
    `select id, company_id, work_item_id, event_type, actor_kind, actor_user_id,
            actor_ref, source_system, payload, metadata, idempotency_key,
            causation_event_id, correlation_id, request_id, sentry_trace,
            sentry_baggage, build_sha, redaction_version, occurred_at, recorded_at
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
       sentry_trace, sentry_baggage, request_id
     ) values (
       $1, 'server', $2, 'context_work_item', $3,
       $4, $5::jsonb, $6, 'pending',
       $7, $8, $9
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
            updated_at = now()
      where company_id = $1
        and idempotency_key = $2
        and mutation_type = $3
        and status in ('failed', 'dead')
      returning id, mutation_type, idempotency_key, status, attempt_count,
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
  row: ContextWorkItemRow & { support_packet?: unknown },
  callbackToken: string,
): DispatchPayload {
  const callbackPath = `/api/work-requests/${row.id}/agent-callback`
  return {
    work_item_id: row.id,
    support_packet_id: row.support_packet_id,
    title: row.title,
    summary: row.summary,
    route: row.route,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    status: row.status,
    lane: row.lane,
    support_packet: row.support_packet ?? null,
    callback: {
      path: callbackPath,
      url: callbackUrlForPath(req, callbackPath),
      token: callbackToken,
      token_type: 'scoped_bearer',
      expires_at: callbackTokenExpiresAt(),
    },
  }
}

async function createWorkRequest(req: http.IncomingMessage, ctx: WorkRequestRouteCtx) {
  if (!ctx.requireRole(CREATE_ROLES)) return
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
  const route = optionalText(body.route, 500) ?? readClientRoute(client)
  const entity = firstEntityRef(client)
  const retentionDays = Math.max(1, Math.min(90, Number(process.env.SUPPORT_PACKET_RETENTION_DAYS ?? 30)))
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const clientIdempotency =
    optionalText(body.client_request_id, 160) ?? optionalText(headerText(req.headers['idempotency-key']), 160)
  if (clientIdempotency) {
    const existing = await getExistingCreateResponse(ctx.company.id, ctx.identity.userId, clientIdempotency)
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
        buildSha: ctx.buildSha,
        problem: summary ?? title.value,
        client,
        serverContext: serverContext as JsonRecord,
        expiresAt,
        redactionVersion: 'support-packet-v1',
      })
      const item = await createContextWorkItemTx(c, {
        companyId: ctx.company.id,
        supportPacketId: packet.id,
        title: title.value,
        summary,
        status: 'new',
        lane,
        severity,
        route,
        entityType: entity.entityType,
        entityId: entity.entityId,
        createdByUserId: ctx.identity.userId,
        metadata: {
          category,
          source: 'work_request',
          client_request_id: clientIdempotency,
          support_packet_expires_at: packet.expires_at ?? expiresAt,
        },
      })
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
          support_packet_id: packet.id,
        },
        metadata: { category, evidence_refs: [{ type: 'support_debug_packet', id: packet.id }] },
        idempotencyKey: `work_item:create:${packet.id}`,
        buildSha: ctx.buildSha,
      })
      return { packet, item, event }
    })
  } catch (error) {
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
  if (!ctx.requireRole(LIST_ROLES)) return
  const pagination = parsePagination(url.searchParams, { defaultLimit: 50, maxLimit: PAGINATION_MAX_LIMIT })
  if (!pagination.ok) {
    ctx.sendJson(400, { error: pagination.error })
    return
  }
  const rows = await listContextWorkItems(ctx.company.id, {
    status: url.searchParams.get('status'),
    entityType: url.searchParams.get('entity_type'),
    entityId: url.searchParams.get('entity_id'),
    createdByUserId: roleScopedCreatedBy(
      ctx.company.role,
      ctx.identity.userId,
      url.searchParams.get('created_by_user_id'),
    ),
    assigneeUserId: url.searchParams.get('assignee_user_id'),
    limit: pagination.value.limit,
    offset: pagination.value.offset,
  })
  ctx.sendJson(200, {
    work_items: rows.rows.map(workItemResponse),
    pagination: buildPaginationMeta(pagination.value, rows.rowCount ?? rows.rows.length),
  })
}

async function getWorkRequestQueueHealth(ctx: WorkRequestRouteCtx) {
  if (!ctx.requireRole(TRIAGE_ROLES)) return
  const health = await withCompanyClient(ctx.company.id, async (c) => {
    const workStatuses = await c.query<{ status: string; count: number }>(
      `select status, count(*)::int as count
         from context_work_items
        where company_id = $1
          and status = any($2::text[])
        group by status`,
      [ctx.company.id, [...HEALTH_WORK_STATUSES]],
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
    return {
      config: {
        mesh_dispatch_configured: Boolean(process.env.MESH_WORK_REQUEST_DISPATCH_URL),
        callback_configured: true,
        scoped_callbacks_enabled: true,
        callback_fallback_configured: Boolean(process.env.SITELAYER_WORK_REQUEST_WEBHOOK_TOKEN),
      },
      work_items: countsFor(HEALTH_WORK_STATUSES, workStatuses.rows),
      dispatch_outbox: {
        ...countsFor(HEALTH_DISPATCH_STATUSES, dispatchStatuses.rows),
        oldest_pending_age_seconds: oldestDispatch.rows[0]?.oldest_pending_age_seconds ?? null,
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
  if (!detail) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  ctx.sendJson(200, {
    work_item: workItemResponse(detail.work_item),
    support_packet: detail.work_item.support_packet,
    dispatch_outbox: await getDispatchOutbox(ctx.company.id, id),
    events: detail.events,
    events_pagination: {
      limit: detail.events_limit,
      offset: detail.events_offset,
      total: detail.events_total,
      has_more: detail.events_truncated,
    },
  })
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
  if (!ctx.requireRole(TRIAGE_ROLES)) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!detail) {
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
  if (eventType !== 'message.added' && eventType !== 'resolution.reopened' && !ctx.requireRole(TRIAGE_ROLES)) {
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!detail) {
    ctx.sendJson(404, { error: 'work request not found' })
    return
  }
  if (!canReadWorkItem(ctx.company.role, ctx.identity.userId, detail.work_item)) {
    ctx.sendJson(403, { error: 'forbidden' })
    return
  }
  const status = parseAllowed(body.status, WORK_ITEM_STATUSES) as WorkItemStatus | null
  const lane = parseAllowed(body.lane, WORK_ITEM_LANES) as WorkItemLane | null
  if (body.status !== undefined && body.status !== null && !status) {
    ctx.sendJson(400, { error: `status must be one of ${WORK_ITEM_STATUSES.join(', ')}` })
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
  if (!ctx.requireRole(TRIAGE_ROLES)) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  if (!requireMeshDispatchConfigured(ctx)) return
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!detail) {
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
  const payload = buildDispatchPayload(req, detail.work_item, callbackToken)
  const result = await withMutationTx(ctx.company.id, async (c) => {
    const existingOutbox = await getDispatchOutboxTx(c, ctx.company.id, idempotencyKey)
    if (existingOutbox) {
      return {
        workItem: detail.work_item,
        event: await getHandoffEventByIdempotencyTx(c, ctx.company.id, idempotencyKey),
        outbox: existingOutbox,
        dispatchQueued: false,
      }
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
        dispatcher: 'mesh',
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
    return { ...updated, outbox, dispatchQueued: true }
  })
  if (!result) {
    ctx.sendJson(404, { error: 'work request not found' })
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
  if (!ctx.requireRole(TRIAGE_ROLES)) return
  if (!isValidUuid(id)) {
    ctx.sendJson(400, { error: 'invalid work request id' })
    return
  }
  if (!requireMeshDispatchConfigured(ctx)) return
  let body: Record<string, unknown>
  try {
    body = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid JSON body' })
    return
  }
  const detail = await getContextWorkItemWithEvents(ctx.company.id, id)
  if (!detail) {
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
  const payload = buildDispatchPayload(req, detail.work_item, callbackToken)
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
        dispatcher: 'mesh',
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
  const eventType = parseAllowed(body.event_type, HANDOFF_EVENT_TYPES) as HandoffEventType | null
  if (
    !eventType ||
    ![
      'agent.dispatch_acknowledged',
      'agent.message_received',
      'agent.artifact_attached',
      'agent.proposal_ready',
      'agent.completed',
      'human.review_requested',
    ].includes(eventType)
  ) {
    ctx.sendJson(400, { error: 'event_type must be an agent callback event' })
    return
  }
  const next = deriveAgentCallbackState(eventType, body)
  const updated = await withMutationTx(ctx.company.id, (c) =>
    updateContextWorkItemWithEventTx(c, {
      companyId: ctx.company.id,
      workItemId: id,
      eventType,
      actorKind: 'agent',
      actorRef: optionalText(body.agent_ref, 200) ?? 'mesh',
      payload: {
        message: optionalText(body.message, MAX_SUMMARY_LENGTH),
        body: optionalText(body.body, MAX_SUMMARY_LENGTH),
        url: optionalText(body.url, 1000),
        artifacts: body.artifacts ?? null,
        status: next.status ?? null,
        lane: next.lane ?? null,
      },
      metadata: body.metadata ?? {},
      ...(next.status ? { status: next.status } : {}),
      ...(next.lane ? { lane: next.lane } : {}),
      ...(optionalText(body.idempotency_key, 200) ? { idempotencyKey: optionalText(body.idempotency_key, 200) } : {}),
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

async function sweepStaleWorkRequests(ctx: WorkRequestRouteCtx) {
  if (!ctx.requireRole(TRIAGE_ROLES)) return
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
          and status in ('agent_running', 'review_ready')
          and updated_at < now() - make_interval(hours => $2::int)
        order by updated_at asc
        limit $3
        for update skip locked`,
      [ctx.company.id, Math.floor(thresholdHours), limit],
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

  const dispatchMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/dispatch\/mesh$/)
  if (dispatchMatch && req.method === 'POST') {
    await dispatchWorkRequestToMesh(req, ctx, decodeURIComponent(dispatchMatch[1]!))
    return true
  }

  const dispatchRetryMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)\/dispatch\/mesh\/retry$/)
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

  const detailMatch = url.pathname.match(/^\/api\/work-requests\/([^/]+)$/)
  if (detailMatch && req.method === 'GET') {
    await getWorkRequest(ctx, decodeURIComponent(detailMatch[1]!), url)
    return true
  }

  return false
}
