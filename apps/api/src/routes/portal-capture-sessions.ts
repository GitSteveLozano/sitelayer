import type http from 'node:http'
import { getRequestContext } from '@sitelayer/logger'
import type { Pool } from 'pg'
import { CaptureArtifactUploadError, parseCaptureArtifactMultipart } from '../capture-artifact-upload.js'
import { isValidUuid } from '../http-utils.js'
import { withMutationTx } from '../mutation-tx.js'
import type { BlueprintStorage } from '../storage.js'

const MODES = ['trace', 'feedback', 'desktop', 'native', 'manual_upload'] as const
const MAX_EVENTS = 100
const CAPTURE_REDACTION_VERSION = 'capture-session-v1'

export type PortalCaptureRouteCtx = {
  pool: Pool
  storage?: BlueprintStorage | undefined
  maxArtifactBytes?: number | undefined
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

export type PortalCaptureActor = {
  companyId: string
  actorRef: string
  authority: 'signed_estimate_share_token' | 'signed_rental_share_token'
  surface: 'estimate_portal' | 'rental_portal'
  metadata?: Record<string, unknown>
  consentScope?: Record<string, unknown>
}

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
  consent_actor_kind?: string | null
  consent_actor_ref?: string | null
  consent_authority?: string | null
  consent_scope?: Record<string, unknown>
  consented_at?: string | null
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

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function optionalInteger(value: unknown, fallback: number | null = null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.trunc(value)
}

function optionalNonNegativeInteger(value: unknown): number | null {
  const parsed = optionalInteger(value)
  return parsed === null ? null : Math.max(0, parsed)
}

function optionalTimestampText(value: unknown): string | null {
  const trimmed = optionalText(value, 80)
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  if (typeof value !== 'string') return fallback
  return allowed.includes(value as T[number]) ? (value as T[number]) : fallback
}

function parseMode(value: unknown): (typeof MODES)[number] | null {
  if (value === undefined) return 'trace'
  return typeof value === 'string' && MODES.includes(value as (typeof MODES)[number])
    ? (value as (typeof MODES)[number])
    : null
}

function requiresExplicitConsent(mode: (typeof MODES)[number]): boolean {
  return mode !== 'trace'
}

function responseRow(row: CaptureSessionRow): CaptureSessionRow {
  return row
}

export async function startPortalCaptureSession(ctx: PortalCaptureRouteCtx, actor: PortalCaptureActor): Promise<void> {
  const body = await ctx.readBody()
  const id = optionalText(body.id ?? body.capture_session_id, 80)
  if (!id || !isValidUuid(id)) {
    ctx.sendJson(400, { error: 'capture_session_id must be a uuid' })
    return
  }
  const mode = parseMode(body.mode)
  if (!mode) {
    ctx.sendJson(400, { error: 'invalid capture session mode' })
    return
  }
  const consentVersion = optionalText(body.consent_version, 80) ?? ''
  if (requiresExplicitConsent(mode) && !consentVersion) {
    ctx.sendJson(400, { error: 'consent_version is required for recorded capture sessions' })
    return
  }
  const rawRetentionDays = Number(body.retention_days ?? 30)
  const retentionDays = Number.isFinite(rawRetentionDays) ? Math.max(1, Math.min(90, rawRetentionDays)) : 30
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const routePath = optionalText(body.route_path, 500) ?? getRequestContext()?.route ?? null
  const consentScope = {
    ...jsonRecord(body.consent_scope),
    ...(actor.consentScope ?? {}),
    mode,
    route_path: routePath,
    surface: actor.surface,
    authority: actor.authority,
  }
  const metadata = {
    ...jsonRecord(body.metadata),
    ...(actor.metadata ?? {}),
    portal_surface: actor.surface,
    consent_authority: actor.authority,
  }

  const row = await withMutationTx(actor.companyId, async (client) => {
    const result = await client.query<CaptureSessionRow>(
      `insert into capture_sessions (
         id, company_id, actor_user_id, mode, status, route_path, device_kind,
         platform, viewport, app_build_sha, consent_version,
         consent_actor_kind, consent_actor_ref, consent_authority, consent_scope,
         consented_at, metadata, retention_expires_at
       ) values (
         $1, $2, null, $3, 'open', $4, $5,
         $6, $7, $8, $9,
         'portal_guest', $10, $11, $12::jsonb,
         $13::timestamptz, $14::jsonb, $15::timestamptz
       )
       on conflict (id) do update set
         last_seen_at = now(),
         route_path = coalesce(excluded.route_path, capture_sessions.route_path),
         device_kind = coalesce(excluded.device_kind, capture_sessions.device_kind),
         platform = coalesce(excluded.platform, capture_sessions.platform),
         viewport = coalesce(excluded.viewport, capture_sessions.viewport),
         app_build_sha = coalesce(excluded.app_build_sha, capture_sessions.app_build_sha),
         consent_version = coalesce(nullif(excluded.consent_version, ''), capture_sessions.consent_version),
         consent_scope = capture_sessions.consent_scope || excluded.consent_scope,
         consented_at = coalesce(excluded.consented_at, capture_sessions.consented_at),
         metadata = capture_sessions.metadata || excluded.metadata
       where capture_sessions.company_id = excluded.company_id
         and capture_sessions.consent_actor_kind = 'portal_guest'
         and capture_sessions.consent_actor_ref = excluded.consent_actor_ref
       returning *`,
      [
        id,
        actor.companyId,
        mode,
        routePath,
        optionalText(body.device_kind, 80),
        optionalText(body.platform, 80),
        optionalText(body.viewport, 80),
        optionalText(body.app_build_sha, 120),
        consentVersion,
        actor.actorRef,
        actor.authority,
        JSON.stringify(consentScope),
        consentVersion ? new Date().toISOString() : null,
        JSON.stringify(metadata),
        expiresAt,
      ],
    )
    return result.rows[0] ?? null
  })

  if (!row) {
    ctx.sendJson(409, { error: 'capture_session_id belongs to another portal actor' })
    return
  }
  ctx.sendJson(200, { capture_session: responseRow(row) })
}

export async function appendPortalCaptureEvents(
  ctx: PortalCaptureRouteCtx,
  actor: PortalCaptureActor,
  pathCaptureSessionId?: string,
): Promise<void> {
  const body = await ctx.readBody()
  const id = pathCaptureSessionId ?? optionalText(body.id ?? body.capture_session_id, 80)
  if (!id || !isValidUuid(id)) {
    ctx.sendJson(400, { error: 'capture_session_id must be a uuid' })
    return
  }
  const rawEvents = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : []
  if (rawEvents.length === 0) {
    ctx.sendJson(400, { error: 'events array is required' })
    return
  }

  const requestId = getRequestContext()?.requestId ?? null
  let inserted = 0
  let foundSession = false
  let blockedStatus: string | null = null
  await withMutationTx(actor.companyId, async (client) => {
    const exists = await client.query<{ id: string; status: string }>(
      `select id, status
         from capture_sessions
        where id = $1
          and company_id = $2
          and consent_actor_kind = 'portal_guest'
          and consent_actor_ref = $3
        limit 1`,
      [id, actor.companyId, actor.actorRef],
    )
    const session = exists.rows[0]
    if (!session) return
    foundSession = true
    if (session.status !== 'open') {
      blockedStatus = session.status
      return
    }
    for (const [index, raw] of rawEvents.entries()) {
      if (!isRecord(raw)) continue
      const eventType = optionalText(raw.event_type, 160)
      if (!eventType) continue
      const result = await client.query<{ id: string }>(
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
          actor.companyId,
          id,
          optionalInteger(raw.seq, index) ?? index,
          optionalText(raw.client_event_id, 160),
          eventType,
          optionalText(raw.event_class, 120) ?? 'portal',
          optionalText(raw.route_path, 500),
          optionalText(raw.workflow_id, 160),
          optionalText(raw.entity_type, 120),
          optionalText(raw.entity_id, 160),
          requestId,
          JSON.stringify(jsonRecord(raw.payload)),
          optionalTimestampText(raw.occurred_at),
        ],
      )
      if (result.rows[0]) inserted++
    }
    await client.query(`update capture_sessions set last_seen_at = now() where id = $1 and company_id = $2`, [
      id,
      actor.companyId,
    ])
  })

  if (!foundSession) {
    ctx.sendJson(404, { error: 'capture session not found for this portal link' })
    return
  }
  if (blockedStatus) {
    ctx.sendJson(409, { error: `capture session is ${blockedStatus}` })
    return
  }
  ctx.sendJson(202, { accepted: inserted })
}

