import type http from 'node:http'
import { getRequestContext } from '@sitelayer/logger'
import type { Pool } from 'pg'
import type { ActiveCompany } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { parseTraceIdFromSentryTraceHeader } from '../debug-trace.js'
import { observeSupportPacket } from '../metrics.js'

type JsonRecord = Record<string, unknown>

export type SupportPacketRouteCtx = {
  pool: Pool
  company: ActiveCompany
  identity: Identity
  tier: string
  buildSha: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

type SupportPacketRow = {
  id: string
  company_id: string
  actor_user_id: string
  request_id: string | null
  route: string | null
  build_sha: string | null
  problem: string | null
  client: JsonRecord
  server_context: JsonRecord
  created_at: string
  expires_at: string | null
  redaction_version: string
}

const REDACTION_VERSION = 'support-packet-v1'
const MAX_STRING_LENGTH = 4000
const MAX_ARRAY_LENGTH = 100
const MAX_OBJECT_KEYS = 150
const SENSITIVE_KEY =
  /authorization|cookie|password|passwd|secret|token|jwt|session|csrf|api[-_]?key|access[-_]?token|refresh[-_]?token/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redactString(value: string, maxLength = MAX_STRING_LENGTH): string {
  const redacted = value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, '[phone]')
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength)}...[truncated]` : redacted
}

export function sanitizeSupportJson(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[max_depth]'
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return redactString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeSupportJson(entry, depth + 1))
  }
  if (isRecord(value)) {
    const output: JsonRecord = {}
    for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitizeSupportJson(entry, depth + 1)
    }
    return output
  }
  return String(value)
}

function jsonRecord(value: unknown): JsonRecord {
  const sanitized = sanitizeSupportJson(value)
  return isRecord(sanitized) ? sanitized : { value: sanitized }
}

function addBounded(set: Set<string>, value: string | null | undefined, limit: number): void {
  if (!value || set.size >= limit) return
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 160) return
  set.add(trimmed)
}

export function collectRequestIds(client: unknown, currentRequestId: string | undefined, limit = 80): string[] {
  const requestIds = new Set<string>()
  addBounded(requestIds, currentRequestId, limit)

  function walk(value: unknown): void {
    if (requestIds.size >= limit) return
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, MAX_ARRAY_LENGTH)) walk(entry)
      return
    }
    if (!isRecord(value)) return
    for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const normalizedKey = key.replace(/[-_]/g, '').toLowerCase()
      if (
        typeof entry === 'string' &&
        (normalizedKey === 'requestid' || normalizedKey === 'responserequestid' || normalizedKey === 'xrequestid')
      ) {
        addBounded(requestIds, entry, limit)
      }
      walk(entry)
    }
  }

  walk(client)
  return Array.from(requestIds)
}

function collectProjectIds(client: unknown, limit = 20): string[] {
  const projectIds = new Set<string>()
  const projectKeys = new Set(['projectid', 'selectedprojectid', 'activeprojectid'])

  function walk(value: unknown): void {
    if (projectIds.size >= limit) return
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, MAX_ARRAY_LENGTH)) walk(entry)
      return
    }
    if (!isRecord(value)) return
    for (const [key, entry] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const normalizedKey = key.replace(/[-_]/g, '').toLowerCase()
      if (typeof entry === 'string' && projectKeys.has(normalizedKey) && UUID_RE.test(entry)) {
        projectIds.add(entry)
      }
      walk(entry)
    }
  }

  walk(client)
  return Array.from(projectIds)
}

function readClientRoute(client: JsonRecord): string | null {
  const page = client.page
  if (isRecord(page) && typeof page.path === 'string') return page.path
  return getRequestContext()?.route ?? null
}

async function fetchAuditContext(pool: Pool, companyId: string, actorUserId: string, requestIds: string[]) {
  const values: unknown[] = [companyId]
  const clauses: string[] = []
  if (requestIds.length) {
    values.push(requestIds)
    clauses.push(`request_id = any($${values.length}::text[])`)
  }
  values.push(actorUserId)
  const actorParam = values.length
  clauses.push(`(actor_user_id = $${actorParam} and created_at >= now() - interval '2 hours')`)
  values.push(100)
  const limitParam = values.length
  const result = await pool.query(
    `select id, actor_user_id, actor_role, entity_type, entity_id, action, before, after, request_id, sentry_trace, created_at
       from audit_events
      where company_id = $1 and (${clauses.join(' or ')})
      order by created_at desc
      limit $${limitParam}`,
    values,
  )
  return sanitizeSupportJson(result.rows)
}

async function fetchQueueContext(pool: Pool, companyId: string, requestIds: string[]) {
  if (!requestIds.length) return { outbox: [], syncEvents: [] }
  const [outbox, syncEvents] = await Promise.all([
    pool.query(
      `select id, entity_type, entity_id, mutation_type, status, attempt_count, next_attempt_at,
              applied_at, error, created_at, request_id, sentry_trace
         from mutation_outbox
        where company_id = $1 and request_id = any($2::text[])
        order by created_at desc
        limit 100`,
      [companyId, requestIds],
    ),
    pool.query(
      `select id, entity_type, entity_id, direction, status, attempt_count, next_attempt_at,
              applied_at, error, created_at, request_id, sentry_trace
         from sync_events
        where company_id = $1 and request_id = any($2::text[])
        order by created_at desc
        limit 100`,
      [companyId, requestIds],
    ),
  ])
  return {
    outbox: sanitizeSupportJson(outbox.rows),
    syncEvents: sanitizeSupportJson(syncEvents.rows),
  }
}

async function fetchQueueDepth(pool: Pool, companyId: string) {
  const [outbox, syncEvents] = await Promise.all([
    pool.query<{ count: string }>(
      `select count(*)::text as count
         from mutation_outbox
        where company_id = $1 and status in ('pending', 'processing')`,
      [companyId],
    ),
    pool.query<{ count: string }>(
      `select count(*)::text as count
         from sync_events
        where company_id = $1 and status in ('pending', 'processing')`,
      [companyId],
    ),
  ])
  return {
    mutation_outbox_pending: Number(outbox.rows[0]?.count ?? 0),
    sync_events_pending: Number(syncEvents.rows[0]?.count ?? 0),
  }
}

function countMap(rows: Array<{ project_id: string; count: string }>): Record<string, number> {
  const output: Record<string, number> = {}
  for (const row of rows) output[row.project_id] = Number(row.count)
  return output
}

async function fetchDomainSnapshot(pool: Pool, companyId: string, projectIds: string[]) {
  if (!projectIds.length) return { entity_refs: { project_ids: [] }, projects: [] }
  const [projects, measurements, materialBills, laborEntries, schedules, blueprints] = await Promise.all([
    pool.query(
      `select id, status, division_code, version, closed_at, summary_locked_at, updated_at
         from projects
        where company_id = $1 and id = any($2::uuid[])
        order by updated_at desc
        limit 20`,
      [companyId, projectIds],
    ),
    pool.query<{ project_id: string; count: string }>(
      `select project_id, count(*)::text as count
         from takeoff_measurements
        where company_id = $1 and project_id = any($2::uuid[]) and deleted_at is null
        group by project_id`,
      [companyId, projectIds],
    ),
    pool.query<{ project_id: string; count: string }>(
      `select project_id, count(*)::text as count
         from material_bills
        where company_id = $1 and project_id = any($2::uuid[]) and deleted_at is null
        group by project_id`,
      [companyId, projectIds],
    ),
    pool.query<{ project_id: string; count: string }>(
      `select project_id, count(*)::text as count
         from labor_entries
        where company_id = $1 and project_id = any($2::uuid[]) and deleted_at is null
        group by project_id`,
      [companyId, projectIds],
    ),
    pool.query<{ project_id: string; count: string }>(
      `select project_id, count(*)::text as count
         from crew_schedules
        where company_id = $1 and project_id = any($2::uuid[]) and deleted_at is null
        group by project_id`,
      [companyId, projectIds],
    ),
    pool.query<{ project_id: string; count: string }>(
      `select project_id, count(*)::text as count
         from blueprint_documents
        where company_id = $1 and project_id = any($2::uuid[]) and deleted_at is null
        group by project_id`,
      [companyId, projectIds],
    ),
  ])
  const measurementCounts = countMap(measurements.rows)
  const materialBillCounts = countMap(materialBills.rows)
  const laborEntryCounts = countMap(laborEntries.rows)
  const scheduleCounts = countMap(schedules.rows)
  const blueprintCounts = countMap(blueprints.rows)
  return {
    entity_refs: { project_ids: projectIds },
    projects: projects.rows.map((project) => ({
      ...project,
      counts: {
        measurements: measurementCounts[project.id] ?? 0,
        material_bills: materialBillCounts[project.id] ?? 0,
        labor_entries: laborEntryCounts[project.id] ?? 0,
        schedules: scheduleCounts[project.id] ?? 0,
        blueprints: blueprintCounts[project.id] ?? 0,
      },
    })),
  }
}

function collectTraceIds(value: unknown): string[] {
  const traces = new Set<string>()
  function walk(entry: unknown): void {
    if (traces.size >= 40) return
    if (Array.isArray(entry)) {
      for (const item of entry.slice(0, MAX_ARRAY_LENGTH)) walk(item)
      return
    }
    if (!isRecord(entry)) return
    for (const [key, child] of Object.entries(entry).slice(0, MAX_OBJECT_KEYS)) {
      if (key === 'sentry_trace' && typeof child === 'string') {
        const traceId = parseTraceIdFromSentryTraceHeader(child)
        if (traceId) traces.add(traceId)
      }
      walk(child)
    }
  }
  walk(value)
  return Array.from(traces)
}

export async function buildSupportServerContext({
  pool,
  company,
  identity,
  tier,
  buildSha,
  client,
}: {
  pool: Pool
  company: ActiveCompany
  identity: Identity
  tier: string
  buildSha: string
  client: JsonRecord
}) {
  const requestIds = collectRequestIds(client, getRequestContext()?.requestId)
  const projectIds = collectProjectIds(client)
  const [auditEvents, queue, queueDepth, domainSnapshot] = await Promise.all([
    fetchAuditContext(pool, company.id, identity.userId, requestIds),
    fetchQueueContext(pool, company.id, requestIds),
    fetchQueueDepth(pool, company.id),
    fetchDomainSnapshot(pool, company.id, projectIds),
  ])
  const traceIds = collectTraceIds({ auditEvents, queue })
  return {
    captured_at: new Date().toISOString(),
    tier,
    build_sha: buildSha,
    company: {
      id: company.id,
      slug: company.slug,
      role: company.role,
    },
    actor: {
      user_id: identity.userId,
      source: identity.source,
    },
    request_ids: requestIds,
    trace_ids: traceIds,
    queue_depth: queueDepth,
    audit_events: auditEvents,
    queue,
    domain_snapshot: sanitizeSupportJson(domainSnapshot),
  }
}

function buildAgentPrompt(row: SupportPacketRow): string {
  const requestIds = Array.isArray(row.server_context.request_ids)
    ? row.server_context.request_ids.filter((entry) => typeof entry === 'string').slice(0, 12)
    : []
  const traceIds = Array.isArray(row.server_context.trace_ids)
    ? row.server_context.trace_ids.filter((entry) => typeof entry === 'string').slice(0, 8)
    : []
  return [
    `Investigate Sitelayer support packet ${row.id}.`,
    `User problem: ${row.problem || 'not provided'}`,
    `Route: ${row.route || 'unknown'}`,
    `Actor: ${row.actor_user_id}`,
    `Build: ${row.build_sha || 'unknown'}`,
    `Request IDs: ${requestIds.join(', ') || 'none captured'}`,
    `Trace IDs: ${traceIds.join(', ') || 'none captured'}`,
    'Use the attached support_packet JSON as the source of truth. Correlate the client timeline, API requests, audit events, queue rows, and domain snapshot before suggesting a cause.',
  ].join('\n')
}

async function createSupportPacket(ctx: SupportPacketRouteCtx) {
  const body = await ctx.readBody()
  const problemSource = typeof body.problem === 'string' ? body.problem : ''
  const problem = problemSource.trim() ? redactString(problemSource.trim(), 4000) : null
  const client = jsonRecord(body.client ?? body)
  const serverContext = await buildSupportServerContext({
    pool: ctx.pool,
    company: ctx.company,
    identity: ctx.identity,
    tier: ctx.tier,
    buildSha: ctx.buildSha,
    client,
  })
  const requestId = getRequestContext()?.requestId ?? null
  const route = readClientRoute(client)
  const retentionDays = Math.max(1, Math.min(90, Number(process.env.SUPPORT_PACKET_RETENTION_DAYS ?? 30)))
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const result = await ctx.pool.query<{ id: string; created_at: string; expires_at: string | null }>(
    `insert into support_debug_packets (
       company_id, actor_user_id, request_id, route, build_sha, problem, client, server_context, expires_at, redaction_version
     ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::timestamptz, $10)
     returning id, created_at, expires_at`,
    [
      ctx.company.id,
      ctx.identity.userId,
      requestId,
      route,
      ctx.buildSha,
      problem,
      JSON.stringify(client),
      JSON.stringify(serverContext),
      expiresAt,
      REDACTION_VERSION,
    ],
  )
  const row = result.rows[0]
  if (!row) {
    ctx.sendJson(500, { error: 'support packet insert failed', request_id: requestId })
    return
  }
  observeSupportPacket('created')
  ctx.sendJson(201, {
    support_id: row.id,
    request_id: requestId,
    expires_at: row.expires_at ?? expiresAt,
  })
}

async function getSupportPacket(ctx: SupportPacketRouteCtx, id: string) {
  if (!ctx.requireRole(['admin'])) return
  if (!UUID_RE.test(id)) {
    ctx.sendJson(400, { error: 'invalid support packet id' })
    return
  }
  const result = await ctx.pool.query<SupportPacketRow>(
    `select id, company_id, actor_user_id, request_id, route, build_sha, problem,
            client, server_context, created_at, expires_at, redaction_version
       from support_debug_packets
      where id = $1 and company_id = $2 and (expires_at is null or expires_at > now())
      limit 1`,
    [id, ctx.company.id],
  )
  const row = result.rows[0]
  if (!row) {
    ctx.sendJson(404, { error: 'support packet not found' })
    return
  }
  ctx.sendJson(200, { support_packet: row, agent_prompt: buildAgentPrompt(row) })
}

async function listSupportPackets(ctx: SupportPacketRouteCtx, url: URL) {
  if (!ctx.requireRole(['admin'])) return
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 25)))
  const result = await ctx.pool.query(
    `select id, actor_user_id, request_id, route, build_sha, problem, created_at, expires_at, redaction_version
       from support_debug_packets
      where company_id = $1 and (expires_at is null or expires_at > now())
      order by created_at desc
      limit $2`,
    [ctx.company.id, limit],
  )
  ctx.sendJson(200, { support_packets: result.rows })
}

export async function handleSupportPacketRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: SupportPacketRouteCtx,
): Promise<boolean> {
  if (url.pathname === '/api/support-packets' && req.method === 'POST') {
    await createSupportPacket(ctx)
    return true
  }

  if (url.pathname === '/api/support-packets' && req.method === 'GET') {
    await listSupportPackets(ctx, url)
    return true
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/support-packets/')) {
    const id = url.pathname.slice('/api/support-packets/'.length)
    if (!id || id.includes('/')) {
      ctx.sendJson(400, { error: 'invalid support packet id' })
      return true
    }
    await getSupportPacket(ctx, decodeURIComponent(id))
    return true
  }

  return false
}
