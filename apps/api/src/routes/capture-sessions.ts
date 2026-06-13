import type http from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import { getRequestContext } from '@sitelayer/logger'
import {
  CaptureArtifactUploadError,
  captureArtifactClientUploadIdFromRequest,
  captureArtifactObjectKeyPrefix,
  normalizeCaptureArtifactClientUploadId,
  parseCaptureArtifactMultipart,
} from '../capture-artifact-upload.js'
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
import type { Capability } from '@sitelayer/domain'
import { isValidUuid, parseJsonBody } from '../http-utils.js'
import {
  notifyCaptureWorkItem,
  recordMutationOutbox,
  withCompanyClient,
  withMutationTx,
  type LedgerExecutor,
} from '../mutation-tx.js'
import { buildCaptureSessionAnchors } from '../anchor-resolve.js'
import { buildIncidentTimeline } from '../incident-timeline.js'
import { detectInjectionHeuristic } from '../untrusted-content.js'
import { assertKeyInCompany, type BlueprintStorage } from '../storage.js'
import {
  buildSupportServerContext,
  insertSupportPacket,
  sanitizeSupportJson,
  supportJsonRecord,
  type JsonRecord,
} from './support-packets.js'
import { buildConcernSnapshot } from '@sitelayer/projectkit-bridge'
import {
  CAPTURE_ANALYZER_AUDIENCE,
  agentFeedBaseUrl,
  insertAgentFeedConcernTx,
  mapCaptureArtifactsToConcernRefs,
  type CaptureArtifactSummaryRow,
} from './agent-feed.js'
import { getBuildSha } from '../lib/build-sha.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

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
  /**
   * PLATFORM capability gate (server.ts closure). The capture dock files
   * app-issues, so finalize requires `app_issue.capture` and the artifact
   * download requires `app_issue.view` — both resolve on the platform boundary
   * (superadmin ∪ platform_admin_grants over the RAW identity), unreachable via
   * a company role / dev act-as / header fallback. On denial it has already
   * sent the 403 and returns false; the handler must `return`.
   */
  requireCapability: (capability: Capability) => Promise<boolean>
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
  sendFileRedirect: (location: string) => void
}

const CREATE_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'member', 'bookkeeper']
const READ_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'bookkeeper']
// app-issue capture lives on the platform boundary, not the company role.
const APP_ISSUE_CAPTURE: Capability = 'app_issue.capture'
const APP_ISSUE_VIEW: Capability = 'app_issue.view'
const MODES = ['trace', 'feedback', 'desktop', 'native', 'manual_upload'] as const
const STATUSES = ['open', 'stopped', 'discarded', 'failed', 'redacted'] as const
const MAX_EVENTS = 100
const MAX_ARTIFACTS = 25
const CAPTURE_REDACTION_VERSION = 'capture-session-v1'
const TRUSTED_CAPTURE_AUTO_DISPATCH_ROLES: readonly CompanyRole[] = ['admin', 'foreman', 'office', 'bookkeeper']
// The incident timeline woven at finalize covers this session's window padded
// by a small buffer either side, capped to keep server_context bounded.
const CAPTURE_TIMELINE_BUFFER_MS = 60_000
const CAPTURE_TIMELINE_LIMIT = 200

/**
 * Clamp a capture-session window edge to an ISO string, shifted by `offsetMs`
 * (negative widens earlier, positive widens later). Falls back to now() if the
 * edge is missing/unparseable so the timeline query always has valid bounds.
 */
