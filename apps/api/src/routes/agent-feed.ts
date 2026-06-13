import type http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import { validateCallback, type Callback, type CallbackArtifact, type Concern } from '@operator/projectkit'
import { createLogger } from '@sitelayer/logger'
import { withMutationTx, type LedgerExecutor } from '../mutation-tx.js'
import {
  appendContextHandoffEventTx,
  updateContextWorkItemWithEventTx,
  type HandoffEventType,
  type WorkItemLane,
  type WorkItemStatus,
} from '../context-handoff.js'
import { assertKeyInCompany, type BlueprintStorage } from '../storage.js'
import { isValidUuid } from '../http-utils.js'

/**
 * Agent feed — the PRODUCER side of the @operator/projectkit pull-executor
 * contract (bin/pull-executor.mjs "FEED CONTRACT"). Sitelayer hosts the feed;
 * executors (the local capture-analyzer, the collaborator Steve's Claude Code)
 * poll it for Concerns addressed to their audience and POST Callbacks back:
 *
 *   GET  /api/agent-feed/concerns?audience=<aud> -> 200 { concerns: Concern[] }
 *        (pending only, oldest first, capped)
 *   POST /api/agent-feed/callbacks               body: projectkit Callback JSON
 *        - 'accepted' = the CLAIM (lease): pending -> claimed -> 202;
 *          already claimed / terminal -> 409; unknown concern_ref -> 404.
 *          A WORK-DISPATCH claim also acknowledges the dispatch on the linked
 *          work item (agent.dispatch_acknowledged + status agent_running),
 *          which is what makes the work-dispatch-reconciler safety net see
 *          it; the capture-analyzer ENRICHMENT lane gets the ack event only —
 *          it never owns the item's status.
 *        - terminal 'succeeded'|'failed'|'cancelled': stores the Callback,
 *          marks the row, stamps completed_at -> 202, then post-processes
 *          (work-item metadata.capture_analysis + context_handoff_events +,
 *          for the work-dispatch lanes only, the lifecycle advance:
 *          succeeded -> review_ready via agent.completed, failed ->
 *          proposal_expired via agent.failed off agent_running).
 *   GET  /api/agent-feed/artifacts/:artifactId   streams capture_artifacts
 *        bytes (rrweb/audio/video/screenshot evidence) with the same auth.
 *
 * AUTH: machine clients, NOT Clerk sessions. Bearer tokens come from the
 * AGENT_FEED_TOKENS env — a JSON map {"<audience>":"<token>"} — compared in
 * constant time; a token only grants its OWN audience (a GET for another
 * audience is 403, and a Callback may only touch concerns whose audience
 * matches the token's). When AGENT_FEED_TOKENS is unset/invalid every route
 * answers 503: the feed is OFF and fails loud, never open.
 *
 * TENANCY: the feed is cross-tenant BY DESIGN (an executor lane spans
 * companies), so reads use the plain pool — reviewed in
 * rls-route-lint.test.ts RAW_QUERY_REVIEWED. Every write-back into a tenant's
 * work item goes through withMutationTx so the GUC binds the row's company.
 */

const logger = createLogger('agent-feed')

export const AGENT_FEED_TOKENS_ENV = 'AGENT_FEED_TOKENS'
/** Oldest-first page size the pull-executor sees per poll. */
const PENDING_CONCERNS_LIMIT = 20
/** Cap on the analysis markdown persisted into work-item metadata (~64KB). */
export const CAPTURE_ANALYSIS_MARKDOWN_MAX_BYTES = 64 * 1024

export const CAPTURE_ANALYZER_AUDIENCE = 'capture-analyzer'
const DEFAULT_AUDIENCE_LIVENESS_MAX_AGE_SECONDS = 300

const TERMINAL_CALLBACK_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

/**
 * Work-item statuses a feed callback must never overwrite — these are HUMAN
 * decisions (resolve / wont_do / reverse). A late agent callback still lands
 * on the timeline, but never reverses them.
 */
const TERMINAL_WORK_ITEM_STATUSES: ReadonlySet<string> = new Set(['resolved', 'wont_do', 'reversed'])

