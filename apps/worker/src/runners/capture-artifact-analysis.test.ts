import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createCaptureArtifactAnalysisRunner } from './capture-artifact-analysis.js'
import type { ObjectStorageClient } from './blueprint-storage-gc.js'

type FakeRow = QueryResultRow
type FakeResponse = Partial<QueryResult<FakeRow>> | Error
type QueryHandler = (sql: string, params?: ReadonlyArray<unknown>) => FakeResponse | undefined

interface FakeCall {
  sql: string
  params: ReadonlyArray<unknown>
}

interface FakeClient extends PoolClient {
  calls: FakeCall[]
  released: boolean
}

function buildResponse(r: Partial<QueryResult<FakeRow>>): QueryResult<FakeRow> {
  return {
    rows: r.rows ?? [],
    rowCount: r.rowCount ?? r.rows?.length ?? 0,
    command: r.command ?? '',
    oid: r.oid ?? 0,
    fields: r.fields ?? [],
  }
}

function makeFakePool(handler: QueryHandler): {
  pool: Pool
  clients: FakeClient[]
} {
  const clients: FakeClient[] = []
  function makeClient(): FakeClient {
    const calls: FakeCall[] = []
    const c: Partial<FakeClient> = {
      calls,
      released: false,
      query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
        calls.push({ sql, params: params ?? [] })
        const res = handler(sql, params ?? [])
        if (res instanceof Error) throw res
        return buildResponse(res ?? {})
      }) as unknown as PoolClient['query'],
    }
    const client = c as FakeClient
    client.release = vi.fn(() => {
      client.released = true
    }) as unknown as PoolClient['release']
    return client
  }
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => {
      const c = makeClient()
      clients.push(c)
      return c
    }) as unknown as Pool['connect'],
  }
  return { pool: pool as Pool, clients }
}

function storage(overrides: Partial<ObjectStorageClient> = {}): ObjectStorageClient {
  return {
    put: vi.fn(async () => {}),
    get: vi.fn(async () => Buffer.from('The user said the verify scale button did nothing.')),
    deleteObject: vi.fn(async () => {}),
    ...overrides,
  }
}

