import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { setCompanyGuc } from '../runner-utils.js'
import type { ObjectStorageClient } from './blueprint-storage-gc.js'
import { createMediaUnderstandingProcessor } from '../media/create-media-understanding-processor.js'
import { resolveMediaUnderstandMode, type MediaProcessor, type MediaUnderstanding } from '../media/media-processor.js'

export type CaptureArtifactAnalysisSummary = {
  ran: boolean
  analyzed: number
  skipped: number
  failed: number
}

type CaptureArtifactAnalysisLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void
}

type VideoFrame = {
  index: number
  time_seconds: number
  content_type: string
  bytes: Buffer
  width?: number | null
  height?: number | null
}

type VideoFrameExtraction = {
  analyzer: string
  duration_seconds: number | null
  frames: VideoFrame[]
}

type VideoFrameExtractor = (input: {
  row: CaptureArtifactAnalysisRow
  bytes: Buffer
  frameCount: number
}) => Promise<VideoFrameExtraction>

type CaptureArtifactAnalysisRow = {
  id: string
  capture_session_id: string
  work_item_id: string
  kind: string
  storage_key: string | null
  uri: string | null
  content_type: string | null
  byte_size: number | null
  content_hash: string | null
  pii_level: string
  access_policy: string
  metadata: Record<string, unknown>
  retention_expires_at: string | null
}

type DerivedArtifactRef = {
  id: string
  kind: string
  content_type: string
  byte_size: number
  content_hash: string
  download_path: string
}

type ArtifactAnalysis = {
  status: 'attached' | 'skipped'
  artifact_kind: string
  content_type: string | null
  byte_size: number | null
  summary: string
  excerpt?: string
  stats?: Record<string, unknown>
  reason?: string
  analyzer?: string
  derived_artifact?: DerivedArtifactRef
  derived_artifacts?: DerivedArtifactRef[]
  // Structured multimodal understanding (summary / suggested title+severity /
  // action items) produced by a MediaProcessor when video mode is 'gemini'.
  understanding?: MediaUnderstanding
}

type AnalysisReadyWorkItemRow = {
  id: string
  support_packet_id: string | null
  capture_session_id: string | null
  title: string
  summary: string | null
  status: string
  lane: string
  severity: string | null
  route: string | null
  entity_type: string | null
  entity_id: string | null
  created_by_user_id: string | null
  reversibility_window_seconds: number | null
  metadata: Record<string, unknown>
}

const ANALYZABLE_KINDS = new Set(['transcript', 'text', 'rrweb', 'canvas_geometry'])
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false })
const AUDIO_ANALYSIS_MODES = ['off', 'local-whisper'] as const
const WHISPER_PAYLOAD_MODES = ['base64', 'path'] as const
const WHISPER_UNAVAILABLE_POLICIES = ['retry', 'skip'] as const
// 'gemini' is a superset of 'frames-only': it still extracts + stores frames,
// then runs a MediaProcessor.understand() pass over them (subscription CLI by
// default, cash API opt-in). Default stays 'off' so prod is untouched.
const VIDEO_ANALYSIS_MODES = ['off', 'frames-only', 'gemini'] as const
const DEFAULT_CALLBACK_TOKEN_TTL_HOURS = 72

export function createCaptureArtifactAnalysisRunner(deps: {
  pool: Pool
  storage: ObjectStorageClient | null
  logger?: CaptureArtifactAnalysisLogger
  videoFrameExtractor?: VideoFrameExtractor
}) {
  const { pool, storage, logger, videoFrameExtractor = extractVideoFramesWithFfmpeg } = deps
  let lastRunAt = 0

  return {
    async maybeAnalyze(companyId: string): Promise<CaptureArtifactAnalysisSummary> {
      if (!storage) return { ran: false, analyzed: 0, skipped: 0, failed: 0 }
      const intervalMs = readPositiveInt('CAPTURE_ARTIFACT_ANALYSIS_INTERVAL_MS', 60_000)
      const now = Date.now()
      if (now - lastRunAt < intervalMs) return { ran: false, analyzed: 0, skipped: 0, failed: 0 }
      lastRunAt = now
      return analyzeCaptureArtifacts(pool, storage, companyId, { logger, videoFrameExtractor })
    },
    async forceAnalyze(companyId: string): Promise<CaptureArtifactAnalysisSummary> {
      if (!storage) return { ran: false, analyzed: 0, skipped: 0, failed: 0 }
      return analyzeCaptureArtifacts(pool, storage, companyId, { logger, videoFrameExtractor })
    },
  }
}