function captureWindowBound(edge: string | null | undefined, offsetMs: number): string {
  const base = edge ? Date.parse(edge) : Number.NaN
  const millis = Number.isNaN(base) ? Date.now() : base
  return new Date(millis + offsetMs).toISOString()
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

type CaptureArtifactFileRow = {
  id: string
  kind: string
  storage_key: string | null
  uri: string | null
  content_type: string | null
  metadata: Record<string, unknown>
}

type CaptureArtifactUploadRow = {
  id: string
  kind: string
  storage_key: string | null
  content_type: string | null
  byte_size: string | number | null
  content_hash: string | null
  redaction_version: string
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

/**
 * Pull a bounded string[] off a built server_context field (trace_ids /
 * request_ids). The debug-bundle enrichment enqueues the ALREADY-PINNED ids so
 * the worker never re-derives them — this just defensively reads + bounds them.
 */
function stringArrayFromServerContext(serverContext: Record<string, unknown>, key: string, limit = 25): string[] {
  const raw = serverContext[key]
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    if (!out.includes(trimmed)) out.push(trimmed)
    if (out.length >= limit) break
  }
  return out
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
  /** The injection-heuristic pattern ids that tripped the confirm-gate (empty
   * when the untrusted content scanned clean). Auditable on the work item. */
  injectionPatterns: string[]
}

/**
 * Decide where a finalized capture routes (human triage vs. trusted
 * auto-dispatch) AND record WHY, gate by gate. The auto-dispatch outcome is the
 * AND of all gates; the value-add is the auditable `gates` / willingness-tier /
 * promotion-profile that rides into the work item so triage (and an agent) can
 * see exactly which gate held a capture back.
 * (Idea salvaged from the retired `feat/usage-capture` branch, re-applied on top
 * of the current consent-enforcing route.)
 *
 * CONFIRM-GATE (prompt-injection defense, default-safe): the finalized bundle
 * carries user-supplied / DOM-captured content that feeds the LLM agent prompt.
 * That content is sanitized for secrets/PII but NOT for prompt injection. So
 * before the (env-gated, currently inert) auto-dispatch path can promote a
 * capture to an agent lane, the untrusted text (`untrustedFragments` — the
 * reporter summary/title + captured note text) is scanned for imperative /
 * instruction-like patterns. If anything trips the heuristic, the
 * `content_clean` gate fails and the capture HOLDS for human triage instead of
 * auto-dispatching. Auto-dispatch only proceeds when explicitly allowed (the
 * env flag + the trusted-actor/consent/mode gates) AND the content is clean.
 * This never changes the current behavior (auto-dispatch is off by default).
 */
function evaluateCaptureRoutingPolicy(
  ctx: CaptureSessionRouteCtx,
  snapshot: CaptureFinalizeSnapshot,
  category: string,
  requestedLane: WorkItemLane,
  untrustedFragments: Array<string | null | undefined>,
): CaptureRoutingDecision {
  const injection = detectInjectionHeuristic(untrustedFragments)
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
    // Defense-in-depth confirm-gate: the untrusted captured/user content must not
    // trip the prompt-injection heuristic. Default-safe — anything suspicious
    // holds the capture for human triage instead of auto-dispatching an agent.
    content_clean: {
      passed: !injection.suspicious,
      reason: 'untrusted captured content must not trip the prompt-injection heuristic',
    },
  }
  const autoDispatch = Object.values(gates).every((gate) => gate.passed)
  return {
    lane: autoDispatch ? 'both' : requestedLane,
    autoDispatch,
    policyId: autoDispatch ? 'trusted_authenticated_capture' : 'default_triage',
    willingnessTier: autoDispatch ? 'T4' : 'T2',
    promotionProfile: autoDispatch ? 'trusted_authenticated_auto_dispatch' : 'human_triage',
    reason: autoDispatch
      ? 'trusted_authenticated_capture_promoted'
      : injection.suspicious
        ? 'capture_held_for_triage_injection_suspected'
        : 'capture_requires_triage_or_review',
    gates,
    injectionPatterns: injection.patterns,
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
    // Confirm-gate evidence: present so triage can see whether (and why) the
    // prompt-injection heuristic held a capture back from auto-dispatch.
    untrusted_content_scanned: true,
    injection_suspected: decision.injectionPatterns.length > 0,
    injection_patterns: decision.injectionPatterns,
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
    // STEP5 — optional repro-bracket marks. When present, finalize emits ONE
    // work_item PER mark / mark-pair (a 1:N slice) instead of the single
    // session-level item. Each entry is a loose object the handler coerces
    // defensively (from_event_ref / to_event_ref / label).
    marks: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose()

const MAX_FINALIZE_MARKS = 25

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

function captureArtifactUploadResponse(
  row: CaptureArtifactUploadRow,
  fallback: { storagePath: string; byteSize: number; contentHash: string },
) {
  return {
    id: row.id,
    kind: row.kind,
    storage_key: row.storage_key ?? fallback.storagePath,
    content_type: row.content_type ?? 'application/octet-stream',
    byte_size: Number(row.byte_size ?? fallback.byteSize),
    content_hash: row.content_hash ?? fallback.contentHash,
    redaction_version: row.redaction_version,
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

  const requestClientUploadId = captureArtifactClientUploadIdFromRequest(req)
  if (requestClientUploadId) {
    const replay = await withCompanyClient(ctx.company.id, (c) =>
      c.query<CaptureArtifactUploadRow>(
        `select id, kind, storage_key, content_type, byte_size::text as byte_size, content_hash, redaction_version
           from capture_artifacts
          where company_id = $1
            and capture_session_id = $2
            and client_upload_id = $3
            and deleted_at is null
          limit 1`,
        [ctx.company.id, id, requestClientUploadId],
      ),
    )
    const row = replay.rows[0]
    if (row) {
      ctx.sendJson(200, {
        artifact: captureArtifactUploadResponse(row, {
          storagePath: row.storage_key ?? '',
          byteSize: Number(row.byte_size ?? 0),
          contentHash: row.content_hash ?? '',
        }),
        replayed: true,
      })
      return
    }
  }
  const objectKeyPrefix = captureArtifactObjectKeyPrefix(requestClientUploadId)
  let upload
  try {
    upload = await parseCaptureArtifactMultipart(req, ctx.storage, ctx.company.id, id, {
      maxFileBytes: ctx.maxArtifactBytes,
      ...(objectKeyPrefix ? { objectKeyPrefix } : {}),
      allowKind: (kind) => captureConsentAllowsArtifactKind(session.consent_scope, kind),
      disallowedKindMessage: captureConsentArtifactError,
    })
  } catch (error) {
    const status = error instanceof CaptureArtifactUploadError ? error.status : 500
    ctx.sendJson(status, { error: (error as Error).message ?? 'capture artifact upload failed' })
    return
  }

  const fieldClientUploadId = normalizeCaptureArtifactClientUploadId(upload.fields.client_upload_id)
  if (requestClientUploadId && fieldClientUploadId && requestClientUploadId !== fieldClientUploadId) {
    await ctx.storage.deleteObject(upload.storagePath).catch(() => undefined)
    ctx.sendJson(400, { error: 'client_upload_id does not match idempotency header' })
    return
  }
  const clientUploadId = fieldClientUploadId ?? requestClientUploadId
  const durationMS = optionalNonNegativeInteger(Number(upload.fields.duration_ms))
  const retentionExpiresAt =
    optionalTimestampText(upload.fields.retention_expires_at) ?? session.retention_expires_at ?? null
  const result = await withMutationTx(ctx.company.id, async (c) => {
    const inserted = await c.query<CaptureArtifactUploadRow>(
      `insert into capture_artifacts (
         company_id, capture_session_id, kind, storage_key, uri, content_type,
         byte_size, content_hash, duration_ms, pii_level, access_policy,
         metadata, retention_expires_at, redaction_version, client_upload_id
       ) values (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12::jsonb, $13::timestamptz, $14, $15
       )
       on conflict (company_id, capture_session_id, client_upload_id)
         where client_upload_id is not null and deleted_at is null
       do nothing
       returning id, kind, storage_key, content_type, byte_size::text as byte_size, content_hash, redaction_version`,
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
          ...(clientUploadId ? { client_upload_id: clientUploadId } : {}),
        }),
        retentionExpiresAt,
        CAPTURE_REDACTION_VERSION,
        clientUploadId,
      ],
    )
    let row = inserted.rows[0] ?? null
    let replayed = false
    if (!row && clientUploadId) {
      const replay = await c.query<CaptureArtifactUploadRow>(
        `select id, kind, storage_key, content_type, byte_size::text as byte_size, content_hash, redaction_version
           from capture_artifacts
          where company_id = $1
            and capture_session_id = $2
            and client_upload_id = $3
            and deleted_at is null
          limit 1`,
        [ctx.company.id, id, clientUploadId],
      )
      row = replay.rows[0] ?? null
      replayed = row !== null
    }
    await c.query(`update capture_sessions set last_seen_at = now() where id = $1 and company_id = $2`, [
      id,
      ctx.company.id,
    ])
    return { row, replayed }
  })
  if (!result.row) {
    await ctx.storage.deleteObject(upload.storagePath).catch(() => undefined)
    ctx.sendJson(500, { error: 'capture artifact insert did not return a row' })
    return
  }
  if (result.replayed && result.row.storage_key !== upload.storagePath) {
    await ctx.storage.deleteObject(upload.storagePath).catch(() => undefined)
  }
  ctx.sendJson(result.replayed ? 200 : 201, {
    artifact: captureArtifactUploadResponse(result.row, {
      storagePath: upload.storagePath,
      byteSize: upload.bytes,
      contentHash: upload.contentHash,
    }),
    ...(result.replayed ? { replayed: true } : {}),
  })
}