afterEach(() => {
  delete process.env.CAPTURE_ARTIFACT_ANALYSIS_MAX_BYTES
  delete process.env.CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE
  delete process.env.CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE
  delete process.env.CAPTURE_ARTIFACT_WHISPER_URL
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('createCaptureArtifactAnalysisRunner', () => {
  it('returns zero summary and never touches db when storage is missing', async () => {
    const { pool } = makeFakePool(() => ({ rows: [] }))
    const runner = createCaptureArtifactAnalysisRunner({ pool, storage: null })
    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: false, analyzed: 0, skipped: 0, failed: 0 })
  })

  it('attaches a deterministic analysis event for text artifacts', async () => {
    const rows = [
      {
        id: 'artifact-1',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        work_item_id: 'work-1',
        kind: 'transcript',
        storage_key: 'co-1/capture-sessions/session-1/transcript.txt',
        content_type: 'text/plain',
        byte_size: 52,
        content_hash: 'sha256:abc',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {},
        retention_expires_at: null,
      },
    ]
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows, rowCount: rows.length }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const runner = createCaptureArtifactAnalysisRunner({ pool, storage: storage() })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 1, skipped: 0, failed: 0 })

    const insert = clients[0]?.calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    expect(insert).toBeDefined()
    const payload = JSON.parse(insert?.params[2] as string) as Record<string, unknown>
    expect(payload).toMatchObject({
      artifact_id: 'artifact-1',
      artifact_kind: 'transcript',
      download_path: '/api/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/artifact-1/file',
    })
    expect(payload.analysis).toMatchObject({
      status: 'attached',
      artifact_kind: 'transcript',
    })
    expect(JSON.stringify(payload)).not.toContain('storage_key')
    expect(insert?.params[4]).toBe('capture_artifact:analysis:artifact-1')
  })

  it('marks oversized artifacts skipped without downloading bytes', async () => {
    process.env.CAPTURE_ARTIFACT_ANALYSIS_MAX_BYTES = '10'
    const rows = [
      {
        id: 'artifact-1',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        work_item_id: 'work-1',
        kind: 'transcript',
        storage_key: 'co-1/capture-sessions/session-1/transcript.txt',
        content_type: 'text/plain',
        byte_size: 1000,
        content_hash: 'sha256:abc',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {},
        retention_expires_at: null,
      },
    ]
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows, rowCount: rows.length }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const st = storage()
    const runner = createCaptureArtifactAnalysisRunner({ pool, storage: st })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 0, skipped: 1, failed: 0 })

    expect(st.get).not.toHaveBeenCalled()
    const insert = clients[0]?.calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    const payload = JSON.parse(insert?.params[2] as string) as { analysis: Record<string, unknown> }
    expect(payload.analysis).toMatchObject({ status: 'skipped', reason: 'artifact exceeds 10 bytes' })
  })

  it('transcribes audio artifacts through the local whisper adapter when explicitly enabled', async () => {
    process.env.CAPTURE_ARTIFACT_AUDIO_ANALYSIS_MODE = 'local-whisper'
    process.env.CAPTURE_ARTIFACT_WHISPER_URL = 'http://127.0.0.1:5678'
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { path?: string }
      expect(body.path).toContain('artifact-artifact-audio')
      return new Response(
        JSON.stringify({
          text: 'The scale verify button did nothing.',
          language: 'en',
          language_probability: 0.99,
          duration: 2.4,
          transcription_time: 0.5,
          transcript_quality: 'good',
          segments: [{ start: 0, end: 2.4, text: 'The scale verify button did nothing.' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchSpy)
    const rows = [
      {
        id: 'artifact-audio',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        work_item_id: 'work-1',
        kind: 'audio',
        storage_key: 'co-1/capture-sessions/session-1/audio.webm',
        content_type: 'audio/webm',
        byte_size: 128,
        content_hash: 'sha256:audio',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {},
        retention_expires_at: '2026-06-30T12:00:00.000Z',
      },
    ]
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows, rowCount: rows.length }
      if (sql.includes('insert into capture_artifacts')) return { rows: [{ id: 'derived-transcript-1' }], rowCount: 1 }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const storagePut = vi.fn(async () => {})
    const runner = createCaptureArtifactAnalysisRunner({
      pool,
      storage: storage({ put: storagePut, get: vi.fn(async () => Buffer.from('fake webm bytes')) }),
    })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 1, skipped: 0, failed: 0 })

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:5678/transcribe',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(storagePut).toHaveBeenCalledWith(
      'co-1/capture-sessions/00000000-0000-4000-8000-000000000123/derived/artifact-audio-transcript.txt',
      expect.any(Buffer),
      'text/plain; charset=utf-8',
    )
    const derivedInsert = clients[0]?.calls.find((call) => call.sql.includes('insert into capture_artifacts'))
    expect(derivedInsert?.params[5]).toBe('private')
    expect(derivedInsert?.params[6]).toBe('support_only')
    expect(JSON.parse(derivedInsert?.params[7] as string)).toMatchObject({
      source: 'capture_artifact_analysis',
      analyzer: 'local-whisper-v1',
      derived_from_artifact_id: 'artifact-audio',
      transcript_quality: 'good',
    })
    expect(derivedInsert?.params[8]).toBe('2026-06-30T12:00:00.000Z')
    const insert = clients[0]?.calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    const payload = JSON.parse(insert?.params[2] as string) as { analysis: Record<string, unknown> }
    const metadata = JSON.parse(insert?.params[3] as string) as Record<string, unknown>
    expect(payload.analysis).toMatchObject({
      status: 'attached',
      analyzer: 'local-whisper-v1',
      excerpt: 'The scale verify button did nothing.',
      stats: {
        language: 'en',
        transcript_quality: 'good',
        derived_artifact_id: 'derived-transcript-1',
        segments: 1,
      },
      derived_artifact: {
        id: 'derived-transcript-1',
        kind: 'transcript',
        download_path:
          '/api/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/derived-transcript-1/file',
      },
    })
    expect(JSON.stringify(payload.analysis)).not.toContain('storage_key')
    expect(metadata.analyzer).toBe('local-whisper-v1')
  })

  it('records video artifacts as skipped when frames-only mode is enabled before a frame extractor exists', async () => {
    process.env.CAPTURE_ARTIFACT_VIDEO_ANALYSIS_MODE = 'frames-only'
    const rows = [
      {
        id: 'artifact-video',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        work_item_id: 'work-1',
        kind: 'video',
        storage_key: 'co-1/capture-sessions/session-1/screen.webm',
        content_type: 'video/webm',
        byte_size: 128,
        content_hash: 'sha256:video',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {},
        retention_expires_at: null,
      },
    ]
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows, rowCount: rows.length }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const st = storage({ get: vi.fn(async () => Buffer.from('should not download')) })
    const runner = createCaptureArtifactAnalysisRunner({ pool, storage: st })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 0, skipped: 1, failed: 0 })

    expect(st.get).not.toHaveBeenCalled()
    const insert = clients[0]?.calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    const payload = JSON.parse(insert?.params[2] as string) as { analysis: Record<string, unknown> }
    expect(payload.analysis).toMatchObject({
      status: 'skipped',
      reason: 'video analysis mode frames-only is not implemented in the worker yet',
    })
  })
})