async function analyzeCaptureArtifacts(
  pool: Pool,
  storage: ObjectStorageClient,
  companyId: string,
  deps: { logger: CaptureArtifactAnalysisLogger | undefined; videoFrameExtractor: VideoFrameExtractor },
): Promise<CaptureArtifactAnalysisSummary> {
  const { logger, videoFrameExtractor } = deps
  const limit = Math.min(readPositiveInt('CAPTURE_ARTIFACT_ANALYSIS_LIMIT', 10), 50)
  const maxBytes = readPositiveInt('CAPTURE_ARTIFACT_ANALYSIS_MAX_BYTES', 1024 * 1024)
  const audioMode = readMode('CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE', AUDIO_ANALYSIS_MODES, 'off')
  const videoMode = readMode('CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE', VIDEO_ANALYSIS_MODES, 'off')
  const videoFrameCount = Math.min(readPositiveInt('CAPTURE_ARTIFACT_VIDEO_FRAME_COUNT', 3), 12)
  // Multimodal-understanding engine, built once per run, applied to BOTH audio
  // transcripts and sampled video frames. Master toggle is
  // MEDIA_UNDERSTANDING_ENGINE (off | llama-swap=$0 local GPU |
  // gemini-cli=$0 subscription | gemini-api=cash/gated | stub=offline); the
  // legacy CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE='gemini' acts as a back-compat
  // alias that turns the CLI engine on.
  const understandMode = resolveMediaUnderstandMode(
    process.env.MEDIA_UNDERSTANDING_ENGINE ?? (videoMode === 'gemini' ? 'gemini-cli' : 'off'),
  )
  const understandingProcessor = createMediaUnderstandingProcessor(understandMode)
  const client = await pool.connect()
  const summary: CaptureArtifactAnalysisSummary = { ran: true, analyzed: 0, skipped: 0, failed: 0 }
  try {
    await client.query('begin')
    await setCompanyGuc(client, companyId)
    const artifacts = await client.query<CaptureArtifactAnalysisRow>(
      `select a.id,
              a.capture_session_id::text as capture_session_id,
              w.id as work_item_id,
              a.kind,
              a.storage_key,
              a.uri,
              a.content_type,
              a.byte_size,
              a.content_hash,
              a.pii_level,
              a.access_policy,
              a.metadata,
              a.retention_expires_at
         from capture_artifacts a
         join context_work_items w
           on w.company_id = a.company_id
          and w.capture_session_id = a.capture_session_id
          and w.metadata ->> 'source' = 'capture_session_finalize'
        where a.company_id = $1
          and a.deleted_at is null
          and not (a.metadata ? 'derived_from_artifact_id')
          and (
            (
              a.storage_key is not null
              and (
                a.kind = any($2::text[])
                or a.content_type like 'text/%'
                or a.content_type = 'application/json'
                or ($4::boolean and (a.kind = 'audio' or a.content_type like 'audio/%'))
                or ($5::boolean and (a.kind = 'video' or a.content_type like 'video/%'))
              )
            )
            or (a.storage_key is null and a.uri is not null)
          )
          and not exists (
            select 1 from context_handoff_events e
             where e.company_id = a.company_id
               and e.work_item_id = w.id
               and e.idempotency_key = 'capture_artifact:analysis:' || a.id::text
          )
        order by a.created_at asc
        limit $3
        for update of a skip locked`,
      [companyId, Array.from(ANALYZABLE_KINDS), limit, audioMode !== 'off', videoMode !== 'off'],
    )

    for (const row of artifacts.rows) {
      await client.query('savepoint capture_artifact_analysis_row')
      try {
        if (!row.storage_key) {
          await appendAnalysisEvent(client, companyId, row, analyzeReferenceArtifact(row))
          await refreshAnalysisReadiness(client, companyId, row.work_item_id, { audioMode, videoMode })
          await enqueueAnalysisReadyDispatchIfRequested(client, companyId, row.work_item_id)
          await client.query('release savepoint capture_artifact_analysis_row')
          summary.analyzed += 1
          continue
        }
        if (!storageKeyInCompany(companyId, row.storage_key)) {
          await appendAnalysisEvent(client, companyId, row, skippedAnalysis(row, 'storage key outside company scope'))
          await client.query('release savepoint capture_artifact_analysis_row')
          summary.skipped += 1
          continue
        }
        if (row.byte_size !== null && row.byte_size > maxBytes) {
          await appendAnalysisEvent(client, companyId, row, skippedAnalysis(row, `artifact exceeds ${maxBytes} bytes`))
          await client.query('release savepoint capture_artifact_analysis_row')
          summary.skipped += 1
          continue
        }
        const bytes = await storage.get(row.storage_key)
        if (bytes.byteLength > maxBytes) {
          await appendAnalysisEvent(client, companyId, row, skippedAnalysis(row, `artifact exceeds ${maxBytes} bytes`))
          await client.query('release savepoint capture_artifact_analysis_row')
          summary.skipped += 1
          continue
        }
        const analysis = isVideoArtifact(row)
          ? await analyzeVideoArtifact(client, storage, companyId, row, bytes, videoMode, videoFrameExtractor, {
              frameCount: videoFrameCount,
              understandingProcessor,
            })
          : isAudioArtifact(row)
            ? await analyzeAudioArtifact(client, storage, companyId, row, bytes, audioMode, understandingProcessor)
            : analyzeBytes(row, bytes)
        await appendAnalysisEvent(client, companyId, row, analysis)
        await refreshAnalysisReadiness(client, companyId, row.work_item_id, { audioMode, videoMode })
        await enqueueAnalysisReadyDispatchIfRequested(client, companyId, row.work_item_id)
        await client.query('release savepoint capture_artifact_analysis_row')
        if (analysis.status === 'skipped') summary.skipped += 1
        else summary.analyzed += 1
      } catch (error) {
        await client.query('rollback to savepoint capture_artifact_analysis_row').catch((rollbackError) => {
          logger?.warn(
            {
              err: rollbackError,
              company_id: companyId,
              capture_session_id: row.capture_session_id,
              capture_artifact_id: row.id,
              capture_artifact_kind: row.kind,
            },
            '[capture-artifact-analysis] artifact savepoint rollback failed',
          )
          throw rollbackError
        })
        await client.query('release savepoint capture_artifact_analysis_row').catch(() => undefined)
        logger?.warn(
          {
            err: error,
            company_id: companyId,
            capture_session_id: row.capture_session_id,
            capture_artifact_id: row.id,
            capture_artifact_kind: row.kind,
          },
          '[capture-artifact-analysis] artifact analysis failed',
        )
        summary.failed += 1
      }
    }
    await refreshAnalysisReadinessForFinalizedWorkItems(client, companyId, { audioMode, videoMode }, limit)
    await enqueueAnalysisReadyDispatchesIfRequested(client, companyId, { limit })
    await client.query('commit')
    return summary
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function refreshAnalysisReadiness(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<unknown> },
  companyId: string,
  workItemId: string,
  modes: {
    audioMode: (typeof AUDIO_ANALYSIS_MODES)[number]
    videoMode: (typeof VIDEO_ANALYSIS_MODES)[number]
  },
) {
  await client.query(
    `with eligible as (
       select a.id
         from capture_artifacts a
         join context_work_items w
           on w.company_id = a.company_id
          and w.capture_session_id = a.capture_session_id
          and w.metadata ->> 'source' = 'capture_session_finalize'
        where a.company_id = $1
          and w.id = $2
          and a.deleted_at is null
          and not (a.metadata ? 'derived_from_artifact_id')
          and (
            (
              a.storage_key is not null
              and (
                a.kind = any($5::text[])
                or a.content_type like 'text/%'
                or a.content_type = 'application/json'
                or ($6::boolean and (a.kind = 'audio' or a.content_type like 'audio/%'))
                or ($7::boolean and (a.kind = 'video' or a.content_type like 'video/%'))
              )
            )
            or (a.storage_key is null and a.uri is not null)
          )
     ),
     processed as (
       select e.id
         from eligible e
         join context_handoff_events h
           on h.company_id = $1
          and h.work_item_id = $2
          and h.idempotency_key = 'capture_artifact:analysis:' || e.id::text
     ),
     counts as (
       select count(*)::int as eligible_count,
              (select count(*)::int from processed) as processed_count
         from eligible
     )
     update context_work_items
        set metadata = metadata || jsonb_build_object(
              'capture_artifact_analysis',
              jsonb_build_object(
                'status',
                case when counts.eligible_count <= counts.processed_count then 'ready' else 'pending' end,
                'eligible_artifact_count', counts.eligible_count,
                'processed_artifact_count', counts.processed_count,
                'pending_artifact_count', greatest(counts.eligible_count - counts.processed_count, 0),
                'audio_mode', $3::text,
                'video_mode', $4::text,
                'updated_at', now()
              )
            ),
            updated_at = now()
       from counts
      where context_work_items.company_id = $1
        and context_work_items.id = $2`,
    [
      companyId,
      workItemId,
      modes.audioMode,
      modes.videoMode,
      Array.from(ANALYZABLE_KINDS),
      modes.audioMode !== 'off',
      modes.videoMode !== 'off',
    ],
  )
}

async function refreshAnalysisReadinessForFinalizedWorkItems(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows?: Array<{ id: string }> }> },
  companyId: string,
  modes: {
    audioMode: (typeof AUDIO_ANALYSIS_MODES)[number]
    videoMode: (typeof VIDEO_ANALYSIS_MODES)[number]
  },
  limit: number,
) {
  const result = await client.query(
    `select id::text
       from context_work_items
      where company_id = $1
        and metadata ->> 'source' = 'capture_session_finalize'
        and coalesce(metadata -> 'capture_artifact_analysis' ->> 'status', '') <> 'ready'
      order by updated_at asc
      limit $2`,
    [companyId, limit],
  )
  for (const row of result.rows ?? []) {
    await refreshAnalysisReadiness(client, companyId, row.id, modes)
  }
}