export type AgentFeedRouteDeps = {
  pool: Pool
  storage: BlueprintStorage
  sendJson: (status: number, body: unknown) => void
  readBody: () => Promise<Record<string, unknown>>
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
  /** Raw AGENT_FEED_TOKENS value; defaults to process.env (injectable for tests). */
  tokensEnv?: string | undefined
}

export type AgentFeedAudienceLiveness = {
  audience: string
  last_poll_at: string | null
  last_poll_age_seconds: number | null
  live: boolean
}

/**
 * Parse the AGENT_FEED_TOKENS env — a JSON map {"<audience>":"<token>"}.
 * Returns null when unset / unparseable / empty so the routes can fail LOUD
 * (503 feed-off), never open.
 */
export function parseAgentFeedTokens(raw: string | undefined): Map<string, string> | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const tokens = new Map<string, string>()
  for (const [audience, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof token !== 'string') continue
    const aud = audience.trim()
    const tok = token.trim()
    if (!aud || !tok) continue
    tokens.set(aud, tok)
  }
  return tokens.size > 0 ? tokens : null
}

/** Constant-time string comparison via fixed-length digests (length-safe). */
function constantTimeEquals(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest()
  const b = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(a, b)
}

function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token ? token : null
}

/**
 * Resolve the audience the presented bearer token grants. Every configured
 * token is compared (each in constant time) so a non-match costs the same as
 * a late match.
 */
function resolveTokenAudience(req: http.IncomingMessage, tokens: Map<string, string>): string | null {
  const presented = bearerToken(req)
  if (!presented) return null
  let matched: string | null = null
  for (const [audience, token] of tokens) {
    if (constantTimeEquals(presented, token)) matched = audience
  }
  return matched
}

function agentFeedLivenessMaxAgeSeconds(): number {
  const parsed = Number(process.env.SITELAYER_AGENT_FEED_LIVENESS_MAX_AGE_SECONDS)
  if (!Number.isFinite(parsed)) return DEFAULT_AUDIENCE_LIVENESS_MAX_AGE_SECONDS
  return Math.max(30, Math.min(3600, Math.floor(parsed)))
}

export async function recordAgentFeedAudiencePoll(executor: LedgerExecutor, audience: string): Promise<void> {
  await executor.query(
    `insert into agent_feed_audience_liveness (
       audience, last_poll_at, updated_at
     ) values ($1, now(), now())
     on conflict (audience) do update
       set last_poll_at = excluded.last_poll_at,
           updated_at = excluded.updated_at`,
    [audience],
  )
}

export async function loadAgentFeedAudienceLiveness(
  pool: Pool,
  audience: string,
  nowMs: number = Date.now(),
): Promise<AgentFeedAudienceLiveness | null> {
  const result = await pool.query<{ audience: string; last_poll_at: string | null }>(
    `select audience, last_poll_at::text as last_poll_at
       from agent_feed_audience_liveness
      where audience = $1
      limit 1`,
    [audience],
  )
  const row = result.rows[0]
  if (!row?.last_poll_at) return null
  const lastPollMs = Date.parse(row.last_poll_at)
  const ageSeconds = Number.isFinite(lastPollMs) ? Math.max(0, Math.floor((nowMs - lastPollMs) / 1000)) : null
  const maxAgeSeconds = agentFeedLivenessMaxAgeSeconds()
  return {
    audience: row.audience,
    last_poll_at: row.last_poll_at,
    last_poll_age_seconds: ageSeconds,
    live: ageSeconds !== null && ageSeconds <= maxAgeSeconds,
  }
}

// ---------------------------------------------------------------------------
// Concern artifact mapping + insert helpers (shared with the finalize wiring in
// capture-sessions.ts and the operator dispatch door in admin-work-requests.ts)
// ---------------------------------------------------------------------------

