import type http from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import { getRequestContext } from '@sitelayer/logger'
import { CaptureArtifactUploadError, parseCaptureArtifactMultipart } from '../capture-artifact-upload.js'
import { captureConsentAllowsArtifactKind, captureConsentAllowsEventClass } from '../capture-consent-policy.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import type { Identity } from '../auth.js'
import {
  WORK_ITEM_LANES,
  WORK_ITEM_SEVERITIES,
  appendContextHandoffEventTx,
  createContextWorkItemTx,
  getContextWorkItemWithEvents,
  type ContextHandoffEventRow,
  type ContextWorkItemDetail,
  type ContextWorkItemRow,
  type WorkItemLane,
  type WorkItemSeverity,
} from '../context-handoff.js'
import { isValidUuid, parseJsonBody } from '../http-utils.js'
import { notifyCaptureWorkItem, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { assertKeyInCompany, type BlueprintStorage } from '../storage.js'
import {
  buildSupportServerContext,
  insertSupportPacket,
  supportJsonRecord,
  type JsonRecord,
} from './support-packets.js'

export type CaptureSessionRouteCtx = {
  pool: Pool
  company: ActiveCompany
  identity: Identity
  tier: string
  buildSha: string
  storage: BlueprintStorage
  maxArtifactBytes: number
  artifactDownloadPresigned: boolean
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
  sendFileRedirect: (location: string) => void
}

const CREATE_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'member', 'bookkeeper']
const READ_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'bookkeeper']
const MODES = ['trace', 'feedback', 'desktop', 'native', 'manual_upload'] as const
const STATUSES = ['open', 'stopped', 'discarded', 'failed', 'redacted'] as const
const MAX_EVENTS = 100
const MAX_ARTIFACTS = 25
const CAPTURE_REDACTION_VERSION = 'capture-session-v1'
const TRUSTED_CAPTURE_AUTO_DISPATCH_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'bookkeeper']

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

type CaptureArtifactFileRow = {
  id: string
  kind: string
  storage_key: string | null
  uri: string | null
  content_type: string | null
  metadata: Record<string, unknown>
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

function optionalTimestampText(value: unknown): string | null {
  const trimmed = optionalText(value, 80)
  if (!trimmed) return null
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function optionalInteger(value: unknown, fallback: number | null = null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.trunc(value)
}

function optionalNonNegativeInteger(value: unknown): number | null {
  const parsed = optionalInteger(value)
  return parsed === null ? null : Math.max(0, parsed)
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  if (typeof value !== 'string') return fallback
  return allowed.includes(value as T[number]) ? (value as T[number]) : fallback
}

function parsedEnumValue<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (typeof value !== 'string') return null
  return allowed.includes(value as T[number]) ? (value as T[number]) : null
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function parseOptionalAllowed<T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  if (value === undefined || value === null) return null
  return parsedEnumValue(value, allowed)
}

function captureConsentScope(body: Record<string, unknown>, mode: (typeof MODES)[number]): Record<string, unknown> {
  return {
    ...jsonRecord(body.consent_scope),
    mode,
    route_path: optionalText(body.route_path, 500) ?? getRequestContext()?.route ?? null,
  }
}

function captureConsentArtifactError(kind: string): string {
  return `capture consent does not allow artifact kind "${kind}"`
}

function captureConsentEventClassError(eventClass: string): string {
  return `capture consent does not allow event class "${eventClass}"`
}

function captureSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/api\/capture-sessions\/([^/]+)(?:\/.*)?$/)
  const id = match?.[1]
  return id && isValidUuid(id) ? id : null
}

function requiresExplicitCaptureConsent(mode: (typeof MODES)[number]): boolean {
  return mode !== 'trace'
}

function responseRow(row: CaptureSessionRow): CaptureSessionRow {
  return row
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === '23505'
  )
}