async function enqueueAnalysisReadyDispatchIfRequested(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows?: AnalysisReadyWorkItemRow[] }> },
  companyId: string,
  workItemId: string,
) {
  await enqueueAnalysisReadyDispatchesIfRequested(client, companyId, { workItemId, limit: 1 })
}

async function enqueueAnalysisReadyDispatchesIfRequested(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows?: AnalysisReadyWorkItemRow[] }> },
  companyId: string,
  options: { workItemId?: string; limit: number },
) {
  if (process.env.CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH !== '1') return
  const result = await client.query(
    `select id::text,
            support_packet_id::text,
            capture_session_id::text,
            title,
            summary,
            status,
            lane,
            severity,
            route,
            entity_type,
            entity_id,
            created_by_user_id,
            reversibility_window_seconds,
            metadata
       from context_work_items
      where company_id = $1
        and ($2::uuid is null or id = $2::uuid)
        and status in ('new', 'triaged', 'review_ready')
        and (
          lane in ('agent', 'both')
          or metadata ->> 'capture_auto_dispatch' = 'true'
        )
        and metadata -> 'capture_artifact_analysis' ->> 'status' = 'ready'
        and not exists (
          select 1
            from mutation_outbox m
           where m.company_id = context_work_items.company_id
             and m.idempotency_key = 'context_work_item:dispatch_mesh:' || context_work_items.id::text
        )
      order by updated_at asc
      limit $3`,
    [companyId, options.workItemId ?? null, options.limit],
  )
  for (const row of result.rows ?? []) {
    await enqueueAnalysisReadyDispatchForRow(client, companyId, row)
  }
}