/** Canonical app base URL the artifact refs are minted against. */
export function agentFeedBaseUrl(): string {
  const explicit = process.env.APP_PUBLIC_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  // Tier-aware fallback: a hardcoded prod fallback mints refs a non-prod
  // analyzer can never fetch (caught live 2026-06-10: dev finalize minted
  // prod artifact URLs -> 401). APP_PUBLIC_URL stays the explicit override.
  switch (process.env.APP_TIER?.trim().toLowerCase()) {
    case 'dev':
      return 'https://dev.sitelayer.sandolab.xyz'
    case 'demo':
      return 'https://demo.preview.sitelayer.sandolab.xyz'
    case 'prod':
      return 'https://sitelayer.sandolab.xyz'
    default:
      return 'http://localhost:3001'
  }
}

export type CaptureArtifactSummaryRow = {
  id: string
  kind: string
  content_type: string | null
  byte_size: number | string | null
  duration_ms: number | string | null
}

/**
 * Map a capture session's stored artifact rows into the Concern
 * `inputs.artifacts` pointers the analyzer/Steve fetch back through
 * GET /api/agent-feed/artifacts/:id. The stored capture kinds translate to the
 * analyzer vocabulary: rrweb recording -> 'rrweb', mic audio -> 'audio',
 * screen video -> 'video', screenshots -> 'screenshot'; other registered kinds
 * pass through under their own (open-contract) name.
 */
export function mapCaptureArtifactsToConcernRefs(
  rows: readonly CaptureArtifactSummaryRow[],
  baseUrl: string = agentFeedBaseUrl(),
): CallbackArtifact[] {
  const artifacts: CallbackArtifact[] = []
  for (const row of rows) {
    if (!row.id || !row.kind) continue
    let kind: string
    switch (row.kind) {
      case 'rrweb':
        kind = 'rrweb'
        break
      case 'audio':
        kind = 'audio'
        break
      case 'video':
        kind = 'video'
        break
      case 'screenshot':
      case 'image':
        kind = 'screenshot'
        break
      default:
        kind = row.kind
    }
    const byteSize = row.byte_size === null || row.byte_size === undefined ? null : Number(row.byte_size)
    const durationMs = row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms)
    artifacts.push({
      kind,
      ref: `${baseUrl}/api/agent-feed/artifacts/${row.id}`,
      ...(row.content_type ? { content_type: row.content_type } : {}),
      ...(byteSize !== null && Number.isFinite(byteSize) ? { byte_size: byteSize } : {}),
      ...(durationMs !== null && Number.isFinite(durationMs) ? { duration_ms: durationMs } : {}),
    })
  }
  return artifacts
}

/**
 * Idempotent agent_feed_concerns insert keyed on (project_key, concern_ref).
 * Returns the inserted row id, or null when the concern already exists
 * (ON CONFLICT DO NOTHING — the producer-stable idempotency the contract
 * requires). Works on both a GUC-bound tx client (finalize) and the plain
 * pool with the explicit company_id param (admin dispatch door).
 */
export async function insertAgentFeedConcernTx(
  executor: LedgerExecutor,
  args: {
    companyId: string
    audience: string
    concern: Concern
    workItemId?: string | null
    captureSessionId?: string | null
  },
): Promise<string | null> {
  const result = await executor.query<{ id: string }>(
    `insert into agent_feed_concerns (
       company_id, audience, project_key, concern_ref, concern,
       work_item_id, capture_session_id
     ) values ($1, $2, $3, $4, $5::jsonb, $6::uuid, $7::uuid)
     on conflict (project_key, concern_ref) do nothing
     returning id`,
    [
      args.companyId,
      args.audience,
      args.concern.project_key,
      args.concern.concern_ref,
      JSON.stringify(args.concern),
      args.workItemId ?? null,
      args.captureSessionId ?? null,
    ],
  )
  return result.rows[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Feed routes
// ---------------------------------------------------------------------------

type AgentFeedConcernRow = {
  id: string
  company_id: string
  audience: string
  project_key: string
  concern_ref: string
  status: string
  work_item_id: string | null
  capture_session_id: string | null
}

async function listPendingConcerns(deps: AgentFeedRouteDeps, audience: string): Promise<void> {
  try {
    await recordAgentFeedAudiencePoll(deps.pool, audience)
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), audience },
      '[agent-feed] failed to record audience poll liveness',
    )
  }
  const result = await deps.pool.query<{ concern: Concern }>(
    `select concern
       from agent_feed_concerns
      where audience = $1 and status = 'pending'
      order by created_at asc, id asc
      limit $2`,
    [audience, PENDING_CONCERNS_LIMIT],
  )
  deps.sendJson(200, { concerns: result.rows.map((row) => row.concern) })
}

