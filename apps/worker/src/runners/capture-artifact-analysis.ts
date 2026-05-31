import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { Pool } from 'pg'
import { setCompanyGuc } from '../runner-utils.js'
import type { ObjectStorageClient } from './blueprint-storage-gc.js'

export type CaptureArtifactAnalysisSummary = {
  ran: boolean
  analyzed: number
  skipped: number
  failed: number
}

type CaptureArtifactAnalysisRow = {
  id: string
  capture_session_id: string
  work_item_id: string
  kind: string
  storage_key: string
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
}

const ANALYZABLE_KINDS = new Set(['transcript', 'text', 'rrweb', 'canvas_geometry'])
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false })
const AUDIO_ANALYSIS_MODES = ['off', 'local-whisper'] as const
const VIDEO_ANALYSIS_MODES = ['off', 'frames-only'] as const

export function createCaptureArtifactAnalysisRunner(deps: { pool: Pool; storage: ObjectStorageClient | null }) {
  const { pool, storage } = deps
  let lastRunAt = 0

  return {
    async maybeAnalyze(companyId: string): Promise<CaptureArtifactAnalysisSummary> {
      if (!storage) return { ran: false, analyzed: 0, skipped: 0, failed: 0 }
      const intervalMs = readPositiveInt('CAPTURE_ARTIFACT_ANALYSIS_INTERVAL_MS', 60_000)
      const now = Date.now()
      if (now - lastRunAt < intervalMs) return { ran: false, analyzed: 0, skipped: 0, failed: 0 }
      lastRunAt = now
      return analyzeCaptureArtifacts(pool, storage, companyId)
    },
    async forceAnalyze(companyId: string): Promise<CaptureArtifactAnalysisSummary> {
      if (!storage) return { ran: false, analyzed: 0, skipped: 0, failed: 0 }
      return analyzeCaptureArtifacts(pool, storage, companyId)
    },
  }
}

async function analyzeCaptureArtifacts(
  pool: Pool,
  storage: ObjectStorageClient,
  companyId: string,
): Promise<CaptureArtifactAnalysisSummary> {
  const limit = Math.min(readPositiveInt('CAPTURE_ARTIFACT_ANALYSIS_LIMIT', 10), 50)
  const maxBytes = readPositiveInt('CAPTURE_ARTIFACT_ANALYSIS_MAX_BYTES', 1024 * 1024)
  const audioMode = readMode('CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE', AUDIO_ANALYSIS_MODES, 'off')
  const videoMode = readMode('CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE', VIDEO_ANALYSIS_MODES, 'off')
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
          and a.storage_key is not null
          and not (a.metadata ? 'derived_from_artifact_id')
          and (
            a.kind = any($2::text[])
            or a.content_type like 'text/%'
            or a.content_type = 'application/json'
            or ($4::boolean and (a.kind = 'audio' or a.content_type like 'audio/%'))
            or ($5::boolean and (a.kind = 'video' or a.content_type like 'video/%'))
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
      try {
        if (!storageKeyInCompany(companyId, row.storage_key)) {
          await appendAnalysisEvent(client, companyId, row, skippedAnalysis(row, 'storage key outside company scope'))
          summary.skipped += 1
          continue
        }
        if (row.byte_size !== null && row.byte_size > maxBytes) {
          await appendAnalysisEvent(client, companyId, row, skippedAnalysis(row, `artifact exceeds ${maxBytes} bytes`))
          summary.skipped += 1
          continue
        }
        if (isVideoArtifact(row)) {
          await appendAnalysisEvent(
            client,
            companyId,
            row,
            skippedAnalysis(row, `video analysis mode ${videoMode} is not implemented in the worker yet`),
          )
          summary.skipped += 1
          continue
        }
        const bytes = await storage.get(row.storage_key)
        if (bytes.byteLength > maxBytes) {
          await appendAnalysisEvent(client, companyId, row, skippedAnalysis(row, `artifact exceeds ${maxBytes} bytes`))
          summary.skipped += 1
          continue
        }
        const analysis = isAudioArtifact(row)
          ? await analyzeAudioArtifact(client, storage, companyId, row, bytes, audioMode)
          : analyzeBytes(row, bytes)
        await appendAnalysisEvent(client, companyId, row, analysis)
        if (analysis.status === 'skipped') summary.skipped += 1
        else summary.analyzed += 1
      } catch {
        summary.failed += 1
      }
    }
    await client.query('commit')
    return summary
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function appendAnalysisEvent(
  client: { query: (sql: string, params?: ReadonlyArray<unknown>) => Promise<unknown> },
  companyId: string,
  row: CaptureArtifactAnalysisRow,
  analysis: ArtifactAnalysis,
) {
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
      JSON.stringify({
        artifact_id: row.id,
        artifact_kind: row.kind,
        capture_session_id: row.capture_session_id,
        content_type: row.content_type,
        byte_size: row.byte_size,
        content_hash: row.content_hash,
        download_path: `/api/capture-sessions/${row.capture_session_id}/artifacts/${row.id}/file`,
        analysis,
      }),
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
): Promise<ArtifactAnalysis> {
  if (mode !== 'local-whisper') return skippedAnalysis(row, `audio analysis mode ${mode} is disabled`)
  const transcript = await transcribeWithLocalWhisper(row, bytes)
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
  return {
    status: 'attached',
    artifact_kind: row.kind,
    content_type: row.content_type,
    byte_size: row.byte_size,
    summary: `Audio artifact transcribed ${compact.split(/\s+/).length} word(s).`,
    excerpt: compact.slice(0, 2000),
    analyzer: 'local-whisper-v1',
    stats: derived.stats,
    derived_artifact: derived.artifact,
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
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'sitelayer-capture-audio-'))
  const audioPath = path.join(tmpDir, `artifact-${row.id}${extensionForAudio(row)}`)
  try {
    await writeFile(audioPath, bytes)
    const response = await fetch(`${baseUrl}/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: audioPath }),
    })
    const body = (await response.json().catch(() => ({}))) as LocalWhisperResponse & { error?: string }
    if (!response.ok) {
      throw new Error(body.error ?? `local whisper failed (${response.status})`)
    }
    return { ...body, text: typeof body.text === 'string' ? body.text : '' }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
  }
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
