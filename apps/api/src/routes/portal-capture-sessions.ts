import type http from 'node:http'
import { getRequestContext } from '@sitelayer/logger'
import type { Pool } from 'pg'
import { CaptureArtifactUploadError, parseCaptureArtifactMultipart } from '../capture-artifact-upload.js'
import { captureConsentAllowsArtifactKind, captureConsentAllowsEventClass } from '../capture-consent-policy.js'
import type { ActiveCompany } from '../auth-types.js'
import type { Identity } from '../auth.js'
import {
  WORK_ITEM_SEVERITIES,
  appendContextHandoffEventTx,
  createContextWorkItemTx,
  getContextWorkItemWithEvents,
  type ContextHandoffEventRow,
  type ContextWorkItemDetail,
  type ContextWorkItemRow,
  type WorkItemSeverity,
} from '../context-handoff.js'
import { isValidUuid } from '../http-utils.js'
import { notifyCaptureWorkItem, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { assertKeyInCompany, type BlueprintStorage } from '../storage.js'
import {
  buildSupportServerContext,
  insertSupportPacket,
  supportJsonRecord,
  type JsonRecord,
} from './support-packets.js'

const MODES = ['trace', 'feedback', 'desktop', 'native', 'manual_upload'] as const
const MAX_EVENTS = 100
const CAPTURE_REDACTION_VERSION = 'capture-session-v1'

// The signed-share-token authorities that constitute the PLATFORM `app_issue.capture`
// boundary on the guest path. A portal guest has no Clerk identity, so the
// company-side `requireCapability` resolver (which denies app_issue.* for any
// non-Clerk identity) can NEVER authorize them — the capture-authority IS the
// cryptographically verified share token the calling route (estimate-shares-portal /
// feedback-invites / portal-rentals) already validated before invoking finalize.
// This set pins which token authorities may finalize an app_issue capture so the
// boundary is explicit here, not just implied by the upstream token check.
const PORTAL_APP_ISSUE_CAPTURE_AUTHORITIES: ReadonlySet<PortalCaptureActor['authority']> = new Set([
  'signed_estimate_share_token',
  'signed_rental_share_token',
  'signed_feedback_invite_token',
])

export type PortalCaptureRouteCtx = {
  pool: Pool
  storage?: BlueprintStorage | undefined
  maxArtifactBytes?: number | undefined
  tier?: string | undefined
  buildSha?: string | undefined
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

export type PortalCaptureActor = {
  companyId: string
  actorRef: string
  authority: 'signed_estimate_share_token' | 'signed_rental_share_token' | 'signed_feedback_invite_token'
  surface: 'estimate_portal' | 'rental_portal' | 'feedback_invite'
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

type CaptureFinalizeSnapshot = {
  session: CaptureSessionRow
  event_count: number
  artifact_count: number
  private_artifact_count: number
}

const PORTAL_ACTOR_WORK_ITEM_METADATA_KEYS = [
  'estimate_share_link_id',
  'project_id',
  'rental_share_link_id',
  'customer_id',
  'feedback_invite_id',
  'reviewer_ref',
  'target_route',
  'allowed_capture_modes',
  'created_from',
  'company_slug',
  'ops_diagnostic_session_id',
  'ops_diagnostic_control_level',
  'ops_diagnostic_state',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function portalActorWorkItemMetadata(actor: PortalCaptureActor): JsonRecord {
  const actorMetadata = supportJsonRecord(actor.metadata ?? {})
  const routed: JsonRecord = {}
  for (const key of PORTAL_ACTOR_WORK_ITEM_METADATA_KEYS) {
    if (actorMetadata[key] !== undefined && actorMetadata[key] !== null) routed[key] = actorMetadata[key]
  }
  if (actorMetadata.source !== undefined && actorMetadata.source !== null) {
    routed.portal_actor_source = actorMetadata.source
  }
  return routed
}

function portalActorWorkItemBinding(actor: PortalCaptureActor): { entityType?: string; entityId?: string } {
  const actorMetadata = jsonRecord(actor.metadata)
  const opsDiagnosticSessionId = optionalText(actorMetadata.ops_diagnostic_session_id, 160)
  return opsDiagnosticSessionId
    ? { entityType: 'ops_diagnostic_session', entityId: opsDiagnosticSessionId }
    : {}
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

function parsedEnumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (typeof value !== 'string') return null
  return allowed.includes(value as T[number]) ? (value as T[number]) : null
}

function parseOptionalAllowed<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (value === undefined || value === null) return null
  return parsedEnumValue(value, allowed)
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

function captureModesFromScope(scope: Record<string, unknown> | undefined): Set<string> | null {
  if (!scope || !Array.isArray(scope.allowed_capture_modes)) return null
  return new Set(
    scope.allowed_capture_modes.filter((mode): mode is string => typeof mode === 'string' && Boolean(mode.trim())),
  )
}

function portalConsentAllowsMode(
  scope: Record<string, unknown> | undefined,
  mode: (typeof MODES)[number],
): boolean {
  const allowedModes = captureModesFromScope(scope)
  if (!allowedModes) return true
  if (mode === 'trace') return allowedModes.has('trace')
  if (mode === 'desktop' || mode === 'native') return allowedModes.has('screen')
  return ['text', 'audio', 'screen', 'state'].some((allowed) => allowedModes.has(allowed))
}

function responseRow(row: CaptureSessionRow): CaptureSessionRow {
  return row
}

function captureConsentArtifactError(kind: string): string {
  return `capture consent does not allow artifact kind "${kind}"`
}

function captureConsentEventClassError(eventClass: string): string {
  return `capture consent does not allow event class "${eventClass}"`
}

function portalActorUserId(actor: PortalCaptureActor): string {
  return `portal_guest:${actor.authority}:${actor.actorRef}`
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505'
  )
}

function finalizedPortalWorkItemResponse(
  detail: ContextWorkItemDetail,
  idempotentReplay: boolean,
): {
  work_item: ContextWorkItemDetail['work_item']
  support_packet: { id: string; expires_at: string | null }
  event: ContextHandoffEventRow | null
  idempotent_replay?: true
} {
  return {
    work_item: detail.work_item,
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
    ...(idempotentReplay ? { idempotent_replay: true as const } : {}),
  }
}

async function getFinalizedPortalCaptureWorkItem(companyId: string, captureSessionId: string) {
  const result = await withCompanyClient(companyId, (client) =>
    client.query<{ id: string }>(
      `select id
         from context_work_items
        where company_id = $1
          and capture_session_id = $2::uuid
          and metadata ->> 'source' = 'capture_session_finalize'
        order by created_at asc
        limit 1`,
      [companyId, captureSessionId],
    ),
  )
  const workItemId = result.rows[0]?.id
  return workItemId ? getContextWorkItemWithEvents(companyId, workItemId) : null
}

async function isPortalCaptureSessionFinalized(companyId: string, captureSessionId: string): Promise<boolean> {
  const result = await withCompanyClient(companyId, (client) =>
    client.query<{ id: string }>(
      `select id
         from context_work_items
        where company_id = $1
          and capture_session_id = $2::uuid
          and metadata ->> 'source' = 'capture_session_finalize'
        limit 1`,
      [companyId, captureSessionId],
    ),
  )
  return Boolean(result.rows[0])
}

async function appendPortalCaptureLifecycleEventTx(
  executor: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<unknown> },
  companyId: string,
  captureSessionId: string,
  args: {
    eventType: string
    routePath?: string | null
    requestId?: string | null
    payload?: Record<string, unknown>
  },
): Promise<void> {
  await executor.query(
    `insert into capture_session_events (
       company_id, capture_session_id, seq, client_event_id, event_type,
       event_class, route_path, workflow_id, entity_type, entity_id,
       request_id, payload, occurred_at
     ) values (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11, $12::jsonb, coalesce($13::timestamptz, now())
     )
     on conflict (company_id, capture_session_id, client_event_id) where client_event_id is not null do nothing`,
    [
      companyId,
      captureSessionId,
      0,
      `capture_session:${args.eventType}:${captureSessionId}`,
      args.eventType,
      'lifecycle',
      args.routePath ?? null,
      'capture_session',
      'capture_session',
      captureSessionId,
      args.requestId ?? null,
      JSON.stringify(args.payload ?? {}),
      null,
    ],
  )
}

function recordingStartFailedPayload(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const captureFailure = jsonRecord(metadata.capture_failure)
  if (captureFailure.event_type !== 'recording_start_failed') return null
  return {
    event_type: 'recording_start_failed',
    failed_at: optionalTimestampText(captureFailure.failed_at) ?? new Date().toISOString(),
    error_name: optionalText(captureFailure.error_name, 120),
    message: optionalText(captureFailure.message, 500) ?? 'recording start failed',
    discard_status: 'succeeded',
  }
}

async function fetchPortalCaptureFinalizeSnapshot(actor: PortalCaptureActor, captureSessionId: string) {
  const [session, eventCount, artifactSummary] = await Promise.all([
    withCompanyClient(actor.companyId, (client) =>
      client.query<CaptureSessionRow>(
        `select *
           from capture_sessions
          where company_id = $1
            and id = $2::uuid
            and consent_actor_kind = 'portal_guest'
            and consent_actor_ref = $3
          limit 1`,
        [actor.companyId, captureSessionId, actor.actorRef],
      ),
    ),
    withCompanyClient(actor.companyId, (client) =>
      client.query<{ count: string }>(
        `select count(*)::text as count
           from capture_session_events
          where company_id = $1 and capture_session_id = $2::uuid`,
        [actor.companyId, captureSessionId],
      ),
    ),
    withCompanyClient(actor.companyId, (client) =>
      client.query<{ artifact_count: string; private_artifact_count: string }>(
        `select count(*)::text as artifact_count,
                count(*) filter (where pii_level in ('private', 'restricted'))::text as private_artifact_count
           from capture_artifacts
          where company_id = $1
            and capture_session_id = $2::uuid
            and deleted_at is null`,
        [actor.companyId, captureSessionId],
      ),
    ),
  ])
  const row = session.rows[0]
  if (!row) return null
  return {
    session: row,
    event_count: Number(eventCount.rows[0]?.count ?? 0),
    artifact_count: Number(artifactSummary.rows[0]?.artifact_count ?? 0),
    private_artifact_count: Number(artifactSummary.rows[0]?.private_artifact_count ?? 0),
  } satisfies CaptureFinalizeSnapshot
}

async function loadPortalCompany(pool: Pool, companyId: string): Promise<ActiveCompany> {
  const result = await pool.query<{ id: string; slug: string; name: string; created_at: string }>(
    `select id::text as id, slug, name, created_at::text as created_at
       from companies
      where id = $1
      limit 1`,
    [companyId],
  )
  const row = result.rows[0]
  return {
    id: row?.id ?? companyId,
    slug: row?.slug ?? 'portal',
    name: row?.name ?? 'Portal company',
    created_at: row?.created_at ?? '',
    role: 'member',
  }
}

function finalizeTitle(body: Record<string, unknown>, snapshot: CaptureFinalizeSnapshot): string {
  const explicit = optionalText(body.title, 240)
  if (explicit) return explicit
  const route = snapshot.session.route_path ? ` on ${snapshot.session.route_path}` : ''
  return `Review portal ${snapshot.session.mode} capture${route}`
}

function finalizeSummary(body: Record<string, unknown>, snapshot: CaptureFinalizeSnapshot): string {
  const explicit = optionalText(body.summary ?? body.problem, 4000)
  if (explicit) return explicit
  return [
    `Portal capture session ${snapshot.session.id} finalized from ${snapshot.session.mode} mode.`,
    `${snapshot.event_count} event(s) and ${snapshot.artifact_count} artifact(s) were attached.`,
    snapshot.private_artifact_count > 0
      ? `${snapshot.private_artifact_count} artifact(s) require private/restricted handling.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
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
  if (!portalConsentAllowsMode(actor.consentScope, mode)) {
    ctx.sendJson(403, { error: `feedback invite does not allow ${mode} capture sessions` })
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
  let consentViolation: string | null = null
  await withMutationTx(actor.companyId, async (client) => {
    const exists = await client.query<{ id: string; status: string; consent_scope: Record<string, unknown> | null }>(
      `select id, status, consent_scope
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
    for (const raw of rawEvents) {
      if (!isRecord(raw)) continue
      const eventType = optionalText(raw.event_type, 160)
      if (!eventType) continue
      const eventClass = optionalText(raw.event_class, 120) ?? 'portal'
      if (!captureConsentAllowsEventClass(session.consent_scope, eventClass)) {
        consentViolation = captureConsentEventClassError(eventClass)
        return
      }
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
  if (consentViolation) {
    ctx.sendJson(403, { error: consentViolation })
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

  const exists = await ctx.pool.query<{
    id: string
    status: string
    retention_expires_at: string | null
    consent_scope: Record<string, unknown> | null
  }>(
    `select id, status, retention_expires_at, consent_scope
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
  if (await isPortalCaptureSessionFinalized(actor.companyId, id)) {
    ctx.sendJson(409, { error: 'capture session has already been finalized' })
    return
  }

  let upload
  try {
    upload = await parseCaptureArtifactMultipart(req, storage, actor.companyId, id, {
      maxFileBytes: ctx.maxArtifactBytes ?? Number(process.env.MAX_CAPTURE_ARTIFACT_BYTES ?? 50 * 1024 * 1024),
      allowKind: (kind) => captureConsentAllowsArtifactKind(session.consent_scope, kind),
      disallowedKindMessage: captureConsentArtifactError,
    })
  } catch (error) {
    const status = error instanceof CaptureArtifactUploadError ? error.status : 500
    ctx.sendJson(status, { error: (error as Error).message ?? 'capture artifact upload failed' })
    return
  }

  const durationMS = optionalNonNegativeInteger(Number(upload.fields.duration_ms))
  const retentionExpiresAt =
    optionalTimestampText(upload.fields.retention_expires_at) ?? session.retention_expires_at ?? null
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
        enumValue(
          upload.fields.access_policy,
          ['support_only', 'operator_only', 'tenant_visible'] as const,
          'support_only',
        ),
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

export async function finalizePortalCaptureSession(
  ctx: PortalCaptureRouteCtx,
  actor: PortalCaptureActor,
  pathCaptureSessionId: string,
): Promise<void> {
  // PLATFORM app_issue.capture boundary on the guest path: the verified signed
  // share token IS the capture authority (a portal guest has no Clerk identity,
  // so the company-side requireCapability resolver could never grant app_issue.*).
  // The calling route already validated the token; this pins the allowed
  // authorities so the boundary is explicit rather than only upstream-implied.
  if (!PORTAL_APP_ISSUE_CAPTURE_AUTHORITIES.has(actor.authority)) {
    ctx.sendJson(403, { error: 'forbidden: capture authority not permitted', capability: 'app_issue.capture' })
    return
  }
  const body = await ctx.readBody()
  const id = optionalText(pathCaptureSessionId, 80)
  if (!id || !isValidUuid(id)) {
    ctx.sendJson(400, { error: 'capture_session_id must be a uuid' })
    return
  }

  const existing = await getFinalizedPortalCaptureWorkItem(actor.companyId, id)
  if (existing) {
    ctx.sendJson(200, finalizedPortalWorkItemResponse(existing, true))
    return
  }

  const snapshot = await fetchPortalCaptureFinalizeSnapshot(actor, id)
  if (!snapshot) {
    ctx.sendJson(404, { error: 'capture session not found for this portal link' })
    return
  }
  if (snapshot.session.status === 'discarded' || snapshot.session.status === 'redacted') {
    ctx.sendJson(409, { error: `capture session is ${snapshot.session.status}` })
    return
  }

  if (body.lane !== undefined && body.lane !== null && body.lane !== 'triage') {
    ctx.sendJson(400, { error: 'public portal capture finalization always uses triage lane' })
    return
  }
  const severity = parseOptionalAllowed(body.severity, WORK_ITEM_SEVERITIES) as WorkItemSeverity | null
  if (body.severity !== undefined && body.severity !== null && !severity) {
    ctx.sendJson(400, { error: `severity must be one of ${WORK_ITEM_SEVERITIES.join(', ')}` })
    return
  }

  const actorUserId = portalActorUserId(actor)
  const company = await loadPortalCompany(ctx.pool, actor.companyId)
  const identity: Identity = { userId: actorUserId, source: 'default' }
  const requestId = getRequestContext()?.requestId ?? null
  const route = optionalText(body.route_path ?? body.route, 500) ?? snapshot.session.route_path
  const title = finalizeTitle(body, snapshot)
  const summary = finalizeSummary(body, snapshot)
  const clientRequestId = optionalText(body.client_request_id, 160) ?? `portal_capture_session_finalize:${id}`
  const category = optionalText(body.category, 120) ?? 'portal_capture_session'
  const buildSha = snapshot.session.app_build_sha ?? ctx.buildSha ?? null
  const actorWorkItemMetadata = portalActorWorkItemMetadata(actor)
  const actorWorkItemBinding = portalActorWorkItemBinding(actor)
  const rawClient: JsonRecord = {
    capture_session_id: id,
    path: route ? { route } : null,
    portal: {
      surface: actor.surface,
      authority: actor.authority,
      actor_ref: actor.actorRef,
      ...supportJsonRecord(actor.metadata ?? {}),
    },
    capture_session: {
      id,
      mode: snapshot.session.mode,
      status: snapshot.session.status,
      route_path: snapshot.session.route_path,
      event_count: snapshot.event_count,
      artifact_count: snapshot.artifact_count,
      private_artifact_count: snapshot.private_artifact_count,
      redaction_version: snapshot.session.redaction_version,
      consent_version: snapshot.session.consent_version,
      consent_authority: snapshot.session.consent_authority ?? null,
    },
    finalization: {
      category,
      title,
      summary,
      lane: 'triage',
      severity,
    },
  }
  const client = supportJsonRecord(rawClient)
  const serverContext = await buildSupportServerContext({
    pool: ctx.pool,
    company,
    identity,
    tier: ctx.tier ?? 'portal',
    buildSha: buildSha ?? '',
    client: rawClient,
  })
  const retentionDays = Math.max(1, Math.min(90, Number(process.env.SUPPORT_PACKET_RETENTION_DAYS ?? 30)))
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString()

  let result: {
    packet: { id: string; expires_at: string | null }
    item: ContextWorkItemRow
    event: ContextHandoffEventRow
  }
  try {
    result = await withMutationTx(actor.companyId, async (clientTx) => {
      const packet = await insertSupportPacket(clientTx, {
        companyId: actor.companyId,
        actorUserId,
        requestId,
        route,
        captureSessionId: id,
        buildSha,
        problem: summary,
        client,
        serverContext: serverContext as JsonRecord,
        expiresAt,
        redactionVersion: 'support-packet-v1',
      })
      const item = await createContextWorkItemTx(clientTx, {
        companyId: actor.companyId,
        supportPacketId: packet.id,
        // Portal capture-dock finalize → an app-issue (problem with the software).
        domain: 'app_issue',
        title,
        summary,
        status: 'new',
        lane: 'triage',
        severity,
        route,
        ...actorWorkItemBinding,
        captureSessionId: id,
        createdByUserId: actorUserId,
        metadata: {
          ...actorWorkItemMetadata,
          category,
          source: 'capture_session_finalize',
          capture_session_id: id,
          client_request_id: clientRequestId,
          portal_surface: actor.surface,
          portal_authority: actor.authority,
          portal_actor_ref: actor.actorRef,
          support_packet_expires_at: packet.expires_at ?? expiresAt,
          event_count: snapshot.event_count,
          artifact_count: snapshot.artifact_count,
          private_artifact_count: snapshot.private_artifact_count,
        },
      })
      const event = await appendContextHandoffEventTx(clientTx, {
        companyId: actor.companyId,
        workItemId: item.id,
        eventType: 'work_item.created',
        actorKind: 'external',
        actorRef: actorUserId,
        payload: {
          title: item.title,
          summary: item.summary,
          status: item.status,
          lane: item.lane,
          severity: item.severity,
          route: item.route,
          capture_session_id: id,
          support_packet_id: packet.id,
          entity_type: item.entity_type,
          entity_id: item.entity_id,
          event_count: snapshot.event_count,
          artifact_count: snapshot.artifact_count,
          portal_surface: actor.surface,
          portal_actor_metadata: actorWorkItemMetadata,
        },
        metadata: {
          ...actorWorkItemMetadata,
          category,
          source: 'capture_session_finalize',
          capture_session_id: id,
          evidence_refs: [{ type: 'support_debug_packet', id: packet.id }],
          portal_surface: actor.surface,
          portal_authority: actor.authority,
        },
        idempotencyKey: `capture_session:finalize:${id}:work_item_created`,
        captureSessionId: id,
        buildSha,
      })
      await clientTx.query(
        `update capture_sessions
            set status = case when status = 'open' then 'stopped' else status end,
                stopped_at = case when status = 'open' then now() else stopped_at end,
                last_seen_at = now(),
                metadata = metadata || $3::jsonb
          where id = $1
            and company_id = $2
            and consent_actor_kind = 'portal_guest'
            and consent_actor_ref = $4`,
        [
          id,
          actor.companyId,
          JSON.stringify({
            finalized_at: new Date().toISOString(),
            finalized_by: 'portal_guest',
            finalized_support_packet_id: packet.id,
            finalized_work_item_id: item.id,
          }),
          actor.actorRef,
        ],
      )
      await appendPortalCaptureLifecycleEventTx(clientTx, actor.companyId, id, {
        eventType: 'session.finalized',
        routePath: route,
        requestId,
        payload: {
          status: 'finalized',
          work_item_id: item.id,
          support_packet_id: packet.id,
          lane: item.lane,
          severity: item.severity,
          event_count: snapshot.event_count,
          artifact_count: snapshot.artifact_count,
          portal_surface: actor.surface,
          portal_authority: actor.authority,
        },
      })
      return { packet, item, event }
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replay = await getFinalizedPortalCaptureWorkItem(actor.companyId, id)
      if (replay) {
        ctx.sendJson(200, finalizedPortalWorkItemResponse(replay, true))
        return
      }
    }
    throw error
  }

  // Ping operators (Bell feed) so a Steve submission isn't poll-only. Runs AFTER
  // the tx commits on a separate connection (notifyCaptureWorkItem ->
  // requirePool), so a notify failure can never roll back the work item. No
  // submitter exclusion: the portal guest is never a company admin.
  await notifyCaptureWorkItem({
    companyId: actor.companyId,
    subject: `New feedback: ${result.item.title}`,
    text: `${result.item.summary} (${route ?? ''})`,
    payload: {
      work_item_id: result.item.id,
      support_packet_id: result.packet.id,
      capture_session_id: id,
      route,
      lane: result.item.lane,
      severity: result.item.severity,
      portal_surface: actor.surface,
      ...actorWorkItemMetadata,
    },
  })

  ctx.sendJson(201, {
    work_item: result.item,
    support_packet: {
      id: result.packet.id,
      expires_at: result.packet.expires_at ?? expiresAt,
    },
    event: result.event,
  })
}

export async function discardPortalCaptureSession(
  ctx: PortalCaptureRouteCtx,
  actor: PortalCaptureActor,
  pathCaptureSessionId: string,
): Promise<void> {
  const id = optionalText(pathCaptureSessionId, 80)
  if (!id || !isValidUuid(id)) {
    ctx.sendJson(400, { error: 'capture_session_id must be a uuid' })
    return
  }

  const finalized = await getFinalizedPortalCaptureWorkItem(actor.companyId, id)
  if (finalized) {
    ctx.sendJson(409, { error: 'capture session already finalized' })
    return
  }

  const body = await ctx.readBody().catch((): Record<string, unknown> => ({}))
  const requestMetadata = jsonRecord(body.metadata)
  let foundSession = false
  let blockedStatus: string | null = null
  let artifactObjectKeys: string[] = []
  const row = await withMutationTx(actor.companyId, async (client) => {
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
    if (!session) return null
    foundSession = true
    if (session.status === 'redacted') {
      blockedStatus = session.status
      return null
    }

    const updated = await client.query<CaptureSessionRow>(
      `update capture_sessions
          set status = 'discarded',
              discarded_at = coalesce(discarded_at, now()),
              last_seen_at = now(),
              metadata = metadata || $4::jsonb
        where id = $1
          and company_id = $2
          and consent_actor_kind = 'portal_guest'
          and consent_actor_ref = $3
        returning *`,
      [
        id,
        actor.companyId,
        actor.actorRef,
        JSON.stringify({
          ...requestMetadata,
          discarded_at: new Date().toISOString(),
          discarded_by: 'portal_guest',
          portal_surface: actor.surface,
        }),
      ],
    )
    const captureSession = updated.rows[0] ?? null
    if (!captureSession) return null

    const keys = await client.query<{ storage_key: string | null }>(
      `select storage_key
         from capture_artifacts
        where capture_session_id = $1
          and company_id = $2
          and deleted_at is null
          and storage_key is not null`,
      [id, actor.companyId],
    )
    artifactObjectKeys = keys.rows
      .map((artifact) => artifact.storage_key)
      .filter((key): key is string => {
        if (!key) return false
        try {
          assertKeyInCompany(actor.companyId, key)
          return true
        } catch {
          return false
        }
      })
    await client.query(
      `update capture_artifacts
          set deleted_at = coalesce(deleted_at, now())
        where capture_session_id = $1
          and company_id = $2
          and deleted_at is null`,
      [id, actor.companyId],
    )
    const startFailure = recordingStartFailedPayload(requestMetadata)
    if (startFailure) {
      await appendPortalCaptureLifecycleEventTx(client, actor.companyId, id, {
        eventType: 'recording_start_failed',
        routePath: captureSession.route_path,
        requestId: getRequestContext()?.requestId ?? null,
        payload: {
          ...startFailure,
          portal_surface: actor.surface,
          portal_authority: actor.authority,
        },
      })
    }
    await appendPortalCaptureLifecycleEventTx(client, actor.companyId, id, {
      eventType: 'session.discarded',
      routePath: captureSession.route_path,
      requestId: getRequestContext()?.requestId ?? null,
      payload: {
        status: 'discarded',
        portal_surface: actor.surface,
        portal_authority: actor.authority,
      },
    })
    return captureSession
  })

  if (!foundSession) {
    ctx.sendJson(404, { error: 'capture session not found for this portal link' })
    return
  }
  if (blockedStatus) {
    ctx.sendJson(409, { error: `capture session is ${blockedStatus}` })
    return
  }
  if (!row) {
    ctx.sendJson(404, { error: 'capture session not found for this portal link' })
    return
  }

  const deletedObjects = ctx.storage
    ? await Promise.allSettled(artifactObjectKeys.map((key) => ctx.storage!.deleteObject(key)))
    : []
  ctx.sendJson(200, {
    capture_session: responseRow(row),
    ...(artifactObjectKeys.length
      ? {
          deleted_artifact_objects: deletedObjects.filter((result) => result.status === 'fulfilled').length,
          artifact_object_delete_errors: deletedObjects.filter((result) => result.status === 'rejected').length,
        }
      : {}),
  })
}

export function __portalActorWorkItemBindingForTests(actor: PortalCaptureActor): {
  entityType?: string
  entityId?: string
} {
  return portalActorWorkItemBinding(actor)
}

function parseMetadataField(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    return jsonRecord(JSON.parse(value) as unknown)
  } catch {
    return {}
  }
}