function callbackOutputs(callback: Callback): Record<string, unknown> {
  return typeof callback.outputs === 'object' && callback.outputs !== null ? callback.outputs : {}
}

/**
 * Post-process a successful CLAIM after the lease has been durably taken on
 * the concern row. Best-effort (a failure here never un-claims the lease):
 * appends `agent.dispatch_acknowledged` and — for the WORK-DISPATCH lanes
 * (e.g. 'steve') only — advances the linked work item to `agent_running`,
 * exactly the (status, event) pair the worker's work-dispatch-reconciler keys
 * on, so an agent-feed dispatch whose executor goes silent is covered by the
 * same L4 safety net as a mesh dispatch. The lane mirrors projectkit's
 * deriveTransition for agent.dispatch_acknowledged: stay 'both' when a human
 * is co-watching, else 'agent'.
 *
 * The capture-analyzer ENRICHMENT lane never owns the item: its claim appends
 * the ack event for the timeline but never touches status/lane (the
 * pull-executor claims with 'accepted' before working, so an analyzer claim
 * advancing a fresh item to agent_running would strand it there — the
 * analyzer's terminal callback is a metadata write-back only).
 *
 * Never reverses a terminal human decision (resolve/wont_do/reverse): in that
 * case the ack still lands on the timeline, status stays.
 *
 * `claimedAt` is the lease instance stamp from the durable claim UPDATE: it
 * salts the ack idempotency key so a RE-claim after a lease-sweep requeue
 * records its own auditable ack event, while a duplicate delivery of the SAME
 * claim instance stays idempotent.
 */
export async function applyClaimEffects(row: AgentFeedConcernRow, claimedAt: string | null): Promise<void> {
  if (!row.work_item_id) return
  const workItemId = row.work_item_id
  await withMutationTx(row.company_id, async (c) => {
    const current = await c.query<{ status: WorkItemStatus; lane: WorkItemLane }>(
      `select status, lane from context_work_items where company_id = $1 and id = $2 for update`,
      [row.company_id, workItemId],
    )
    const currentRow = current.rows[0]
    if (!currentRow) return
    const { status, lane } = currentRow
    const isAnalyzer = row.audience === CAPTURE_ANALYZER_AUDIENCE
    const advance = !isAnalyzer && !TERMINAL_WORK_ITEM_STATUSES.has(status)
    // projectkit deriveTransition(agent.dispatch_acknowledged): keep lane
    // 'both' when a human co-watches, else pure 'agent'.
    const nextLane: WorkItemLane = lane === 'both' ? 'both' : 'agent'
    await updateContextWorkItemWithEventTx(c, {
      companyId: row.company_id,
      workItemId,
      eventType: 'agent.dispatch_acknowledged',
      actorKind: 'agent',
      actorRef: `agent-feed:${row.audience}`,
      payload: {
        audience: row.audience,
        concern_ref: row.concern_ref,
        previous_status: status,
        ...(advance ? { status: 'agent_running', lane: nextLane } : {}),
      },
      metadata: {
        source: 'agent_feed_claim',
        dispatch_surface: 'agent_feed',
        audience: row.audience,
        concern_ref: row.concern_ref,
        ...(row.capture_session_id ? { capture_session_id: row.capture_session_id } : {}),
      },
      ...(advance ? { status: 'agent_running' as const, lane: nextLane } : {}),
      idempotencyKey: `agent_feed:${row.concern_ref}:claim:${claimedAt ?? 'unknown'}`,
    })
  })
}

