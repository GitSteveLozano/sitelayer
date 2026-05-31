import type http from 'node:http'
import type { Pool } from 'pg'
import { getRequestContext } from '@sitelayer/logger'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Identity } from '../auth.js'
import { isValidUuid } from '../http-utils.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'

export type CaptureSessionRouteCtx = {
  pool: Pool
  company: ActiveCompany
  identity: Identity
  buildSha: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const CREATE_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'member', 'bookkeeper']
const READ_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'bookkeeper']
const MODES = ['trace', 'feedback', 'desktop', 'native', 'manual_upload'] as const
const STATUSES = ['open', 'stopped', 'discarded', 'failed'] as const
const MAX_EVENTS = 100
const MAX_ARTIFACTS = 25

type CaptureSessionRow = {
  id: string
  company_id: string
  actor_user_id: string | null
  mode: string
  status: string
  route_path: string | null
  device_kind: string | null
  platform: string | null
  viewport: string | null
  app_build_sha: string | null
  consent_version: string
  redaction_version: string
  metadata: Record<string, unknown>
  started_at: string
  last_seen_at: string
  stopped_at: string | null
  discarded_at: string | null
  retention_expires_at: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  if (typeof value !== 'string') return fallback
  return allowed.includes(value as T[number]) ? (value as T[number]) : fallback
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function captureSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/capture-sessions\/([^/]+)(?:\/.*)?$/)
  const id = match?.[1]
  return id && isValidUuid(id) ? id : null
}

function responseRow(row: CaptureSessionRow): CaptureSessionRow {
  return row
}

async function upsertCaptureSession(ctx: CaptureSessionRouteCtx) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const body = await ctx.readBody()
  const id = optionalText(body.id ?? body.capture_session_id, 80)
  if (!id || !isValidUuid(id)) {
    ctx.sendJson(400, { error: 'capture_session_id must be a uuid' })
    return
  }
  const rawRetentionDays = Number(body.retention_days ?? 30)
  const retentionDays = Number.isFinite(rawRetentionDays) ? Math.max(1, Math.min(90, rawRetentionDays)) : 30
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const mode = enumValue(body.mode, MODES, 'trace')
  const metadata = jsonRecord(body.metadata)
  const row = await withMutationTx(ctx.company.id, async (c) => {
    const result = await c.query<CaptureSessionRow>(
      `insert into capture_sessions (
         id, company_id, actor_user_id, mode, status, route_path, device_kind,
         platform, viewport, app_build_sha, consent_version, metadata,
         retention_expires_at
       ) values (
         $1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz
       )
       on conflict (id) do update set
         last_seen_at = now(),
         route_path = coalesce(excluded.route_path, capture_sessions.route_path),
         device_kind = coalesce(excluded.device_kind, capture_sessions.device_kind),
         platform = coalesce(excluded.platform, capture_sessions.platform),
         viewport = coalesce(excluded.viewport, capture_sessions.viewport),
         app_build_sha = coalesce(excluded.app_build_sha, capture_sessions.app_build_sha),
         consent_version = coalesce(nullif(excluded.consent_version, ''), capture_sessions.consent_version),
         metadata = capture_sessions.metadata || excluded.metadata
       where capture_sessions.company_id = excluded.company_id
       returning *`,
      [
        id,
        ctx.company.id,
        ctx.identity.userId,
        mode,
        optionalText(body.route_path, 500) ?? getRequestContext()?.route ?? null,
        optionalText(body.device_kind, 80),
        optionalText(body.platform, 80),
        optionalText(body.viewport, 80),
        optionalText(body.app_build_sha, 120) ?? ctx.buildSha,
        optionalText(body.consent_version, 80) ?? '',
        JSON.stringify(metadata),
        expiresAt,
      ],
    )
    return result.rows[0] ?? null
  })
  if (!row) {
    ctx.sendJson(409, { error: 'capture_session_id belongs to another company' })
    return
  }
  ctx.sendJson(200, { capture_session: responseRow(row) })
}

async function patchCaptureSession(ctx: CaptureSessionRouteCtx, id: string) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const body = await ctx.readBody()
  const status = body.status === undefined ? null : enumValue(body.status, STATUSES, 'open')
  const metadata = jsonRecord(body.metadata)
  const result = await withMutationTx(ctx.company.id, (c) =>
    c.query<CaptureSessionRow>(
      `update capture_sessions
          set status = coalesce($3, status),
              route_path = coalesce($4, route_path),
              metadata = metadata || $5::jsonb,
              last_seen_at = now(),
              stopped_at = case when $3 = 'stopped' then now() else stopped_at end,
              discarded_at = case when $3 = 'discarded' then now() else discarded_at end
        where id = $1 and company_id = $2
        returning *`,
      [id, ctx.company.id, status, optionalText(body.route_path, 500), JSON.stringify(metadata)],
    ),
  )
  const row = result.rows[0]
  if (!row) {
    ctx.sendJson(404, { error: 'capture session not found' })
    return
  }
  ctx.sendJson(200, { capture_session: responseRow(row) })
}

