import type http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { Pool } from 'pg'
import { validateCallback, type Callback, type CallbackArtifact, type Concern } from '@operator/projectkit'
import { createLogger } from '@sitelayer/logger'
import { withMutationTx, type LedgerExecutor } from '../mutation-tx.js'
import { appendContextHandoffEventTx, type HandoffEventType } from '../context-handoff.js'
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
 *        - terminal 'succeeded'|'failed'|'cancelled': stores the Callback,
 *          marks the row, stamps completed_at -> 202, then post-processes
 *          (work-item metadata.capture_analysis + context_handoff_events).
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

const TERMINAL_CALLBACK_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

export type AgentFeedRouteDeps = {
  pool: Pool
  storage: BlueprintStorage
  sendJson: (status: number, body: unknown) => void
  readBody: () => Promise<Record<string, unknown>>
  sendFileContent: (mimeType: string, fileName: string, content: Buffer | string) => void
  /** Raw AGENT_FEED_TOKENS value; defaults to process.env (injectable for tests). */
  tokensEnv?: string | undefined
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
 * Post-process a TERMINAL callback after it has been durably stored on the
 * concern row. Best-effort: a failure here is logged and never un-stores the
 * callback (the 202 to the executor is keyed off the durable store, exactly
 * like notifyCaptureWorkItem after finalize).
 *
 * - audience 'capture-analyzer' + succeeded + work_item_id: writes the
 *   analysis markdown (callback.outputs.stdout, capped) into the work item's
 *   metadata.capture_analysis and appends an `agent.artifact_attached`
 *   handoff event (the analysis is enrichment evidence, the closest existing
 *   vocabulary — debug-bundle enrichment attaches an artifact the same way).
 * - any other audience (e.g. 'steve'): appends `agent.completed` on success /
 *   `agent.message_received` on failed/cancelled so the operator sees the
 *   agent result on the work-item timeline.
 */
export async function applyTerminalCallbackEffects(row: AgentFeedConcernRow, callback: Callback): Promise<void> {
  if (!row.work_item_id) return
  const workItemId = row.work_item_id
  const completedAt = callback.completed_at ?? new Date().toISOString()
  const outputs = callbackOutputs(callback)
  const isAnalyzer = row.audience === CAPTURE_ANALYZER_AUDIENCE
  const succeeded = callback.status === 'succeeded'

  await withMutationTx(row.company_id, async (c) => {
    if (isAnalyzer && succeeded) {
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

    const eventType: HandoffEventType = succeeded
      ? isAnalyzer
        ? 'agent.artifact_attached'
        : 'agent.completed'
      : 'agent.message_received'
    await appendContextHandoffEventTx(c, {
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
        ...(isAnalyzer && succeeded ? { capture_analysis_attached: true } : {}),
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
    const claimed = await deps.pool.query<{ id: string }>(
      `update agent_feed_concerns
          set status = 'claimed', claimed_at = now(), updated_at = now()
        where id = $1 and company_id = $2 and status = 'pending'
        returning id`,
      [row.id, row.company_id],
    )
    if (!claimed.rows[0]) {
      deps.sendJson(409, { error: `concern is ${row.status === 'pending' ? 'already claimed' : row.status}` })
      return
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