/**
 * Post-process a TERMINAL callback after it has been durably stored on the
 * concern row. Best-effort: a failure here is logged and never un-stores the
 * callback (the 202 to the executor is keyed off the durable store, exactly
 * like notifyCaptureWorkItem after finalize).
 *
 * - audience 'capture-analyzer' (the ENRICHMENT lane) NEVER moves the item:
 *   succeeded + work_item_id writes the analysis markdown
 *   (callback.outputs.stdout, capped) into the work item's
 *   metadata.capture_analysis and appends an `agent.artifact_attached`
 *   handoff event (the analysis is enrichment evidence — debug-bundle
 *   enrichment attaches an artifact the same way); failed/cancelled appends
 *   an `agent.message_received` annotation with the error detail. Status and
 *   lane are untouched in BOTH cases — the analyzer never owns the item.
 * - any other audience (e.g. 'steve'): the RETURN leg must ADVANCE the work
 *   item, not just decorate the timeline. succeeded → `agent.completed` +
 *   status `review_ready` / lane `both` (projectkit's canonical transition —
 *   agents only ever reach review_ready; a human accepts to resolve).
 *   failed/cancelled → `agent.failed` (the sitelayer-local lifecycle
 *   extension; agent.message_received stays a pure annotation per the
 *   published reducer) + status `proposal_expired` / lane `both` — the same
 *   triage-able state the reconciler/stale sweeps use — but only off
 *   `agent_running`, so a human decision is never clobbered.
 */
export async function applyTerminalCallbackEffects(row: AgentFeedConcernRow, callback: Callback): Promise<void> {
  if (!row.work_item_id) return
  const workItemId = row.work_item_id
  const completedAt = callback.completed_at ?? new Date().toISOString()
  const outputs = callbackOutputs(callback)
  const isAnalyzer = row.audience === CAPTURE_ANALYZER_AUDIENCE
  const succeeded = callback.status === 'succeeded'

  await withMutationTx(row.company_id, async (c) => {
    if (isAnalyzer) {
      // The enrichment lane never owns the item: write-backs and annotations
      // only, status/lane untouched whatever the callback outcome.
      if (succeeded) {
        const stdout = typeof outputs.stdout === 'string' ? outputs.stdout : ''
        const markdown = stdout.slice(0, CAPTURE_ANALYSIS_MARKDOWN_MAX_BYTES)
        await c.query(
          `update context_work_items
              set metadata = metadata || $3::jsonb,
                  updated_at = now()
            where company_id = $1 and id = $2`,
          [
            row.company_id,
            workItemId,
            JSON.stringify({
              capture_analysis: {
                markdown,
                completed_at: completedAt,
                artifacts: Array.isArray(callback.artifacts) ? callback.artifacts : [],
              },
            }),
          ],
        )
      }
      await appendContextHandoffEventTx(c, {
        companyId: row.company_id,
        workItemId,
        eventType: succeeded ? 'agent.artifact_attached' : 'agent.message_received',
        actorKind: 'agent',
        actorRef: `agent-feed:${row.audience}`,
        payload: {
          audience: row.audience,
          concern_ref: row.concern_ref,
          callback_status: callback.status,
          completed_at: completedAt,
          ...(succeeded ? { capture_analysis_attached: true } : {}),
          ...(typeof callback.error === 'string' ? { error: callback.error } : {}),
          ...(typeof callback.error_code === 'string' ? { error_code: callback.error_code } : {}),
          ...(Array.isArray(callback.artifacts) ? { artifacts: callback.artifacts } : {}),
        },
        metadata: {
          source: 'agent_feed_callback',
          audience: row.audience,
          concern_ref: row.concern_ref,
          ...(row.capture_session_id ? { capture_session_id: row.capture_session_id } : {}),
        },
        idempotencyKey: `agent_feed:${row.concern_ref}:terminal`,
        captureSessionId: row.capture_session_id,
      })
      return
    }

    // Work-dispatch terminal: advance the work item through the same helper
    // every other lifecycle writer uses.
    const current = await c.query<{ status: WorkItemStatus }>(
      `select status from context_work_items where company_id = $1 and id = $2 for update`,
      [row.company_id, workItemId],
    )
    const currentStatus = current.rows[0]?.status
    if (!currentStatus) return
    const eventType: HandoffEventType = succeeded ? 'agent.completed' : 'agent.failed'
    const next: { status?: WorkItemStatus; lane?: WorkItemLane } =
      succeeded && !TERMINAL_WORK_ITEM_STATUSES.has(currentStatus)
        ? { status: 'review_ready', lane: 'both' }
        : !succeeded && currentStatus === 'agent_running'
          ? { status: 'proposal_expired', lane: 'both' }
          : {}
    await updateContextWorkItemWithEventTx(c, {
      companyId: row.company_id,
      workItemId,
      eventType,
      actorKind: 'agent',
      actorRef: `agent-feed:${row.audience}`,
      payload: {
        audience: row.audience,
        concern_ref: row.concern_ref,
        callback_status: callback.status,
        completed_at: completedAt,
        previous_status: currentStatus,
        ...(next.status ? { status: next.status, lane: next.lane } : {}),
        ...(typeof callback.error === 'string' ? { error: callback.error } : {}),
        ...(typeof callback.error_code === 'string' ? { error_code: callback.error_code } : {}),
        ...(Array.isArray(callback.artifacts) ? { artifacts: callback.artifacts } : {}),
      },
      metadata: {
        source: 'agent_feed_callback',
        audience: row.audience,
        concern_ref: row.concern_ref,
        ...(row.capture_session_id ? { capture_session_id: row.capture_session_id } : {}),
      },
      ...next,
      idempotencyKey: `agent_feed:${row.concern_ref}:terminal`,
    })
  })
}