async function downloadCaptureArtifact(ctx: CaptureSessionRouteCtx, id: string, artifactId: string) {
  // The captured artifact is internal app-issue evidence — gate on the PLATFORM
  // `app_issue.view`, not the company READ_ROLES.
  if (!(await ctx.requireCapability(APP_ISSUE_VIEW))) return
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

/**
 * A normalized repro-bracket slice parsed from one finalize `marks[]` entry.
 * `fromEventRef` is the bracket start anchor; `toEventRef` is the bracket end
 * (null for a single-mark slice / still). `sliceKey` is the per-slice
 * idempotency key (stamped into metadata.slice_key) the relaxed dedupe matches.
 */
type ReproBracketSlice = {
  index: number
  fromEventRef: string | null
  toEventRef: string | null
  label: string | null
  sliceKey: string
}

/**
 * Parse the optional `marks[]` into normalized per-slice repro brackets. Each
 * mark carries a `from_event_ref` (the bracket start anchor) and an optional
 * `to_event_ref` (the bracket end → a from->to slice; absent → a single-mark
 * slice). A defensive `slice_key` is derived per entry so the relaxed finalize
 * dedupe (per-slice, not the old session-wide 1:1) is deterministic across a
 * client replay. Marks without any usable anchor are dropped.
 */
function parseReproBracketSlices(rawMarks: unknown, captureSessionId: string): ReproBracketSlice[] {
  if (!Array.isArray(rawMarks)) return []
  const slices: ReproBracketSlice[] = []
  for (const [index, raw] of rawMarks.slice(0, MAX_FINALIZE_MARKS).entries()) {
    if (!isRecord(raw)) continue
    const fromEventRef = optionalText(raw.from_event_ref ?? raw.event_ref ?? raw.from, 400)
    const toEventRef = optionalText(raw.to_event_ref ?? raw.to, 400)
    // A slice must pin at least one anchor end, else it can't carry a range.
    if (!fromEventRef && !toEventRef) continue
    const label = optionalText(raw.label, 240)
    const explicitKey = optionalText(raw.slice_key ?? raw.client_request_id, 200)
    const sliceKey = explicitKey ?? `${captureSessionId}:${fromEventRef ?? 'none'}:${toEventRef ?? 'none'}`
    slices.push({ index, fromEventRef, toEventRef, label, sliceKey })
  }
  return slices
}

/** Look up a per-slice finalize work item (relaxed dedupe — matches on the
 * stamped metadata.slice_key, not the session-wide source). */
async function getFinalizedCaptureWorkItemForSlice(companyId: string, captureSessionId: string, sliceKey: string) {
  const result = await withCompanyClient(companyId, (c) =>
    c.query<{ id: string }>(
      `select id
         from context_work_items
        where company_id = $1
          and capture_session_id = $2::uuid
          and metadata ->> 'source' = 'capture_session_finalize'
          and metadata ->> 'slice_key' = $3
        order by created_at asc
        limit 1`,
      [companyId, captureSessionId, sliceKey],
    ),
  )
  const workItemId = result.rows[0]?.id
  return workItemId ? getContextWorkItemWithEvents(companyId, workItemId) : null
}

/**
 * STEP — agent-feed analyzer enqueue (env-gated, default OFF). When
 * AGENT_FEED_CAPTURE_ANALYZER=1, finalize also inserts ONE addressed
 * @operator/projectkit Concern (audience 'capture-analyzer') into
 * agent_feed_concerns on the SAME tx as the work item, so the local
 * pull-executor (bin/pull-executor.mjs) picks it up on its next poll and
 * returns the analysis as a terminal Callback (routes/agent-feed.ts writes it
 * back into the work item's metadata.capture_analysis). Idempotent on
 * concern_ref `capan:<capture_session_id>` (ON CONFLICT DO NOTHING) so a
 * finalize replay / multi-slice finalize never enqueues twice. The Concern's
 * inputs.artifacts map the session's stored capture_artifacts to the analyzer
 * vocabulary (rrweb/audio/video/screenshot) with refs pointing at the
 * bearer-authed GET /api/agent-feed/artifacts/:id stream.
 */
async function enqueueCaptureAnalyzerConcernTx(
  c: LedgerExecutor,
  args: {
    companyId: string
    captureSessionId: string
    workItem: ContextWorkItemRow
    summary: string
    route: string | null
    pageTitle: string | null
  },
): Promise<void> {
  const artifactRows = await c.query<CaptureArtifactSummaryRow>(
    `select id, kind, content_type, byte_size, duration_ms
       from capture_artifacts
      where company_id = $1
        and capture_session_id = $2::uuid
        and deleted_at is null
        and storage_key is not null
      order by created_at asc
      limit 25`,
    [args.companyId, args.captureSessionId],
  )
  const artifacts = mapCaptureArtifactsToConcernRefs(artifactRows.rows, agentFeedBaseUrl())
  // Built through the validated @sitelayer/projectkit-bridge builder (the
  // single place the published contract is enforced) — never a hand-rolled
  // snapshot literal (ratchet: apps/api/src/projectkit-concern.test.ts).
  const concern = buildConcernSnapshot({
    workItemId: args.workItem.id,
    concernRef: `capan:${args.captureSessionId}`,
    title: `Analyze capture for ${args.workItem.title}`,
    summary: args.summary,
    audience: CAPTURE_ANALYZER_AUDIENCE,
    assignee: CAPTURE_ANALYZER_AUDIENCE,
    route: args.route,
    captureSessionId: args.captureSessionId,
    sourceEventRef: `capture_session:${args.captureSessionId}`,
    inputs: {
      capture_session_id: args.captureSessionId,
      work_item_id: args.workItem.id,
      url: args.route,
      page_title: args.pageTitle,
      summary: args.summary,
      artifacts,
    },
  })
  await insertAgentFeedConcernTx(c, {
    companyId: args.companyId,
    audience: CAPTURE_ANALYZER_AUDIENCE,
    concern,
    workItemId: args.workItem.id,
    captureSessionId: args.captureSessionId,
  })
}

async function finalizeCaptureSession(ctx: CaptureSessionRouteCtx, id: string) {
  // Finalizing the capture dock mints an app_issue work item — gate on the
  // PLATFORM capability, not the company role.
  if (!(await ctx.requireCapability(APP_ISSUE_CAPTURE))) return
  const parsed = parseJsonBody(CaptureSessionFinalizeBodySchema, await ctx.readBody())
  if (!parsed.ok) {
    ctx.sendJson(400, { error: parsed.error })
    return
  }
  const body = parsed.value
  const slices = parseReproBracketSlices(body.marks, id)
  // STEP5 — when no repro-bracket marks are supplied this stays the original
  // session-level 1:1 finalize (dedupe on the session-wide source). With marks
  // it becomes a 1:N slice finalize: the dedupe relaxes to PER SLICE so each
  // bracket mints its own work_item carrying its from->to anchor event_refs.
  if (slices.length === 0) {
    const existing = await getFinalizedCaptureWorkItem(ctx.company.id, id)
    if (existing) {
      ctx.sendJson(200, finalizedWorkItemResponse(existing, true))
      return
    }
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
  // The user-supplied / captured text the LLM agent prompt will read. Scanned by
  // the confirm-gate for prompt-injection before any (env-gated) auto-dispatch.
  // The repro-bracket slice labels are user-typed too, so include them.
  const untrustedFinalizeText: Array<string | null | undefined> = [
    summary,
    title,
    optionalText(body.summary, 4000),
    optionalText(body.problem, 4000),
    optionalText(body.title, 240),
    ...slices.map((slice) => slice.label),
  ]
  const routingDecision = evaluateCaptureRoutingPolicy(ctx, snapshot, category, requestedLane, untrustedFinalizeText)
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

  // Per-slice replay: with marks, any slice already finalized short-circuits to
  // a replay response for that slice (and we drop it from the create list). If
  // ALL slices already exist, this is a pure replay.
  const sliceReplays: ContextWorkItemDetail[] = []
  const pendingSlices: ReproBracketSlice[] = []
  if (slices.length > 0) {
    for (const slice of slices) {
      const existingSlice = await getFinalizedCaptureWorkItemForSlice(ctx.company.id, id, slice.sliceKey)
      if (existingSlice) sliceReplays.push(existingSlice)
      else pendingSlices.push(slice)
    }
    if (pendingSlices.length === 0) {
      ctx.sendJson(200, {
        work_items: sliceReplays.map((detail) => finalizedWorkItemResponse(detail, true).work_item),
        slices: sliceReplays.length,
        idempotent_replay: true,
      })
      return
    }
  }

  type FinalizedItem = {
    packet: { id: string; expires_at: string | null }
    item: ContextWorkItemRow
    event: ContextHandoffEventRow
    slice: ReproBracketSlice | null
  }

  let results: FinalizedItem[]
  try {
    results = await withMutationTx(ctx.company.id, async (c) => {
      // Weave the deterministic statechart anchors in-process on the SAME tx
      // client (already bound to app.company_id). Each recent workflow.transition
      // mark on this capture session is resolved + replayed so the persisted
      // server_context.anchors pins the exact broken/most-recent transition and
      // its first replay divergence — what the agent_prompt reads to ground the
      // LLM. Fully defensive: a resolve failure is skipped, never thrown, so
      // finalize can't break on a bad anchor.
      const anchors = await buildCaptureSessionAnchors(c, ctx.company.id, id).catch(() => [])
      // Weave the chronological incident timeline ("events leading up to it") on
      // the SAME tx client, bounded by this capture session's window (started_at
      // -> last_seen_at/stopped_at) with a small buffer either side so the row(s)
      // that triggered the capture aren't clipped by an off-by-a-second boundary.
      // In-process only, no network. Fully defensive: a failing read is skipped,
      // never thrown, and the sanitized rows are capped before persisting so a
      // noisy session can't bloat server_context.
      const timeline = await buildIncidentTimeline(c, {
        companyId: ctx.company.id,
        since: captureWindowBound(snapshot.session.started_at, -CAPTURE_TIMELINE_BUFFER_MS),
        until: captureWindowBound(
          snapshot.session.stopped_at ?? snapshot.session.last_seen_at,
          CAPTURE_TIMELINE_BUFFER_MS,
        ),
        limit: CAPTURE_TIMELINE_LIMIT,
      }).catch(() => null)
      const traceIds = stringArrayFromServerContext(serverContext as JsonRecord, 'trace_ids')
      const requestIds = stringArrayFromServerContext(serverContext as JsonRecord, 'request_ids')

      // Build ONE finalize item (packet + work_item + created event + the
      // debug-bundle outbox enqueue) for a single slice (or the whole-session
      // 1:1 case when `slice` is null). Shared by both branches so the anchors /
      // timeline / server_context weave + the STEP3 enqueue are identical.
      const createOneFinalizeItem = async (slice: ReproBracketSlice | null): Promise<FinalizedItem> => {
        const reproBracket = slice
          ? {
              slice_index: slice.index,
              from_event_ref: slice.fromEventRef,
              to_event_ref: slice.toEventRef,
              label: slice.label,
            }
          : null
        const serverContextWithAnchors: JsonRecord = {
          ...(serverContext as JsonRecord),
          anchors,
          ...(timeline ? { timeline: sanitizeSupportJson(timeline) as JsonRecord } : {}),
          ...(reproBracket ? { repro_bracket: reproBracket } : {}),
        }
        const sliceTitle = slice?.label ? `${title} — ${slice.label}` : title
        const sliceSuffix = slice ? `:slice:${slice.sliceKey}` : ''
        const packet = await insertSupportPacket(c, {
          companyId: ctx.company.id,
          actorUserId: ctx.identity.userId,
          requestId,
          route,
          captureSessionId: id,
          buildSha: ctx.buildSha,
          problem: summary,
          client,
          serverContext: serverContextWithAnchors,
          expiresAt,
          redactionVersion: 'support-packet-v1',
        })
        const item = await createContextWorkItemTx(c, {
          companyId: ctx.company.id,
          supportPacketId: packet.id,
          // Capture-dock finalize → an app-issue (problem with the software).
          domain: 'app_issue',
          title: sliceTitle,
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
            client_request_id: slice ? slice.sliceKey : clientRequestId,
            support_packet_expires_at: packet.expires_at ?? expiresAt,
            event_count: snapshot.event_count,
            artifact_count: snapshot.artifact_count,
            private_artifact_count: snapshot.private_artifact_count,
            capture_auto_dispatch: autoDispatch,
            capture_routing_policy: routingDecision.policyId,
            capture_policy: routingMetadata,
            requested_lane: requestedLane,
            // STEP5 — the per-slice repro bracket + its dedupe key. Present only
            // on a 1:N marks finalize; absent on the legacy 1:1 path.
            ...(slice
              ? {
                  slice_key: slice.sliceKey,
                  repro_bracket: reproBracket,
                }
              : {}),
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
            ...(reproBracket ? { repro_bracket: reproBracket } : {}),
          },
          metadata: {
            category,
            source: 'capture_session_finalize',
            capture_session_id: id,
            capture_auto_dispatch: autoDispatch,
            capture_routing_policy: routingDecision.policyId,
            capture_policy: routingMetadata,
            evidence_refs: [{ type: 'support_debug_packet', id: packet.id }],
            ...(slice ? { slice_key: slice.sliceKey } : {}),
          },
          idempotencyKey: `capture_session:finalize:${id}${sliceSuffix}:work_item_created`,
          captureSessionId: id,
          buildSha: ctx.buildSha,
        })
        // STEP3 — enqueue the async debug-bundle enrichment on the SAME tx so the
        // outbox row commits atomically with the work item. The worker
        // (runners/debug-bundle.ts → processAssembleDebugBundle) runs the env-gated
        // Sentry + Axiom pulls around the trace_ids / request_ids the support
        // packet ALREADY PINNED (read off server_context, never re-derived) and
        // upserts a debug_bundle capture_artifact. Idempotent on the work_item id
        // so a finalize replay reuses the same row. entity_type='app_issue' (the
        // work-item domain) — that's the value the pusher's claim SQL filters on
        // and the DEDICATED_HANDLER_MUTATION_TYPES exclusion guards.
        await recordMutationOutbox(
          ctx.company.id,
          'app_issue',
          item.id,
          'assemble_debug_bundle',
          {
            support_packet_id: packet.id,
            capture_session_id: id,
            trace_ids: traceIds,
            request_ids: requestIds,
            // STEP5 — the slice's pinned from->to anchors ride into the bundle so
            // the enrichment + escalation re-run around the EXACT bracket range.
            ...(slice ? { event_ref: slice.fromEventRef ?? slice.toEventRef } : {}),
          },
          `debug_bundle:assemble:${item.id}`,
          'server',
          ctx.identity.userId,
          c,
        )
        return { packet, item, event, slice }
      }

      const created: FinalizedItem[] =
        pendingSlices.length > 0
          ? await pendingSlices.reduce<Promise<FinalizedItem[]>>(async (accP, slice) => {
              const acc = await accP
              acc.push(await createOneFinalizeItem(slice))
              return acc
            }, Promise.resolve([]))
          : [await createOneFinalizeItem(null)]

      // The session stop + the finalize lifecycle mark happen ONCE per finalize
      // call regardless of slice count. Point them at the first created item.
      const primary = created[0]!

      // Agent-feed analyzer enqueue (env-gated; idempotent on capan:<id>) —
      // same tx so the addressed Concern commits atomically with the work item.
      if (process.env.AGENT_FEED_CAPTURE_ANALYZER === '1') {
        await enqueueCaptureAnalyzerConcernTx(c, {
          companyId: ctx.company.id,
          captureSessionId: id,
          workItem: primary.item,
          summary,
          route,
          pageTitle: optionalText(snapshot.session.metadata?.page_title, 240),
        })
      }
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
            finalized_support_packet_id: primary.packet.id,
            finalized_work_item_id: primary.item.id,
            ...(created.length > 1 ? { finalized_slice_count: created.length } : {}),
          }),
        ],
      )
      await appendCaptureLifecycleEventTx(c, ctx.company.id, id, {
        eventType: 'session.finalized',
        routePath: route,
        requestId,
        payload: {
          status: 'finalized',
          work_item_id: primary.item.id,
          support_packet_id: primary.packet.id,
          lane: primary.item.lane,
          severity: primary.item.severity,
          event_count: snapshot.event_count,
          artifact_count: snapshot.artifact_count,
          capture_auto_dispatch: autoDispatch,
          ...(created.length > 1 ? { slice_count: created.length } : {}),
        },
      })
      return created
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A concurrent finalize raced us. Re-read whichever dedupe key applies.
      if (slices.length > 0) {
        const replays: ContextWorkItemDetail[] = []
        for (const slice of slices) {
          const detail = await getFinalizedCaptureWorkItemForSlice(ctx.company.id, id, slice.sliceKey)
          if (detail) replays.push(detail)
        }
        if (replays.length > 0) {
          ctx.sendJson(200, {
            work_items: replays.map((detail) => finalizedWorkItemResponse(detail, true).work_item),
            slices: replays.length,
            idempotent_replay: true,
          })
          return
        }
      } else {
        const replay = await getFinalizedCaptureWorkItem(ctx.company.id, id)
        if (replay) {
          ctx.sendJson(200, finalizedWorkItemResponse(replay, true))
          return
        }
      }
    }
    throw error
  }

  // Ping operators (Bell feed) so a submission isn't poll-only. Runs AFTER the
  // tx commits on a separate connection (notifyCaptureWorkItem -> requirePool),
  // so a notify failure can never roll back the just-created work item. Exclude
  // the submitter so an operator filing their own feedback doesn't self-notify.
  // One ping per created item so a multi-slice finalize surfaces each bracket.
  for (const created of results) {
    await notifyCaptureWorkItem({
      companyId: ctx.company.id,
      excludeUserId: ctx.identity.userId,
      subject: `New feedback: ${created.item.title}`,
      text: `${created.item.summary} (${route ?? ''})`,
      payload: {
        work_item_id: created.item.id,
        support_packet_id: created.packet.id,
        capture_session_id: id,
        route,
        lane: created.item.lane,
        severity: created.item.severity,
      },
    })
  }

  // 1:1 (no marks) → the original single-item response shape (unchanged so the
  // existing frontend + tests are untouched). 1:N (marks) → the work_items[]
  // shape carrying every newly created slice plus any replayed ones.
  if (slices.length === 0) {
    const only = results[0]!
    ctx.sendJson(201, {
      work_item: only.item,
      support_packet: {
        id: only.packet.id,
        expires_at: only.packet.expires_at ?? expiresAt,
      },
      event: only.event,
    })
    return
  }
  ctx.sendJson(201, {
    work_items: [
      ...results.map((created) => ({
        work_item: created.item,
        support_packet: {
          id: created.packet.id,
          expires_at: created.packet.expires_at ?? expiresAt,
        },
        event: created.event,
        slice_key: created.slice?.sliceKey ?? null,
        from_event_ref: created.slice?.fromEventRef ?? null,
        to_event_ref: created.slice?.toEventRef ?? null,
      })),
      ...sliceReplays.map((detail) => {
        const response = finalizedWorkItemResponse(detail, true)
        return {
          work_item: response.work_item,
          support_packet: response.support_packet,
          event: response.event,
          slice_key:
            typeof response.work_item.metadata?.slice_key === 'string' ? response.work_item.metadata.slice_key : null,
          idempotent_replay: true as const,
        }
      }),
    ],
    slices: results.length + sliceReplays.length,
    created: results.length,
    replayed: sliceReplays.length,
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

/**
 * Self-registered dispatch descriptor for the `capture-sessions` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const captureSessionsRouteDescriptor: DispatchRouteDescriptor = {
  name: 'capture-sessions',
  order: 180,
  handle: ({ req, url, pool, company, identity, ctx, requireRole, readBody, sendJson }) =>
    handleCaptureSessionRoutes(req, url, {
      pool,
      company,
      identity,
      tier: ctx.tier,
      buildSha: getBuildSha(),
      storage: ctx.storage,
      maxArtifactBytes: Number(process.env.MAX_CAPTURE_ARTIFACT_BYTES ?? 50 * 1024 * 1024),
      artifactDownloadPresigned: ctx.blueprintDownloadPresigned,
      requireRole,
      // app_issue.capture gates finalize; app_issue.view gates the artifact
      // download — both on the platform boundary. See capture-sessions.ts.
      requireCapability: ctx.requireCapability,
      readBody,
      sendJson,
      sendFileContent: ctx.sendFileContent,
      sendFileRedirect: ctx.sendFileRedirect,
    }),
}