async function enqueueAnalysisReadyDispatchForRow(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<unknown> },
  companyId: string,
  row: AnalysisReadyWorkItemRow,
) {
  const idempotencyKey = `context_work_item:dispatch_mesh:${row.id}`
  const callbackToken = newCallbackToken()
  const callbackPath = `/api/work-requests/${row.id}/agent-callback`
  const callback = {
    path: callbackPath,
    url: callbackUrlForPath(callbackPath),
    token: callbackToken,
    token_type: 'scoped_bearer' as const,
    expires_at: callbackTokenExpiresAt(),
  }
  const readiness = (row.metadata.capture_artifact_analysis ?? null) as Record<string, unknown> | null
  const captureExport = buildCaptureExportInstructions(row.capture_session_id)
  const payload = {
    work_item_id: row.id,
    support_packet_id: row.support_packet_id,
    capture_session_id: row.capture_session_id,
    title: row.title,
    summary: row.summary,
    route: row.route,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    status: row.status,
    lane: row.lane,
    severity: row.severity,
    reversibility_window_seconds: row.reversibility_window_seconds,
    work_request_brief: {
      schema: 'sitelayer.capture_analysis_ready.v1',
      capture_session_id: row.capture_session_id,
      capture_artifact_analysis: readiness,
      capture_export: captureExport,
      callback: {
        path: callback.path,
        url: callback.url,
        token_type: callback.token_type,
        expires_at: callback.expires_at,
      },
    },
    agent_brief_markdown: buildAnalysisReadyBrief(row, readiness, captureExport),
    callback,
  }
  await client.query(
    `update context_work_items
        set agent_callback_token_hash = $3,
            agent_callback_token_issued_at = now(),
            updated_at = now()
      where company_id = $1 and id = $2`,
    [companyId, row.id, hashCallbackToken(callbackToken)],
  )
  await client.query(
    `insert into mutation_outbox (
       company_id, device_id, actor_user_id, entity_type, entity_id,
       mutation_type, payload, idempotency_key, status, capture_session_id
     ) values (
       $1, 'worker:capture-artifact-analysis', $2, 'context_work_item', $3,
       'dispatch_mesh_work_request', $4::jsonb, $5, 'pending', $6::uuid
     )
     on conflict (company_id, idempotency_key) do nothing`,
    [companyId, row.created_by_user_id, row.id, JSON.stringify(payload), idempotencyKey, row.capture_session_id],
  )
  await client.query(
    `insert into context_handoff_events (
       company_id, work_item_id, event_type, actor_kind, actor_ref,
       source_system, payload, metadata, idempotency_key, capture_session_id,
       redaction_version
     )
     select $1, $2, 'agent.dispatch_queued', 'system', 'capture-artifact-analysis',
            'sitelayer-worker', $3::jsonb, $4::jsonb, $5, capture_session_id,
            'capture-artifact-analysis-v1'
       from context_work_items
      where company_id = $1 and id = $2
     on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      companyId,
      row.id,
      JSON.stringify({
        queued: true,
        mutation_type: 'dispatch_mesh_work_request',
        reason: 'capture_artifact_analysis_ready',
        capture_session_id: row.capture_session_id,
        capture_artifact_analysis: readiness,
      }),
      JSON.stringify({ source: 'capture_artifact_analysis', dispatcher: 'mesh' }),
      `capture_artifact_analysis:dispatch_queued:${row.id}`,
    ],
  )
}

function buildCaptureExportInstructions(captureSessionId: string | null): Record<string, unknown> | null {
  if (!captureSessionId) return null
  // The export runs inside the agent's checkout of the sitelayer repo. Operators
  // can pin the path via CAPTURE_EXPORT_CWD (or SITELAYER_REPO_ROOT); otherwise
  // the brief omits cwd so the agent runs from its own working dir. Never bake a
  // specific machine's home path into a dispatched brief (breaks every other
  // deployment/agent).
  const cwd = process.env.CAPTURE_EXPORT_CWD ?? process.env.SITELAYER_REPO_ROOT
  return {
    command: 'npm run capture:export',
    args: ['--', '--include-artifact-files'],
    ...(cwd ? { cwd } : {}),
    env: {
      CAPTURE_SESSION_ID: captureSessionId,
    },
    output: `/tmp/sitelayer-capture-export/${captureSessionId}/`,
    note: 'Exports the session envelope, artifact manifest, allowed artifact files, derived summaries, and analyzer handoff using the configured Sitelayer database and object storage env.',
  }
}

function buildAnalysisReadyBrief(
  row: AnalysisReadyWorkItemRow,
  readiness: Record<string, unknown> | null,
  captureExport: Record<string, unknown> | null,
): string {
  return [
    'Capture artifact analysis is ready for this work item.',
    '',
    `Title: ${row.title}`,
    `Capture session: ${row.capture_session_id ?? ''}`,
    `Route: ${row.route ?? ''}`,
    `Lane: ${row.lane}`,
    `Status: ${row.status}`,
    `Analysis readiness: ${JSON.stringify(readiness ?? null)}`,
    `Evidence export: ${
      captureExport
        ? `CAPTURE_SESSION_ID=${row.capture_session_id} npm run capture:export -- --include-artifact-files`
        : ''
    }`,
    '',
    'Use the context handoff timeline and attached artifact summaries before deciding whether this needs implementation.',
  ].join('\n')
}

function newCallbackToken(): string {
  return randomBytes(32).toString('base64url')
}

function hashCallbackToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function callbackTokenExpiresAt(now = Date.now()): string {
  const ttlHours = Math.min(
    720,
    Math.max(1, readPositiveInt('WORK_REQUEST_CALLBACK_TOKEN_TTL_HOURS', DEFAULT_CALLBACK_TOKEN_TTL_HOURS)),
  )
  return new Date(now + ttlHours * 60 * 60 * 1000).toISOString()
}

function callbackUrlForPath(pathname: string): string | null {
  const base = normalizePublicBaseUrl(
    process.env.SITELAYER_PUBLIC_BASE ?? process.env.PUBLIC_BASE_URL ?? process.env.APP_PUBLIC_BASE_URL ?? null,
  )
  return base ? `${base}${pathname}` : null
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

async function appendAnalysisEvent(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<unknown> },
  companyId: string,
  row: CaptureArtifactAnalysisRow,
  analysis: ArtifactAnalysis,
) {
  const payload: Record<string, unknown> = {
    artifact_id: row.id,
    artifact_kind: row.kind,
    capture_session_id: row.capture_session_id,
    content_type: row.content_type,
    byte_size: row.byte_size,
    content_hash: row.content_hash,
    analysis,
  }
  if (row.storage_key) {
    payload.download_path = `/api/capture-sessions/${row.capture_session_id}/artifacts/${row.id}/file`
  }
  if (row.uri) {
    payload.reference = safeReferenceUri(row.uri)
  }
  await client.query(
    `insert into context_handoff_events (
       company_id, work_item_id, event_type, actor_kind, actor_ref, source_system,
       payload, metadata, idempotency_key, capture_session_id, redaction_version
     ) values (
       $1, $2, 'agent.artifact_attached', 'system', 'capture-artifact-analysis',
       'sitelayer-worker', $3::jsonb, $4::jsonb, $5, $6::uuid,
       'capture-artifact-analysis-v1'
     )
     on conflict (company_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      companyId,
      row.work_item_id,
      JSON.stringify(payload),
      JSON.stringify({
        source: 'capture_artifact_analysis',
        analyzer: analysis.analyzer ?? 'deterministic-text-v1',
        capture_artifact_id: row.id,
        artifact_kind: row.kind,
        content_hash: row.content_hash,
      }),
      `capture_artifact:analysis:${row.id}`,
      row.capture_session_id,
    ],
  )
}