async function handleCallback(deps: AgentFeedRouteDeps, audience: string): Promise<void> {
  const body = await deps.readBody()
  const problems = validateCallback(body)
  if (problems.length > 0) {
    deps.sendJson(400, { error: `invalid callback: ${problems.join('; ')}` })
    return
  }
  const callback = body as unknown as Callback

  const lookup = await deps.pool.query<AgentFeedConcernRow>(
    `select id, company_id, audience, project_key, concern_ref, status,
            work_item_id, capture_session_id
       from agent_feed_concerns
      where concern_ref = $1
      order by created_at asc
      limit 1`,
    [callback.concern_ref],
  )
  const row = lookup.rows[0]
  if (!row) {
    deps.sendJson(404, { error: 'unknown concern_ref' })
    return
  }
  // A token only ever touches its own audience's concerns.
  if (row.audience !== audience) {
    deps.sendJson(403, { error: 'concern is not addressed to this audience' })
    return
  }

  if (callback.status === 'accepted') {
    // THE CLAIM: the first accepted callback wins the lease. Guarded by the
    // status='pending' predicate so a concurrent second claim updates 0 rows.
    const claimed = await deps.pool.query<{ id: string; claimed_at: string | null }>(
      `update agent_feed_concerns
          set status = 'claimed', claimed_at = now(), updated_at = now()
        where id = $1 and company_id = $2 and status = 'pending'
        returning id, claimed_at::text as claimed_at`,
      [row.id, row.company_id],
    )
    if (!claimed.rows[0]) {
      deps.sendJson(409, { error: `concern is ${row.status === 'pending' ? 'already claimed' : row.status}` })
      return
    }
    // Best-effort AFTER the durable claim — the ack event + agent_running
    // move must never be able to un-claim the lease.
    try {
      await applyClaimEffects(row, claimed.rows[0].claimed_at)
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), concern_ref: row.concern_ref, audience },
        '[agent-feed] claim post-processing failed',
      )
    }
    deps.sendJson(202, { ok: true, concern_ref: row.concern_ref, status: 'claimed' })
    return
  }

  if (!TERMINAL_CALLBACK_STATUSES.has(callback.status)) {
    // 'running' (and any future transitional literal): acknowledged, no state
    // change — the feed only tracks claim + terminal.
    deps.sendJson(202, { ok: true, concern_ref: row.concern_ref, status: row.status })
    return
  }

  const completed = await deps.pool.query<{ id: string }>(
    `update agent_feed_concerns
        set status = $3,
            callback = $4::jsonb,
            completed_at = coalesce($5::timestamptz, now()),
            updated_at = now()
      where id = $1 and company_id = $2 and status in ('pending', 'claimed')
      returning id`,
    [row.id, row.company_id, callback.status, JSON.stringify(callback), callback.completed_at ?? null],
  )
  if (!completed.rows[0]) {
    deps.sendJson(409, { error: `concern is already ${row.status}` })
    return
  }

  // Best-effort enrichment AFTER the durable store — a post-processing failure
  // must never make the executor re-run the work.
  try {
    await applyTerminalCallbackEffects(row, callback)
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), concern_ref: row.concern_ref, audience },
      '[agent-feed] terminal callback post-processing failed',
    )
  }
  deps.sendJson(202, { ok: true, concern_ref: row.concern_ref, status: callback.status })
}