function finalizedWorkItemResponse(
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

async function getFinalizedCaptureWorkItem(companyId: string, captureSessionId: string) {
  const result = await withCompanyClient(companyId, (c) =>
    c.query<{ id: string }>(
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

async function isCaptureSessionFinalizedTx(
  executor: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows: Array<{ id: string }> }> },
  companyId: string,
  captureSessionId: string,
): Promise<boolean> {
  const result = await executor.query(
    `select id
       from context_work_items
      where company_id = $1
        and capture_session_id = $2::uuid
        and metadata ->> 'source' = 'capture_session_finalize'
      limit 1`,
    [companyId, captureSessionId],
  )
  return Boolean(result.rows[0])
}

async function appendCaptureLifecycleEventTx(
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

async function fetchCaptureFinalizeSnapshot(companyId: string, captureSessionId: string) {
  const [session, eventCount, artifactSummary] = await Promise.all([
    withCompanyClient(companyId, (c) =>
      c.query<CaptureSessionRow>(`select * from capture_sessions where company_id = $1 and id = $2::uuid limit 1`, [
        companyId,
        captureSessionId,
      ]),
    ),
    withCompanyClient(companyId, (c) =>
      c.query<{ count: string }>(
        `select count(*)::text as count
           from capture_session_events
          where company_id = $1 and capture_session_id = $2::uuid`,
        [companyId, captureSessionId],
      ),
    ),
    withCompanyClient(companyId, (c) =>
      c.query<{ artifact_count: string; private_artifact_count: string }>(
        `select count(*)::text as artifact_count,
                count(*) filter (where pii_level in ('private', 'restricted'))::text as private_artifact_count
           from capture_artifacts
          where company_id = $1
            and capture_session_id = $2::uuid
            and deleted_at is null`,
        [companyId, captureSessionId],
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

function finalizeTitle(body: Record<string, unknown>, snapshot: CaptureFinalizeSnapshot): string {
  const explicit = optionalText(body.title, 240)
  if (explicit) return explicit
  const route = snapshot.session.route_path ? ` on ${snapshot.session.route_path}` : ''
  return `Review captured ${snapshot.session.mode} session${route}`
}

function finalizeSummary(body: Record<string, unknown>, snapshot: CaptureFinalizeSnapshot): string {
  const explicit = optionalText(body.summary ?? body.problem, 4000)
  if (explicit) return explicit
  return [
    `Capture session ${snapshot.session.id} finalized from ${snapshot.session.mode} mode.`,
    `${snapshot.event_count} event(s) and ${snapshot.artifact_count} artifact(s) were attached.`,
    snapshot.private_artifact_count > 0
      ? `${snapshot.private_artifact_count} artifact(s) require private/restricted handling.`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}

type CaptureRoutingGate = {
  passed: boolean
  reason: string
}

type CaptureRoutingDecision = {
  lane: WorkItemLane
  autoDispatch: boolean
  policyId: string
  willingnessTier: string
  promotionProfile: string
  reason: string
  gates: Record<string, CaptureRoutingGate>
}

/**
 * Decide where a finalized capture routes (human triage vs. trusted
 * auto-dispatch) AND record WHY, gate by gate. The auto-dispatch outcome is the
 * same AND of conditions the old boolean used; the value-add is the auditable
 * `gates` / willingness-tier / promotion-profile that rides into the work item
 * so triage (and an agent) can see exactly which gate held a capture back.
 * (Idea salvaged from the retired `feat/usage-capture` branch, re-applied on top
 * of the current consent-enforcing route.)
 */
function evaluateCaptureRoutingPolicy(
  ctx: CaptureSessionRouteCtx,
  snapshot: CaptureFinalizeSnapshot,
  category: string,
  requestedLane: WorkItemLane,
): CaptureRoutingDecision {
  const gates: Record<string, CaptureRoutingGate> = {
    env_allows_dispatch: {
      passed: process.env.CAPTURE_AUTH_AUTO_DISPATCH === '1',
      reason: 'CAPTURE_AUTH_AUTO_DISPATCH must be enabled',
    },
    requested_lane_default_triage: {
      passed: requestedLane === 'triage',
      reason: 'only default triage requests are trusted-promoted automatically',
    },
    trusted_actor: {
      passed: TRUSTED_CAPTURE_AUTO_DISPATCH_ROLES.includes(ctx.company.role),
      reason: 'company role must be allowed for trusted capture promotion',
    },
    authenticated_consent: {
      passed: snapshot.session.consent_authority === 'authenticated_company_user',
      reason: 'session consent authority must be authenticated company user',
    },
    eligible_mode: {
      passed: ['feedback', 'desktop', 'native'].includes(snapshot.session.mode),
      reason: 'only feedback, desktop, and native captures can auto-promote',
    },
    not_portal_capture: {
      passed: category !== 'portal_capture_session',
      reason: 'portal captures must remain triage-first',
    },
  }
  const autoDispatch = Object.values(gates).every((gate) => gate.passed)
  return {
    lane: autoDispatch ? 'both' : requestedLane,
    autoDispatch,
    policyId: autoDispatch ? 'trusted_authenticated_capture' : 'default_triage',
    willingnessTier: autoDispatch ? 'T4' : 'T2',
    promotionProfile: autoDispatch ? 'trusted_authenticated_auto_dispatch' : 'human_triage',
    reason: autoDispatch ? 'trusted_authenticated_capture_promoted' : 'capture_requires_triage_or_review',
    gates,
  }
}

function routingDecisionMetadata(decision: CaptureRoutingDecision, requestedLane: WorkItemLane): JsonRecord {
  return {
    schema: 'sitelayer.capture_routing_policy.v1',
    policy_id: decision.policyId,
    willingness_tier: decision.willingnessTier,
    promotion_profile: decision.promotionProfile,
    reason: decision.reason,
    requested_lane: requestedLane,
    resolved_lane: decision.lane,
    auto_dispatch: decision.autoDispatch,
    gates: decision.gates,
  }
}

// Permissive wire-format schemas. Every field stays optional/nullish and the
// object/scalar fields the handlers coerce defensively (via optionalText /
// jsonRecord / parsedEnumValue, which never throw) are typed `unknown` so the
// schema can never 400 a payload the handler would otherwise accept. The two
// well-defined collection fields (`events`, `artifacts`) are typed as arrays of
// loose objects — a non-array there already 400s in the handler. `.loose()`
// keeps unknown keys. The multipart upload handler is intentionally NOT routed
// through a schema.
const CaptureSessionUpsertBodySchema = z
  .object({
    id: z.unknown().nullish(),
    capture_session_id: z.unknown().nullish(),
    retention_days: z.union([z.number(), z.string()]).nullish(),
    mode: z.unknown().nullish(),
    consent_version: z.unknown().nullish(),
    route_path: z.unknown().nullish(),
    device_kind: z.unknown().nullish(),
    platform: z.unknown().nullish(),
    viewport: z.unknown().nullish(),
    app_build_sha: z.unknown().nullish(),
    consent_scope: z.unknown().nullish(),
    metadata: z.unknown().nullish(),
  })
  .loose()

const CaptureSessionPatchBodySchema = z
  .object({
    status: z.unknown().nullish(),
    route_path: z.unknown().nullish(),
    metadata: z.unknown().nullish(),
  })
  .loose()

const CaptureSessionEventsBodySchema = z
  .object({
    events: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose()

const CaptureSessionArtifactsBodySchema = z
  .object({
    artifacts: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose()

const CaptureSessionFinalizeBodySchema = z
  .object({
    lane: z.unknown().nullish(),
    severity: z.unknown().nullish(),
    title: z.unknown().nullish(),
    summary: z.unknown().nullish(),
    problem: z.unknown().nullish(),
    route_path: z.unknown().nullish(),
    route: z.unknown().nullish(),
    client_request_id: z.unknown().nullish(),
    category: z.unknown().nullish(),
  })
  .loose()

async function upsertCaptureSession(ctx: CaptureSessionRouteCtx) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const parsed = parseJsonBody(CaptureSessionUpsertBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return
  }
  const body = parsed.value
  const id = optionalText(body.id ?? body.capture_session_id, 80)
  if (!id || !isValidUuid(id)) {
    ctx.sendJson(400, { error: 'capture_session_id must be a uuid' })
    return
  }
  const rawRetentionDays = Number(body.retention_days ?? 30)
  const retentionDays = Number.isFinite(rawRetentionDays) ? Math.max(1, Math.min(90, rawRetentionDays)) : 30
  const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString()
  const mode = body.mode === undefined ? 'trace' : parsedEnumValue(body.mode, MODES)
  if (!mode) {
    ctx.sendJson(400, { error: 'invalid capture session mode' })
    return
  }
  const consentVersion = optionalText(body.consent_version, 80) ?? ''
  if (requiresExplicitCaptureConsent(mode) && !consentVersion) {
    ctx.sendJson(400, { error: 'consent_version is required for recorded capture sessions' })
    return
  }
  const consentActorKind = consentVersion ? 'user' : null
  const consentActorRef = consentVersion ? ctx.identity.userId : null
  const consentAuthority = consentVersion ? 'authenticated_company_user' : null
  const consentedAt = consentVersion ? new Date().toISOString() : null
  const consentScope = captureConsentScope(body, mode)
  const metadata = jsonRecord(body.metadata)
  const row = await withMutationTx(ctx.company.id, async (c) => {
    const result = await c.query<CaptureSessionRow>(
      `insert into capture_sessions (
         id, company_id, actor_user_id, mode, status, route_path, device_kind,
         platform, viewport, app_build_sha, consent_version,
         consent_actor_kind, consent_actor_ref, consent_authority, consent_scope,
         consented_at, metadata,
         retention_expires_at
       ) values (
         $1, $2, $3, $4, 'open', $5, $6, $7, $8, $9, $10,
         $11, $12, $13, $14::jsonb, $15::timestamptz, $16::jsonb,
         $17::timestamptz
       )
       on conflict (id) do update set
         last_seen_at = now(),
         route_path = coalesce(excluded.route_path, capture_sessions.route_path),
         device_kind = coalesce(excluded.device_kind, capture_sessions.device_kind),
         platform = coalesce(excluded.platform, capture_sessions.platform),
         viewport = coalesce(excluded.viewport, capture_sessions.viewport),
         app_build_sha = coalesce(excluded.app_build_sha, capture_sessions.app_build_sha),
         consent_version = coalesce(nullif(excluded.consent_version, ''), capture_sessions.consent_version),
         consent_actor_kind = coalesce(excluded.consent_actor_kind, capture_sessions.consent_actor_kind),
         consent_actor_ref = coalesce(excluded.consent_actor_ref, capture_sessions.consent_actor_ref),
         consent_authority = coalesce(excluded.consent_authority, capture_sessions.consent_authority),
         consent_scope = case
           when excluded.consent_scope = '{}'::jsonb then capture_sessions.consent_scope
           else capture_sessions.consent_scope || excluded.consent_scope
         end,
         consented_at = coalesce(excluded.consented_at, capture_sessions.consented_at),
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
        consentVersion,
        consentActorKind,
        consentActorRef,
        consentAuthority,
        JSON.stringify(consentScope),
        consentedAt,
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
  const parsed = parseJsonBody(CaptureSessionPatchBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return
  }
  const body = parsed.value
  const status = body.status === undefined ? null : parsedEnumValue(body.status, STATUSES)
  if (body.status !== undefined && !status) {
    ctx.sendJson(400, { error: 'invalid capture session status' })
    return
  }
  const metadata = jsonRecord(body.metadata)
  let artifactObjectKeys: string[] = []
  const row = await withMutationTx(ctx.company.id, async (c) => {
    const result = await c.query<CaptureSessionRow>(
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
    )
    const updated = result.rows[0] ?? null
    if (updated && (status === 'discarded' || status === 'redacted')) {
      const keys = await c.query<{ storage_key: string | null }>(
        `select storage_key
           from capture_artifacts
          where capture_session_id = $1
            and company_id = $2
            and deleted_at is null
            and storage_key is not null`,
        [id, ctx.company.id],
      )
      artifactObjectKeys = keys.rows
        .map((r) => r.storage_key)
        .filter((key): key is string => {
          if (!key) return false
          try {
            assertKeyInCompany(ctx.company.id, key)
            return true
          } catch {
            return false
          }
        })
      await c.query(
        `update capture_artifacts
            set deleted_at = coalesce(deleted_at, now())
          where capture_session_id = $1
            and company_id = $2
            and deleted_at is null`,
        [id, ctx.company.id],
      )
    }
    if (updated && status) {
      const startFailure = status === 'discarded' ? recordingStartFailedPayload(metadata) : null
      if (startFailure) {
        await appendCaptureLifecycleEventTx(c, ctx.company.id, id, {
          eventType: 'recording_start_failed',
          routePath: updated.route_path,
          requestId: getRequestContext()?.requestId ?? null,
          payload: startFailure,
        })
      }
      await appendCaptureLifecycleEventTx(c, ctx.company.id, id, {
        eventType: `session.${status}`,
        routePath: updated.route_path,
        requestId: getRequestContext()?.requestId ?? null,
        payload: {
          status,
          route_path: updated.route_path,
          discarded: status === 'discarded',
          redacted: status === 'redacted',
        },
      })
    }
    return updated
  })
  if (!row) {
    ctx.sendJson(404, { error: 'capture session not found' })
    return
  }
  const deletedObjects = await Promise.allSettled(artifactObjectKeys.map((key) => ctx.storage.deleteObject(key)))
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

async function appendCaptureSessionEvents(ctx: CaptureSessionRouteCtx, id: string) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const parsed = parseJsonBody(CaptureSessionEventsBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return
  }
  const body = parsed.value
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
  await withMutationTx(ctx.company.id, async (c) => {
    const exists = await c.query<{
      id: string
      status: string
      retention_expires_at: string | null
      consent_scope: Record<string, unknown> | null
    }>(
      `select id, status, retention_expires_at, consent_scope from capture_sessions where id = $1 and company_id = $2 limit 1`,
      [id, ctx.company.id],
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
      const eventClass = optionalText(raw.event_class, 120) ?? ''
      if (!captureConsentAllowsEventClass(session.consent_scope, eventClass)) {
        consentViolation = captureConsentEventClassError(eventClass)
        return
      }
    }
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
          optionalInteger(raw.seq, index) ?? index,
          optionalText(raw.client_event_id, 160),
          eventType,
          optionalText(raw.event_class, 120) ?? '',
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
    await c.query(`update capture_sessions set last_seen_at = now() where id = $1 and company_id = $2`, [
      id,
      ctx.company.id,
    ])
  })
  if (!foundSession) {
    ctx.sendJson(404, { error: 'capture session not found' })
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

async function appendCaptureArtifacts(ctx: CaptureSessionRouteCtx, id: string) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const parsed = parseJsonBody(CaptureSessionArtifactsBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return
  }
  const body = parsed.value
  const rawArtifacts = Array.isArray(body.artifacts) ? body.artifacts.slice(0, MAX_ARTIFACTS) : []
  if (rawArtifacts.length === 0) {
    ctx.sendJson(400, { error: 'artifacts array is required' })
    return
  }
  let inserted = 0
  let foundSession = false
  let blockedStatus: string | null = null
  let finalized = false
  let consentViolation: string | null = null
  await withMutationTx(ctx.company.id, async (c) => {
    const exists = await c.query<{
      id: string
      status: string
      retention_expires_at: string | null
      consent_scope: Record<string, unknown> | null
    }>(
      `select id, status, retention_expires_at, consent_scope from capture_sessions where id = $1 and company_id = $2 limit 1`,
      [id, ctx.company.id],
    )
    const session = exists.rows[0]
    if (!session) return
    foundSession = true
    if (session.status !== 'open' && session.status !== 'stopped') {
      blockedStatus = session.status
      return
    }
    finalized = await isCaptureSessionFinalizedTx(c, ctx.company.id, id)
    if (finalized) return
    for (const raw of rawArtifacts) {
      if (!isRecord(raw)) continue
      const kind = optionalText(raw.kind, 80)
      const storageKey = optionalText(raw.storage_key, 500)
      const uri = optionalText(raw.uri, 1000)
      if (!kind || (!storageKey && !uri)) continue
      if (!captureConsentAllowsArtifactKind(session.consent_scope, kind)) {
        consentViolation = captureConsentArtifactError(kind)
        return
      }
    }
    for (const raw of rawArtifacts) {
      if (!isRecord(raw)) continue
      const kind = optionalText(raw.kind, 80)
      const storageKey = optionalText(raw.storage_key, 500)
      const uri = optionalText(raw.uri, 1000)
      if (!kind || (!storageKey && !uri)) continue
      if (storageKey) {
        try {
          assertKeyInCompany(ctx.company.id, storageKey)
        } catch {
          continue
        }
      }
      const result = await c.query<{ id: string }>(
        `insert into capture_artifacts (
           company_id, capture_session_id, kind, storage_key, uri, content_type,
           byte_size, content_hash, duration_ms, pii_level, access_policy,
           metadata, retention_expires_at, redaction_version
         ) values (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10, $11,
           $12::jsonb, $13::timestamptz, $14
         )
         returning id`,
        [
          ctx.company.id,
          id,
          kind,
          storageKey,
          uri,
          optionalText(raw.content_type, 160),
          optionalNonNegativeInteger(raw.byte_size),
          optionalText(raw.content_hash, 160),
          optionalNonNegativeInteger(raw.duration_ms),
          enumValue(raw.pii_level, ['low', 'internal', 'private', 'restricted'] as const, 'internal'),
          enumValue(raw.access_policy, ['support_only', 'operator_only', 'tenant_visible'] as const, 'support_only'),
          JSON.stringify(jsonRecord(raw.metadata)),
          optionalTimestampText(raw.retention_expires_at) ?? session.retention_expires_at ?? null,
          CAPTURE_REDACTION_VERSION,
        ],
      )
      if (result.rows[0]) inserted++
    }
    await c.query(`update capture_sessions set last_seen_at = now() where id = $1 and company_id = $2`, [
      id,
      ctx.company.id,
    ])
  })
  if (!foundSession) {
    ctx.sendJson(404, { error: 'capture session not found' })
    return
  }
  if (blockedStatus) {
    ctx.sendJson(409, { error: `capture session is ${blockedStatus}` })
    return
  }
  if (finalized) {
    ctx.sendJson(409, { error: 'capture session has already been finalized' })
    return
  }
  if (consentViolation) {
    ctx.sendJson(403, { error: consentViolation })
    return
  }
  ctx.sendJson(202, { accepted: inserted })
}

function parseMetadataField(value: string | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    return jsonRecord(parsed)
  } catch {
    return {}
  }
}

async function uploadCaptureArtifact(req: http.IncomingMessage, ctx: CaptureSessionRouteCtx, id: string) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const exists = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{
      id: string
      status: string
      retention_expires_at: string | null
      consent_scope: Record<string, unknown> | null
    }>(
      `select id, status, retention_expires_at, consent_scope from capture_sessions where id = $1 and company_id = $2 limit 1`,
      [id, ctx.company.id],
    ),
  )
  const session = exists.rows[0]
  if (!session) {
    ctx.sendJson(404, { error: 'capture session not found' })
    return
  }
  if (session.status !== 'open' && session.status !== 'stopped') {
    ctx.sendJson(409, { error: `capture session is ${session.status}` })
    return
  }
  const finalized = await withCompanyClient(ctx.company.id, (c) => isCaptureSessionFinalizedTx(c, ctx.company.id, id))
  if (finalized) {
    ctx.sendJson(409, { error: 'capture session has already been finalized' })
    return
  }

  let upload
  try {
    upload = await parseCaptureArtifactMultipart(req, ctx.storage, ctx.company.id, id, {
      maxFileBytes: ctx.maxArtifactBytes,
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
  const result = await withMutationTx(ctx.company.id, async (c) => {
    const inserted = await c.query<{ id: string }>(
      `insert into capture_artifacts (
         company_id, capture_session_id, kind, storage_key, uri, content_type,
         byte_size, content_hash, duration_ms, pii_level, access_policy,
         metadata, retention_expires_at, redaction_version
       ) values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12::jsonb, $13::timestamptz, $14
       )
       returning id`,
      [
        ctx.company.id,
        id,
        upload.kind,
        upload.storagePath,
        null,
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
          ...parseMetadataField(upload.fields.metadata),
          file_name: upload.fileName,
          upload_source: 'capture_artifact_upload',
        }),
        retentionExpiresAt,
        CAPTURE_REDACTION_VERSION,
      ],
    )
    await c.query(`update capture_sessions set last_seen_at = now() where id = $1 and company_id = $2`, [
      id,
      ctx.company.id,
    ])
    return inserted.rows[0]
  })
  ctx.sendJson(201, {
    artifact: {
      id: result?.id ?? null,
      kind: upload.kind,
      storage_key: upload.storagePath,
      content_type: upload.mimeType,
      byte_size: upload.bytes,
      content_hash: upload.contentHash,
      redaction_version: CAPTURE_REDACTION_VERSION,
    },
  })
}

async function downloadCaptureArtifact(ctx: CaptureSessionRouteCtx, id: string, artifactId: string) {
  if (!ctx.requireRole(READ_ROLES)) return
  const result = await withCompanyClient(ctx.company.id, (c) =>
    c.query<CaptureArtifactFileRow>(
      `select id, kind, storage_key, uri, content_type, metadata
         from capture_artifacts
        where company_id = $1
          and capture_session_id = $2::uuid
          and id = $3::uuid
          and deleted_at is null
        limit 1`,
      [ctx.company.id, id, artifactId],
    ),
  )
  const row = result.rows[0]
  if (!row) {
    ctx.sendJson(404, { error: 'capture artifact not found' })
    return
  }
  if (!row.storage_key) {
    ctx.sendJson(409, { error: 'capture artifact has no stored file' })
    return
  }
  try {
    assertKeyInCompany(ctx.company.id, row.storage_key)
  } catch (error) {
    ctx.sendJson(400, { error: error instanceof Error ? error.message : 'invalid storage key' })
    return
  }

  if (ctx.artifactDownloadPresigned) {
    const presigned = await ctx.storage.getDownloadUrl(row.storage_key)
    if (presigned) {
      ctx.sendFileRedirect(presigned)
      return
    }
  }
  const content = await ctx.storage.get(row.storage_key)
  const metadataName = typeof row.metadata?.file_name === 'string' ? row.metadata.file_name.trim() : ''
  const fileName = metadataName || row.storage_key.split('/').pop() || `${row.kind}.bin`
  ctx.sendFileContent(row.content_type || 'application/octet-stream', fileName, content)
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

async function finalizeCaptureSession(ctx: CaptureSessionRouteCtx, id: string) {
  if (!ctx.requireRole(CREATE_ROLES)) return
  const parsed = parseJsonBody(CaptureSessionFinalizeBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return
  }
  const body = parsed.value
  const existing = await getFinalizedCaptureWorkItem(ctx.company.id, id)
  if (existing) {
    ctx.sendJson(200, finalizedWorkItemResponse(existing, true))
    return
  }

  const snapshot = await fetchCaptureFinalizeSnapshot(ctx.company.id, id)
  if (!snapshot) {
    ctx.sendJson(404, { error: 'capture session not found' })
    return
  }
  if (snapshot.session.status === 'discarded' || snapshot.session.status === 'redacted') {
    ctx.sendJson(409, { error: `capture session is ${snapshot.session.status}` })
    return
  }

  const requestedLane = (parseOptionalAllowed(body.lane, WORK_ITEM_LANES) ?? 'triage') as WorkItemLane
  if (body.lane !== undefined && body.lane !== null && !parseOptionalAllowed(body.lane, WORK_ITEM_LANES)) {
    ctx.sendJson(400, { error: `lane must be one of ${WORK_ITEM_LANES.join(', ')}` })
    return
  }
  const severity = parseOptionalAllowed(body.severity, WORK_ITEM_SEVERITIES) as WorkItemSeverity | null
  if (body.severity !== undefined && body.severity !== null && !severity) {
    ctx.sendJson(400, { error: `severity must be one of ${WORK_ITEM_SEVERITIES.join(', ')}` })
    return
  }

  const requestId = getRequestContext()?.requestId ?? null
  const route = optionalText(body.route_path ?? body.route, 500) ?? snapshot.session.route_path
  const title = finalizeTitle(body, snapshot)
  const summary = finalizeSummary(body, snapshot)
  const clientRequestId = optionalText(body.client_request_id, 160) ?? `capture_session_finalize:${id}`
  const category = optionalText(body.category, 120) ?? 'capture_session'
  const routingDecision = evaluateCaptureRoutingPolicy(ctx, snapshot, category, requestedLane)
  const autoDispatch = routingDecision.autoDispatch
  const lane: WorkItemLane = routingDecision.lane
  const routingMetadata = routingDecisionMetadata(routingDecision, requestedLane)
  const rawClient: JsonRecord = {
    capture_session_id: id,
    path: route ? { route } : null,
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
      requested_lane: requestedLane,
      lane,
      severity,
      capture_auto_dispatch: autoDispatch,
      capture_policy: routingMetadata,
    },
  }
  const client = supportJsonRecord(rawClient)
  const serverContext = await buildSupportServerContext({
    pool: ctx.pool,
    company: ctx.company,
    identity: ctx.identity,
    tier: ctx.tier,
    buildSha: ctx.buildSha,
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
    result = await withMutationTx(ctx.company.id, async (c) => {
      const packet = await insertSupportPacket(c, {
        companyId: ctx.company.id,
        actorUserId: ctx.identity.userId,
        requestId,
        route,
        captureSessionId: id,
        buildSha: ctx.buildSha,
        problem: summary,
        client,
        serverContext: serverContext as JsonRecord,
        expiresAt,
        redactionVersion: 'support-packet-v1',
      })
      const item = await createContextWorkItemTx(c, {
        companyId: ctx.company.id,
        supportPacketId: packet.id,
        // Capture-dock finalize → an app-issue (problem with the software).
        domain: 'app_issue',
        title,
        summary,
        status: 'new',
        lane,
        severity,
        route,
        captureSessionId: id,
        createdByUserId: ctx.identity.userId,
        metadata: {
          category,
          source: 'capture_session_finalize',
          capture_session_id: id,
          client_request_id: clientRequestId,
          support_packet_expires_at: packet.expires_at ?? expiresAt,
          event_count: snapshot.event_count,
          artifact_count: snapshot.artifact_count,
          private_artifact_count: snapshot.private_artifact_count,
          capture_auto_dispatch: autoDispatch,
          capture_routing_policy: routingDecision.policyId,
          capture_policy: routingMetadata,
          requested_lane: requestedLane,
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
          capture_session_id: id,
          support_packet_id: packet.id,
          event_count: snapshot.event_count,
          artifact_count: snapshot.artifact_count,
          capture_auto_dispatch: autoDispatch,
        },
        metadata: {
          category,
          source: 'capture_session_finalize',
          capture_session_id: id,
          capture_auto_dispatch: autoDispatch,
          capture_routing_policy: routingDecision.policyId,
          capture_policy: routingMetadata,
          evidence_refs: [{ type: 'support_debug_packet', id: packet.id }],
        },
        idempotencyKey: `capture_session:finalize:${id}:work_item_created`,
        captureSessionId: id,
        buildSha: ctx.buildSha,
      })
      await c.query(
        `update capture_sessions
            set status = case when status = 'open' then 'stopped' else status end,
                stopped_at = case when status = 'open' then now() else stopped_at end,
                last_seen_at = now(),
                metadata = metadata || $3::jsonb
          where id = $1 and company_id = $2`,
        [
          id,
          ctx.company.id,
          JSON.stringify({
            finalized_at: new Date().toISOString(),
            finalized_support_packet_id: packet.id,
            finalized_work_item_id: item.id,
          }),
        ],
      )
      await appendCaptureLifecycleEventTx(c, ctx.company.id, id, {
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
          capture_auto_dispatch: autoDispatch,
        },
      })
      return { packet, item, event }
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      const replay = await getFinalizedCaptureWorkItem(ctx.company.id, id)
      if (replay) {
        ctx.sendJson(200, finalizedWorkItemResponse(replay, true))
        return
      }
    }
    throw error
  }

  // Ping operators (Bell feed) so a submission isn't poll-only. Runs AFTER the
  // tx commits on a separate connection (notifyCaptureWorkItem -> requirePool),
  // so a notify failure can never roll back the just-created work item. Exclude
  // the submitter so an operator filing their own feedback doesn't self-notify.
  await notifyCaptureWorkItem({
    companyId: ctx.company.id,
    excludeUserId: ctx.identity.userId,
    subject: `New feedback: ${result.item.title}`,
    text: `${result.item.summary} (${route ?? ''})`,
    payload: {
      work_item_id: result.item.id,
      support_packet_id: result.packet.id,
      capture_session_id: id,
      route,
      lane: result.item.lane,
      severity: result.item.severity,
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
  const artifactFileMatch = url.pathname.match(/^\/api\/capture-sessions\/([^/]+)\/artifacts\/([^/]+)\/file$/)
  if (req.method === 'GET' && artifactFileMatch) {
    const artifactId = artifactFileMatch[2]!
    if (!isValidUuid(artifactId)) {
      ctx.sendJson(400, { error: 'capture artifact id must be a uuid' })
      return true
    }
    await downloadCaptureArtifact(ctx, id, artifactId)
    return true
  }
  if (req.method === 'POST' && url.pathname === `/api/capture-sessions/${id}/artifacts`) {
    await appendCaptureArtifacts(ctx, id)
    return true
  }
  if (req.method === 'POST' && url.pathname === `/api/capture-sessions/${id}/artifacts/upload`) {
    await uploadCaptureArtifact(req, ctx, id)
    return true
  }
  if (req.method === 'POST' && url.pathname === `/api/capture-sessions/${id}/finalize`) {
    await finalizeCaptureSession(ctx, id)
    return true
  }

  return false
}