async function analyzeAudioArtifact(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows?: Array<{ id: string }> }> },
  storage: ObjectStorageClient,
  companyId: string,
  row: CaptureArtifactAnalysisRow,
  bytes: Buffer,
  mode: (typeof AUDIO_ANALYSIS_MODES)[number],
  understandingProcessor?: MediaProcessor | null,
): Promise<ArtifactAnalysis> {
  if (mode !== 'local-whisper') return skippedAnalysis(row, `audio analysis mode ${mode} is disabled`)
  let transcript: Required<Pick<LocalWhisperResponse, 'text'>> & LocalWhisperResponse
  try {
    transcript = await transcribeWithLocalWhisper(row, bytes)
  } catch (error) {
    const unavailablePolicy = readMode(
      'CAPTURE_ARTIFACT_WHISPER_UNAVAILABLE_POLICY',
      WHISPER_UNAVAILABLE_POLICIES,
      'retry',
    )
    if (unavailablePolicy === 'retry') {
      throw new Error(`local whisper unavailable: ${errorMessage(error)}`, { cause: error })
    }
    return {
      ...skippedAnalysis(row, `local whisper unavailable: ${errorMessage(error)}`),
      analyzer: 'local-whisper-v1',
    }
  }
  const text = transcript.text.trim()
  if (!text) return skippedAnalysis(row, 'local whisper returned an empty transcript')
  const compact = text.replace(/\s+/g, ' ')
  const derived = await insertDerivedTranscriptArtifact(client, storage, companyId, row, {
    text,
    analyzer: 'local-whisper-v1',
    stats: {
      language: transcript.language ?? null,
      language_probability: transcript.language_probability ?? null,
      duration_seconds: transcript.duration ?? null,
      transcription_time_seconds: transcript.transcription_time ?? null,
      transcript_quality: transcript.transcript_quality ?? null,
      segments: Array.isArray(transcript.segments) ? transcript.segments.length : null,
    },
  })

  // When an understanding engine is configured, derive a summary + suggested
  // title/severity + action items from the transcript. Best-effort: a failure
  // never fails the transcription, so the transcript still attaches.
  let understanding: MediaUnderstanding | undefined
  let understandingError: string | undefined
  if (understandingProcessor) {
    try {
      understanding = await understandingProcessor.understand({
        transcript: text,
        context: { kind: row.kind, capture_session_id: row.capture_session_id },
      })
    } catch (error) {
      understandingError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    status: 'attached',
    artifact_kind: row.kind,
    content_type: row.content_type,
    byte_size: row.byte_size,
    summary: understanding
      ? understanding.summary
      : `Audio artifact transcribed ${compact.split(/\s+/).length} word(s).`,
    excerpt: compact.slice(0, 2000),
    analyzer: 'local-whisper-v1',
    stats: {
      ...derived.stats,
      ...(understanding ? { understanding_action_item_count: understanding.action_items.length } : {}),
      ...(understandingError ? { understanding_error: understandingError } : {}),
    },
    derived_artifact: derived.artifact,
    ...(understanding ? { understanding } : {}),
  }
}

async function analyzeVideoArtifact(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows?: Array<{ id: string }> }> },
  storage: ObjectStorageClient,
  companyId: string,
  row: CaptureArtifactAnalysisRow,
  bytes: Buffer,
  mode: (typeof VIDEO_ANALYSIS_MODES)[number],
  frameExtractor: VideoFrameExtractor,
  opts: { frameCount: number; understandingProcessor?: MediaProcessor | null },
): Promise<ArtifactAnalysis> {
  if (mode === 'off') return skippedAnalysis(row, `video analysis mode ${mode} is disabled`)
  const extracted = await frameExtractor({ row, bytes, frameCount: opts.frameCount })
  if (extracted.frames.length === 0) return skippedAnalysis(row, 'video frame extractor returned no frames')
  const derived = await insertDerivedVideoFrameArtifacts(client, storage, companyId, row, extracted)

  // When an understanding engine is configured, run a MediaProcessor.understand()
  // pass over the sampled frames. Best-effort: a failure (CLI absent, API error)
  // degrades to frames-only — it never fails the artifact, so frames still attach.
  let understanding: MediaUnderstanding | undefined
  let understandingError: string | undefined
  if (opts.understandingProcessor) {
    try {
      understanding = await opts.understandingProcessor.understand({
        frames: extracted.frames,
        context: { kind: row.kind, capture_session_id: row.capture_session_id },
      })
    } catch (error) {
      understandingError = error instanceof Error ? error.message : String(error)
    }
  }

  return {
    status: 'attached',
    artifact_kind: row.kind,
    content_type: row.content_type,
    byte_size: row.byte_size,
    summary: understanding
      ? understanding.summary
      : `Video artifact extracted ${derived.frames.length} frame(s) for multimodal review.`,
    analyzer: extracted.analyzer,
    stats: {
      duration_seconds: extracted.duration_seconds,
      requested_frame_count: opts.frameCount,
      extracted_frame_count: derived.frames.length,
      manifest_artifact_id: derived.manifest.id,
      frame_artifact_ids: derived.frames.map((frame) => frame.id),
      ...(understanding ? { understanding_action_item_count: understanding.action_items.length } : {}),
      ...(understandingError ? { understanding_error: understandingError } : {}),
    },
    derived_artifact: derived.manifest,
    derived_artifacts: derived.frames,
    ...(understanding ? { understanding } : {}),
  }
}