type ArtifactFileRow = {
  id: string
  company_id: string
  kind: string
  storage_key: string | null
  content_type: string | null
  metadata: Record<string, unknown> | null
}

async function streamArtifact(deps: AgentFeedRouteDeps, audience: string, artifactId: string): Promise<void> {
  // Authorization: the artifact must belong to a capture session referenced by
  // at least one agent_feed_concerns row of the caller's audience. Everything
  // else (other tenants' artifacts, sessions never fed to this lane) is an
  // indistinguishable 404.
  const result = await deps.pool.query<ArtifactFileRow>(
    `select a.id, a.company_id, a.kind, a.storage_key, a.content_type, a.metadata
       from capture_artifacts a
      where a.id = $1::uuid
        and a.deleted_at is null
        and exists (
          select 1
            from agent_feed_concerns f
           where f.audience = $2
             and f.company_id = a.company_id
             and f.capture_session_id = a.capture_session_id
        )
      limit 1`,
    [artifactId, audience],
  )
  const row = result.rows[0]
  if (!row) {
    deps.sendJson(404, { error: 'capture artifact not found' })
    return
  }
  if (!row.storage_key) {
    deps.sendJson(409, { error: 'capture artifact has no stored file' })
    return
  }
  try {
    assertKeyInCompany(row.company_id, row.storage_key)
  } catch (error) {
    deps.sendJson(400, { error: error instanceof Error ? error.message : 'invalid storage key' })
    return
  }
  const content = await deps.storage.get(row.storage_key)
  const metadataName = typeof row.metadata?.file_name === 'string' ? row.metadata.file_name.trim() : ''
  const fileName = metadataName || row.storage_key.split('/').pop() || `${row.kind}.bin`
  deps.sendFileContent(row.content_type || 'application/octet-stream', fileName, content)
}

export async function handleAgentFeedRoutes(
  req: http.IncomingMessage,
  url: URL,
  deps: AgentFeedRouteDeps,
): Promise<boolean> {
  if (!url.pathname.startsWith('/api/agent-feed/')) return false
  const method = (req.method ?? 'GET').toUpperCase()

  // Fail LOUD, never open: no configured tokens means the feed is off.
  const tokens = parseAgentFeedTokens(deps.tokensEnv ?? process.env[AGENT_FEED_TOKENS_ENV])
  if (!tokens) {
    deps.sendJson(503, { error: 'agent feed is not configured (AGENT_FEED_TOKENS unset)' })
    return true
  }

  const audience = resolveTokenAudience(req, tokens)
  if (!audience) {
    deps.sendJson(401, { error: 'agent feed requires a valid bearer token' })
    return true
  }

  if (url.pathname === '/api/agent-feed/concerns' && method === 'GET') {
    const requested = url.searchParams.get('audience')?.trim() || ''
    if (!requested) {
      deps.sendJson(400, { error: 'audience query parameter is required' })
      return true
    }
    if (requested !== audience) {
      deps.sendJson(403, { error: 'token does not grant the requested audience' })
      return true
    }
    await listPendingConcerns(deps, audience)
    return true
  }

  if (url.pathname === '/api/agent-feed/callbacks' && method === 'POST') {
    await handleCallback(deps, audience)
    return true
  }

  const artifactMatch = url.pathname.match(/^\/api\/agent-feed\/artifacts\/([^/]+)$/)
  if (artifactMatch && method === 'GET') {
    const artifactId = artifactMatch[1]!
    if (!isValidUuid(artifactId)) {
      deps.sendJson(400, { error: 'capture artifact id must be a uuid' })
      return true
    }
    await streamArtifact(deps, audience, artifactId)
    return true
  }

  deps.sendJson(404, { error: 'not found' })
  return true
}