async function appendCaptureSessionEvents(ctx: CaptureSessionRouteCtx, id: string) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const body = await ctx.readBody()
  const rawEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : []
  if (rawEvents.length === 0) {
    ctx.sendJson(400, { error: 'events array is required' })
    return
  }
  const requestId = getRequestContext()?.requestId ?? null
  let inserted = 0
  await withMutationTx(ctx.company.id, async (c) => {
    const exists = await c.query<{ id: string }>(
      `select id from capture_sessions where id = $1 and company_id = $2 limit 1`,
      [id, ctx.company.id],
    )
    if (!exists.rows[0]) return
    for (const [index, raw] of rawEvents.entries()) {
      if (!isRecord(raw)) continue
      const eventType = optionalText(raw.event_type, 160)
      if (!eventType) continue
      const result = await c.query<{ id: string }>(
        `insert into capture_session_events (
           company_id, capture_session_id, seq, client_event_id, event_type,
           event_class, route_path, workflow_id, entity_type, entity_id,
           request_id, payload, occurred_at
         ) values (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9, $10,
           $11, $12::jsonb, coalesce($13::timestamptz, now())
         )
         on conflict (company_id, capture_session_id, client_event_id) where client_event_id is not null do nothing
         returning id`,
        [
          ctx.company.id,
          id,
          typeof raw.seq === 'number' ? Math.trunc(raw.seq) : index,
          optionalText(raw.client_event_id, 160),
          eventType,
          optionalText(raw.event_class, 120) ?? '',
          optionalText(raw.route_path, 500),
          optionalText(raw.workflow_id, 160),
          optionalText(raw.entity_type, 120),
          optionalText(raw.entity_id, 160),
          requestId,
          JSON.stringify(jsonRecord(raw.payload)),
          optionalText(raw.occurred_at, 80),
        ],
      )
      if (result.rows[0]) inserted++
    }
    await c.query(`update capture_sessions set last_seen_at = now() where id = $1 and company_id = $2`, [
      id,
      ctx.company.id,
    ])
  })
  ctx.sendJson(202, { accepted: inserted })
}

async function appendCaptureArtifacts(ctx: CaptureSessionRouteCtx, id: string) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const body = await ctx.readBody()
  const rawArtifacts = Array.isArray(body.artifacts) ? body.artifacts.slice(0, MAX_ARTIFACTS) : []
  if (rawArtifacts.length === 0) {
    ctx.sendJson(400, { error: 'artifacts array is required' })
    return
  }
  let inserted = 0
  await withMutationTx(ctx.company.id, async (c) => {
    const exists = await c.query<{ id: string }>(
      `select id from capture_sessions where id = $1 and company_id = $2 limit 1`,
      [id, ctx.company.id],
    )
    if (!exists.rows[0]) return
    for (const raw of rawArtifacts) {
      if (!isRecord(raw)) continue
      const kind = optionalText(raw.kind, 80)
      if (!kind) continue
      const result = await c.query<{ id: string }>(
        `insert into capture_artifacts (
           company_id, capture_session_id, kind, storage_key, uri, content_type,
           byte_size, content_hash, duration_ms, pii_level, access_policy,
           metadata, retention_expires_at
         ) values (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12::jsonb, $13::timestamptz
         )
         returning id`,
        [
          ctx.company.id,
          id,
          kind,
          optionalText(raw.storage_key, 500),
          optionalText(raw.uri, 1000),
          optionalText(raw.content_type, 160),
          typeof raw.byte_size === 'number' ? Math.max(0, Math.trunc(raw.byte_size)) : null,
          optionalText(raw.content_hash, 160),
          typeof raw.duration_ms === 'number' ? Math.max(0, Math.trunc(raw.duration_ms)) : null,
          enumValue(raw.pii_level, ['low', 'internal', 'private', 'restricted'] as const, 'internal'),
          enumValue(raw.access_policy, ['support_only', 'operator_only', 'tenant_visible'] as const, 'support_only'),
          JSON.stringify(jsonRecord(raw.metadata)),
          optionalText(raw.retention_expires_at, 80),
        ],
      )
      if (result.rows[0]) inserted++
    }
    await c.query(`update capture_sessions set last_seen_at = now() where id = $1 and company_id = $2`, [
      id,
      ctx.company.id,
    ])
  })
  ctx.sendJson(202, { accepted: inserted })
}

async function getCaptureSession(ctx: CaptureSessionRouteCtx, id: string) {
  if (!ctx.requireRole(READ_ROLES)) return
  const result = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{
      session: CaptureSessionRow
      event_count: string
      artifact_count: string
    }>(
      `select
         to_jsonb(s.*) as session,
         (select count(*) from capture_session_events e where e.company_id = s.company_id and e.capture_session_id = s.id)::text as event_count,
         (select count(*) from capture_artifacts a where a.company_id = s.company_id and a.capture_session_id = s.id and a.deleted_at is null)::text as artifact_count
       from capture_sessions s
       where s.id = $1 and s.company_id = $2
       limit 1`,
      [id, ctx.company.id],
    ),
  )
  const row = result.rows[0]
  if (!row) {
    ctx.sendJson(404, { error: 'capture session not found' })
    return
  }
  ctx.sendJson(200, {
    capture_session: row.session,
    event_count: Number(row.event_count),
    artifact_count: Number(row.artifact_count),
  })
}

export async function handleCaptureSessionRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: CaptureSessionRouteCtx,
): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/capture-sessions') {
    await upsertCaptureSession(ctx)
    return true
  }

  const id = captureSessionIdFromPath(url.pathname)
  if (!id) return false

  if (req.method === 'GET' && url.pathname === `/api/capture-sessions/${id}`) {
    await getCaptureSession(ctx, id)
    return true
  }
  if (req.method === 'PATCH' && url.pathname === `/api/capture-sessions/${id}`) {
    await patchCaptureSession(ctx, id)
    return true
  }
  if (req.method === 'POST' && url.pathname === `/api/capture-sessions/${id}/events`) {
    await appendCaptureSessionEvents(ctx, id)
    return true
  }
  if (req.method === 'POST' && url.pathname === `/api/capture-sessions/${id}/artifacts`) {
    await appendCaptureArtifacts(ctx, id)
    return true
  }

  return false
}