export async function uploadPortalCaptureArtifact(
  req: http.IncomingMessage,
  ctx: PortalCaptureRouteCtx,
  actor: PortalCaptureActor,
  pathCaptureSessionId: string,
): Promise<void> {
  const storage = ctx.storage
  if (!storage) {
    ctx.sendJson(503, { error: 'capture artifact storage is not configured' })
    return
  }
  const id = optionalText(pathCaptureSessionId, 80)
  if (!id || !isValidUuid(id)) {
    ctx.sendJson(400, { error: 'capture_session_id must be a uuid' })
    return
  }

  const exists = await ctx.pool.query<{ id: string; status: string; retention_expires_at: string | null }>(
    `select id, status, retention_expires_at
       from capture_sessions
      where id = $1
        and company_id = $2
        and consent_actor_kind = 'portal_guest'
        and consent_actor_ref = $3
      limit 1`,
    [id, actor.companyId, actor.actorRef],
  )
  const session = exists.rows[0]
  if (!session) {
    ctx.sendJson(404, { error: 'capture session not found for this portal link' })
    return
  }
  if (session.status !== 'open' && session.status !== 'stopped') {
    ctx.sendJson(409, { error: `capture session is ${session.status}` })
    return
  }

  let upload
  try {
    upload = await parseCaptureArtifactMultipart(req, storage, actor.companyId, id, {
      maxFileBytes: ctx.maxArtifactBytes ?? Number(process.env.MAX_CAPTURE_ARTIFACT_BYTES ?? 50 * 1024 * 1024),
    })
  } catch (error) {
    const status = error instanceof CaptureArtifactUploadError ? error.status : 500
    ctx.sendJson(status, { error: (error as Error).message ?? 'capture artifact upload failed' })
    return
  }

  const durationMS = optionalNonNegativeInteger(Number(upload.fields.duration_ms))
  const retentionExpiresAt = optionalTimestampText(upload.fields.retention_expires_at) ?? session.retention_expires_at ?? null
  const inserted = await withMutationTx(actor.companyId, async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into capture_artifacts (
         company_id, capture_session_id, kind, storage_key, uri, content_type,
         byte_size, content_hash, duration_ms, pii_level, access_policy,
         metadata, retention_expires_at, redaction_version
       ) values (
         $1, $2, $3, $4, null, $5,
         $6, $7, $8, $9, $10,
         $11::jsonb, $12::timestamptz, $13
       )
       returning id`,
      [
        actor.companyId,
        id,
        upload.kind,
        upload.storagePath,
        upload.mimeType,
        upload.bytes,
        upload.contentHash,
        durationMS,
        enumValue(upload.fields.pii_level, ['low', 'internal', 'private', 'restricted'] as const, 'private'),
        enumValue(upload.fields.access_policy, ['support_only', 'operator_only', 'tenant_visible'] as const, 'support_only'),
        JSON.stringify({
          ...jsonRecord(parseMetadataField(upload.fields.metadata)),
          ...(actor.metadata ?? {}),
          file_name: upload.fileName,
          upload_source: 'portal_capture_artifact_upload',
          portal_surface: actor.surface,
          consent_authority: actor.authority,
        }),
        retentionExpiresAt,
        CAPTURE_REDACTION_VERSION,
      ],
    )
    await client.query(`update capture_sessions set last_seen_at = now() where id = $1 and company_id = $2`, [
      id,
      actor.companyId,
    ])
    return result.rows[0]
  })

  ctx.sendJson(201, {
    artifact: {
      id: inserted?.id ?? null,
      kind: upload.kind,
      storage_key: upload.storagePath,
      content_type: upload.mimeType,
      byte_size: upload.bytes,
      content_hash: upload.contentHash,
      redaction_version: CAPTURE_REDACTION_VERSION,
    },
  })
}

function parseMetadataField(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    return jsonRecord(JSON.parse(value) as unknown)
  } catch {
    return {}
  }
}