async function insertDerivedVideoFrameArtifacts(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows?: Array<{ id: string }> }> },
  storage: ObjectStorageClient,
  companyId: string,
  source: CaptureArtifactAnalysisRow,
  extracted: VideoFrameExtraction,
): Promise<{ manifest: DerivedArtifactRef; frames: DerivedArtifactRef[] }> {
  const storedKeys: string[] = []
  try {
    const frames: DerivedArtifactRef[] = []
    for (const frame of extracted.frames) {
      const frameHash = `sha256:${createHash('sha256').update(frame.bytes).digest('hex')}`
      const frameName = `${safeStorageName(source.id)}-frame-${String(frame.index).padStart(2, '0')}.jpg`
      const frameStorageKey = `${companyId}/capture-sessions/${source.capture_session_id}/derived/${frameName}`
      await storage.put(frameStorageKey, frame.bytes, frame.content_type)
      storedKeys.push(frameStorageKey)
      const inserted = await client.query(
        `insert into capture_artifacts (
           company_id, capture_session_id, kind, storage_key, uri, content_type,
           byte_size, content_hash, duration_ms, pii_level, access_policy,
           metadata, retention_expires_at, redaction_version
         ) values (
           $1, $2, 'video_frame', $3, null, $4,
           $5, $6, null, $7, $8,
           $9::jsonb, $10::timestamptz, 'capture-artifact-analysis-v1'
         )
         returning id`,
        [
          companyId,
          source.capture_session_id,
          frameStorageKey,
          frame.content_type,
          frame.bytes.byteLength,
          frameHash,
          normalizedPiiLevel(source.pii_level),
          normalizedAccessPolicy(source.access_policy),
          JSON.stringify({
            source: 'capture_artifact_analysis',
            analyzer: extracted.analyzer,
            derived_from_artifact_id: source.id,
            derived_from_content_hash: source.content_hash,
            frame_index: frame.index,
            time_seconds: frame.time_seconds,
            width: frame.width ?? null,
            height: frame.height ?? null,
          }),
          source.retention_expires_at,
        ],
      )
      const id = inserted.rows?.[0]?.id ?? ''
      frames.push({
        id,
        kind: 'video_frame',
        content_type: frame.content_type,
        byte_size: frame.bytes.byteLength,
        content_hash: frameHash,
        download_path: `/api/capture-sessions/${source.capture_session_id}/artifacts/${id}/file`,
      })
    }

    const manifestContents = Buffer.from(
      `${JSON.stringify(
        {
          source: 'capture_artifact_analysis',
          analyzer: extracted.analyzer,
          source_artifact_id: source.id,
          source_content_hash: source.content_hash,
          capture_session_id: source.capture_session_id,
          duration_seconds: extracted.duration_seconds,
          frames: frames.map((frame, index) => ({
            artifact_id: frame.id,
            download_path: frame.download_path,
            content_type: frame.content_type,
            byte_size: frame.byte_size,
            content_hash: frame.content_hash,
            frame_index: extracted.frames[index]?.index ?? index,
            time_seconds: extracted.frames[index]?.time_seconds ?? null,
          })),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const manifestHash = `sha256:${createHash('sha256').update(manifestContents).digest('hex')}`
    const manifestStorageKey = `${companyId}/capture-sessions/${source.capture_session_id}/derived/${safeStorageName(
      source.id,
    )}-video-frame-manifest.json`
    await storage.put(manifestStorageKey, manifestContents, 'application/json; charset=utf-8')
    storedKeys.push(manifestStorageKey)
    const insertedManifest = await client.query(
      `insert into capture_artifacts (
         company_id, capture_session_id, kind, storage_key, uri, content_type,
         byte_size, content_hash, duration_ms, pii_level, access_policy,
         metadata, retention_expires_at, redaction_version
       ) values (
         $1, $2, 'video_frame_manifest', $3, null, 'application/json; charset=utf-8',
         $4, $5, null, $6, $7,
         $8::jsonb, $9::timestamptz, 'capture-artifact-analysis-v1'
       )
       returning id`,
      [
        companyId,
        source.capture_session_id,
        manifestStorageKey,
        manifestContents.byteLength,
        manifestHash,
        normalizedPiiLevel(source.pii_level),
        normalizedAccessPolicy(source.access_policy),
        JSON.stringify({
          source: 'capture_artifact_analysis',
          analyzer: extracted.analyzer,
          derived_from_artifact_id: source.id,
          derived_from_content_hash: source.content_hash,
          frame_artifact_count: frames.length,
        }),
        source.retention_expires_at,
      ],
    )
    const manifestId = insertedManifest.rows?.[0]?.id ?? ''
    return {
      frames,
      manifest: {
        id: manifestId,
        kind: 'video_frame_manifest',
        content_type: 'application/json; charset=utf-8',
        byte_size: manifestContents.byteLength,
        content_hash: manifestHash,
        download_path: `/api/capture-sessions/${source.capture_session_id}/artifacts/${manifestId}/file`,
      },
    }
  } catch (error) {
    await Promise.all(storedKeys.map((key) => storage.deleteObject(key).catch(() => undefined)))
    throw error
  }
}

async function insertDerivedTranscriptArtifact(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<{ rows?: Array<{ id: string }> }> },
  storage: ObjectStorageClient,
  companyId: string,
  source: CaptureArtifactAnalysisRow,
  transcript: { text: string; analyzer: string; stats: Record<string, unknown> },
): Promise<{ artifact: DerivedArtifactRef; stats: Record<string, unknown> }> {
  const contents = Buffer.from(`${transcript.text.trim()}\n`, 'utf8')
  const contentHash = `sha256:${createHash('sha256').update(contents).digest('hex')}`
  const storageKey = `${companyId}/capture-sessions/${source.capture_session_id}/derived/${safeStorageName(
    source.id,
  )}-transcript.txt`
  await storage.put(storageKey, contents, 'text/plain; charset=utf-8')
  let inserted
  try {
    inserted = await client.query(
      `insert into capture_artifacts (
         company_id, capture_session_id, kind, storage_key, uri, content_type,
         byte_size, content_hash, duration_ms, pii_level, access_policy,
         metadata, retention_expires_at, redaction_version
       ) values (
         $1, $2, 'transcript', $3, null, 'text/plain; charset=utf-8',
         $4, $5, null, $6, $7,
         $8::jsonb, $9::timestamptz, 'capture-artifact-analysis-v1'
       )
       returning id`,
      [
        companyId,
        source.capture_session_id,
        storageKey,
        contents.byteLength,
        contentHash,
        normalizedPiiLevel(source.pii_level),
        normalizedAccessPolicy(source.access_policy),
        JSON.stringify({
          source: 'capture_artifact_analysis',
          analyzer: transcript.analyzer,
          derived_from_artifact_id: source.id,
          derived_from_content_hash: source.content_hash,
          transcript_quality: transcript.stats.transcript_quality ?? null,
        }),
        source.retention_expires_at,
      ],
    )
  } catch (error) {
    await storage.deleteObject(storageKey).catch(() => undefined)
    throw error
  }
  const id = inserted.rows?.[0]?.id ?? ''
  const artifact = {
    id,
    kind: 'transcript',
    content_type: 'text/plain; charset=utf-8',
    byte_size: contents.byteLength,
    content_hash: contentHash,
    download_path: `/api/capture-sessions/${source.capture_session_id}/artifacts/${id}/file`,
  }
  return {
    artifact,
    stats: {
      ...transcript.stats,
      derived_artifact_id: id,
      derived_artifact_bytes: contents.byteLength,
      derived_artifact_content_hash: contentHash,
    },
  }
}

function analyzeBytes(row: CaptureArtifactAnalysisRow, bytes: Buffer): ArtifactAnalysis {
  const text = TEXT_DECODER.decode(bytes).trim()
  if (!text) return skippedAnalysis(row, 'artifact contained no text')
  if (looksJson(row)) return analyzeJsonArtifact(row, text)
  const compact = text.replace(/\s+/g, ' ')
  const words = compact ? compact.split(/\s+/).length : 0
  return {
    status: 'attached',
    artifact_kind: row.kind,
    content_type: row.content_type,
    byte_size: row.byte_size,
    summary: `${row.kind} artifact captured ${words} word(s) across ${text.length} character(s).`,
    excerpt: compact.slice(0, 2000),
    stats: {
      characters: text.length,
      words,
      lines: text.split(/\r?\n/).length,
    },
  }
}

function analyzeJsonArtifact(row: CaptureArtifactAnalysisRow, text: string): ArtifactAnalysis {
  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) {
      return {
        status: 'attached',
        artifact_kind: row.kind,
        content_type: row.content_type,
        byte_size: row.byte_size,
        summary: `${row.kind} JSON artifact captured ${parsed.length} item(s).`,
        excerpt: text.slice(0, 2000),
        stats: { json_type: 'array', items: parsed.length },
      }
    }
    if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed as Record<string, unknown>).slice(0, 20)
      return {
        status: 'attached',
        artifact_kind: row.kind,
        content_type: row.content_type,
        byte_size: row.byte_size,
        summary: `${row.kind} JSON artifact captured object keys: ${keys.join(', ') || 'none'}.`,
        excerpt: text.slice(0, 2000),
        stats: { json_type: 'object', keys },
      }
    }
  } catch {
    // Fall through to text analysis; invalid JSON should still be reviewable.
  }
  return analyzeBytes({ ...row, content_type: 'text/plain' }, Buffer.from(text))
}

function analyzeReferenceArtifact(row: CaptureArtifactAnalysisRow): ArtifactAnalysis {
  const excerpt = typeof row.metadata.excerpt === 'string' ? row.metadata.excerpt.replace(/\s+/g, ' ').trim() : ''
  const analysis: ArtifactAnalysis = {
    status: 'attached',
    artifact_kind: row.kind,
    content_type: row.content_type,
    byte_size: row.byte_size,
    summary: `${row.kind} reference artifact registered without local bytes.`,
    analyzer: 'reference-artifact-v1',
    stats: {
      has_uri: Boolean(row.uri),
      reference: row.uri ? safeReferenceUri(row.uri) : null,
      metadata_keys: Object.keys(row.metadata).slice(0, 20),
    },
  }
  if (excerpt) analysis.excerpt = excerpt.slice(0, 2000)
  return analysis
}

function skippedAnalysis(row: CaptureArtifactAnalysisRow, reason: string): ArtifactAnalysis {
  return {
    status: 'skipped',
    artifact_kind: row.kind,
    content_type: row.content_type,
    byte_size: row.byte_size,
    summary: `Capture artifact was not analyzed: ${reason}.`,
    reason,
  }
}

function looksJson(row: CaptureArtifactAnalysisRow): boolean {
  return row.content_type === 'application/json' || row.kind === 'rrweb' || row.kind === 'canvas_geometry'
}

function isAudioArtifact(row: CaptureArtifactAnalysisRow): boolean {
  return row.kind === 'audio' || Boolean(row.content_type?.startsWith('audio/'))
}

function isVideoArtifact(row: CaptureArtifactAnalysisRow): boolean {
  return row.kind === 'video' || Boolean(row.content_type?.startsWith('video/'))
}

function storageKeyInCompany(companyId: string, storageKey: string): boolean {
  return storageKey === companyId || storageKey.startsWith(`${companyId}/`)
}

function safeReferenceUri(uri: string): Record<string, unknown> {
  try {
    const parsed = new URL(uri)
    return {
      scheme: parsed.protocol.replace(/:$/, ''),
      host: parsed.host || null,
      uri: parsed.protocol === 'scenario:' ? uri : undefined,
    }
  } catch {
    return { scheme: 'unknown', host: null }
  }
}

function safeStorageName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'artifact'
}

function normalizedPiiLevel(value: string): string {
  return ['low', 'internal', 'private', 'restricted'].includes(value) ? value : 'private'
}

function normalizedAccessPolicy(value: string): string {
  return ['support_only', 'operator_only', 'tenant_visible'].includes(value) ? value : 'support_only'
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function readMode<const T extends readonly string[]>(name: string, allowed: T, fallback: T[number]): T[number] {
  const raw = process.env[name]?.trim().toLowerCase()
  return raw && allowed.includes(raw as T[number]) ? (raw as T[number]) : fallback
}

type LocalWhisperResponse = {
  text?: string
  language?: string
  language_probability?: number
  duration?: number
  transcription_time?: number
  transcript_quality?: string
  segments?: unknown[]
}

async function transcribeWithLocalWhisper(
  row: CaptureArtifactAnalysisRow,
  bytes: Buffer,
): Promise<Required<Pick<LocalWhisperResponse, 'text'>> & LocalWhisperResponse> {
  const baseUrl = (process.env.CAPTURE_ARTIFACT_WHISPER_URL ?? 'http://127.0.0.1:5678').replace(/\/$/, '')
  const timeoutMs = readPositiveInt('CAPTURE_ARTIFACT_WHISPER_TIMEOUT_MS', 10_000)
  const payloadMode = readMode('CAPTURE_ARTIFACT_WHISPER_PAYLOAD_MODE', WHISPER_PAYLOAD_MODES, 'base64')
  const filename = `artifact-${row.id}${extensionForAudio(row)}`
  let tmpDir: string | undefined
  try {
    const request =
      payloadMode === 'path'
        ? await (async () => {
            tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sitelayer-capture-audio-'))
            const audioPath = path.join(tmpDir, filename)
            await writeFile(audioPath, bytes)
            return { path: audioPath }
          })()
        : {
            audio_base64: bytes.toString('base64'),
            filename,
            content_type: row.content_type,
          }
    const response = await fetch(`${baseUrl}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await response.json().catch(() => ({}))) as LocalWhisperResponse & { error?: string }
    if (!response.ok) {
      throw new Error(body.error ?? `local whisper failed (${response.status})`)
    }
    return { ...body, text: typeof body.text === 'string' ? body.text : '' }
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

function extensionForAudio(row: CaptureArtifactAnalysisRow): string {
  const contentType = row.content_type?.toLowerCase() ?? ''
  if (contentType.includes('webm')) return '.webm'
  if (contentType.includes('ogg')) return '.ogg'
  if (contentType.includes('mpeg')) return '.mp3'
  if (contentType.includes('mp4') || contentType.includes('m4a')) return '.m4a'
  if (contentType.includes('wav')) return '.wav'
  return '.bin'
}

async function extractVideoFramesWithFfmpeg(input: {
  row: CaptureArtifactAnalysisRow
  bytes: Buffer
  frameCount: number
}): Promise<VideoFrameExtraction> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sitelayer-capture-video-'))
  const videoPath = path.join(tmpDir, `artifact-${input.row.id}${extensionForVideo(input.row)}`)
  try {
    await writeFile(videoPath, input.bytes)
    const durationSeconds = await probeVideoDuration(videoPath).catch(() => null)
    const times = frameTimes(durationSeconds, input.frameCount)
    const frames: VideoFrame[] = []
    for (const [index, time] of times.entries()) {
      const framePath = path.join(tmpDir, `frame-${String(index + 1).padStart(2, '0')}.jpg`)
      try {
        await execFilePromise('ffmpeg', [
          '-hide_banner',
          '-loglevel',
          'error',
          '-ss',
          String(Math.max(0, time)),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          'scale=1280:-2:force_original_aspect_ratio=decrease',
          '-q:v',
          '3',
          '-y',
          framePath,
        ])
        const bytes = await readFile(framePath)
        if (bytes.byteLength > 0) {
          frames.push({
            index: index + 1,
            time_seconds: time,
            content_type: 'image/jpeg',
            bytes,
          })
        }
      } catch {
        // A single bad timestamp should not fail the whole artifact if other
        // frames can be extracted.
      }
    }
    return {
      analyzer: 'ffmpeg-frames-v1',
      duration_seconds: durationSeconds,
      frames,
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function probeVideoDuration(videoPath: string): Promise<number | null> {
  const { stdout } = await execFilePromise('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ])
  const parsed = Number(stdout.trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function frameTimes(durationSeconds: number | null, frameCount: number): number[] {
  const count = Math.max(1, frameCount)
  if (!durationSeconds || durationSeconds <= 0.25) return [0]
  if (count === 1) return [Math.max(0, durationSeconds / 2)]
  const start = Math.min(0.5, durationSeconds * 0.1)
  const end = Math.max(start, durationSeconds * 0.9)
  const step = (end - start) / (count - 1)
  return Array.from({ length: count }, (_, index) => Number((start + step * index).toFixed(3)))
}

function extensionForVideo(row: CaptureArtifactAnalysisRow): string {
  const contentType = row.content_type?.toLowerCase() ?? ''
  if (contentType.includes('webm')) return '.webm'
  if (contentType.includes('quicktime')) return '.mov'
  if (contentType.includes('mp4')) return '.mp4'
  if (contentType.includes('matroska')) return '.mkv'
  return '.bin'
}

function execFilePromise(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}
