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
  delete process.env.CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH
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

    const readiness = clients[0]?.calls.find(
      (call) => call.sql.includes('update context_work_items') && call.sql.includes('capture_artifact_analysis'),
    )
    expect(readiness?.params).toEqual([
      'co-1',
      'work-1',
      'off',
      'off',
      ['transcript', 'text', 'rrweb', 'canvas_geometry'],
      false,
      false,
    ])
    expect(readiness?.sql).toContain("'audio_mode', $3::text")
    expect(readiness?.sql).toContain("'video_mode', $4::text")
  })

  it('attaches a reference analysis event for URI-only artifacts without downloading bytes', async () => {
    const rows = [
      {
        id: 'artifact-uri',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        work_item_id: 'work-1',
        kind: 'transcript',
        storage_key: null,
        uri: 'scenario://steve-demo/captures/feedback/transcript.txt',
        content_type: 'text/plain',
        byte_size: 196,
        content_hash: null,
        pii_level: 'internal',
        access_policy: 'support_only',
        metadata: {
          source: 'scenario_transcript',
          excerpt: 'Add target is on the AI takeoff screen, but it does not feed the capture call.',
        },
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

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 1, skipped: 0, failed: 0 })

    expect(st.get).not.toHaveBeenCalled()
    const insert = clients[0]?.calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    const payload = JSON.parse(insert?.params[2] as string) as Record<string, unknown>
    expect(payload).toMatchObject({
      artifact_id: 'artifact-uri',
      artifact_kind: 'transcript',
      reference: {
        scheme: 'scenario',
        host: 'steve-demo',
        uri: 'scenario://steve-demo/captures/feedback/transcript.txt',
      },
    })
    expect(payload).not.toHaveProperty('download_path')
    expect(payload.analysis).toMatchObject({
      status: 'attached',
      analyzer: 'reference-artifact-v1',
      excerpt: 'Add target is on the AI takeoff screen, but it does not feed the capture call.',
      stats: {
        has_uri: true,
        reference: {
          scheme: 'scenario',
          host: 'steve-demo',
          uri: 'scenario://steve-demo/captures/feedback/transcript.txt',
        },
      },
    })
    const readiness = clients[0]?.calls.find(
      (call) => call.sql.includes('update context_work_items') && call.sql.includes('capture_artifact_analysis'),
    )
    expect(readiness?.sql).toContain('a.storage_key is null and a.uri is not null')
  })

  it('rolls back one failed artifact row and continues analyzing the batch', async () => {
    const rows = [
      {
        id: 'artifact-1',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        work_item_id: 'work-1',
        kind: 'transcript',
        storage_key: 'co-1/capture-sessions/session-1/transcript-1.txt',
        content_type: 'text/plain',
        byte_size: 52,
        content_hash: 'sha256:abc',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {},
        retention_expires_at: null,
      },
      {
        id: 'artifact-2',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        work_item_id: 'work-1',
        kind: 'transcript',
        storage_key: 'co-1/capture-sessions/session-1/transcript-2.txt',
        content_type: 'text/plain',
        byte_size: 52,
        content_hash: 'sha256:def',
        pii_level: 'private',
        access_policy: 'support_only',
        metadata: {},
        retention_expires_at: null,
      },
    ]
    let readinessCalls = 0
    const handler: QueryHandler = (sql) => {
      if (sql.includes('update context_work_items')) {
        readinessCalls += 1
        if (readinessCalls === 1) throw new Error('readiness exploded')
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('from capture_artifacts')) return { rows, rowCount: rows.length }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const logger = { warn: vi.fn() }
    const runner = createCaptureArtifactAnalysisRunner({ pool, storage: storage(), logger })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 1, skipped: 0, failed: 1 })

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_artifact_id: 'artifact-1',
        capture_artifact_kind: 'transcript',
      }),
      '[capture-artifact-analysis] artifact analysis failed',
    )
    expect(clients[0]?.calls.some((call) => call.sql === 'rollback to savepoint capture_artifact_analysis_row')).toBe(
      true,
    )
    const inserts = clients[0]?.calls.filter((call) => call.sql.includes('insert into context_handoff_events')) ?? []
    expect(inserts).toHaveLength(2)
  })

  it('queues mesh dispatch after analysis is ready when auto-dispatch is explicitly enabled', async () => {
    process.env.CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH = '1'
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
      if (sql.includes('update context_work_items')) return { rows: [], rowCount: 1 }
      if (sql.includes("metadata -> 'capture_artifact_analysis' ->> 'status' = 'ready'")) {
        if (!sql.includes('id = $2::uuid')) return { rows: [], rowCount: 0 }
        return {
          rows: [
            {
              id: 'work-1',
              support_packet_id: 'packet-1',
              capture_session_id: '00000000-0000-4000-8000-000000000123',
              title: 'Captured takeoff feedback',
              summary: 'Verify Scale did nothing.',
              status: 'new',
              lane: 'both',
              severity: 'normal',
              route: '/desktop/takeoff',
              entity_type: 'takeoff',
              entity_id: 'draft-1',
              created_by_user_id: 'e2e-admin',
              reversibility_window_seconds: 86400,
              metadata: {
                capture_artifact_analysis: {
                  status: 'ready',
                  eligible_artifact_count: 1,
                  processed_artifact_count: 1,
                  pending_artifact_count: 0,
                },
              },
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      if (sql.includes('insert into mutation_outbox')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const runner = createCaptureArtifactAnalysisRunner({ pool, storage: storage() })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 1, skipped: 0, failed: 0 })

    const outbox = clients[0]?.calls.find((call) => call.sql.includes('insert into mutation_outbox'))
    expect(outbox?.params[4]).toBe('context_work_item:dispatch_mesh:work-1')
    const payload = JSON.parse(String(outbox?.params[3])) as Record<string, unknown>
    expect(payload).toMatchObject({
      work_item_id: 'work-1',
      capture_session_id: '00000000-0000-4000-8000-000000000123',
      lane: 'both',
      work_request_brief: {
        schema: 'sitelayer.capture_analysis_ready.v1',
        capture_session_id: '00000000-0000-4000-8000-000000000123',
        capture_artifact_analysis: {
          status: 'ready',
          eligible_artifact_count: 1,
          processed_artifact_count: 1,
          pending_artifact_count: 0,
        },
        callback: {
          path: '/api/work-requests/work-1/agent-callback',
          token_type: 'scoped_bearer',
        },
        capture_export: {
          command: 'npm run capture:export',
          args: ['--', '--include-artifact-files'],
          env: {
            CAPTURE_SESSION_ID: '00000000-0000-4000-8000-000000000123',
          },
        },
      },
    })
    expect(payload.callback).toMatchObject({
      path: '/api/work-requests/work-1/agent-callback',
      token_type: 'scoped_bearer',
    })
    expect(typeof (payload.callback as Record<string, unknown>).token).toBe('string')
    expect(payload.agent_brief_markdown).toContain('Capture artifact analysis is ready')
    expect(payload.agent_brief_markdown).toContain(
      'CAPTURE_SESSION_ID=00000000-0000-4000-8000-000000000123 npm run capture:export -- --include-artifact-files',
    )
    const tokenHash = clients[0]?.calls.find((call) => call.sql.includes('agent_callback_token_hash'))
    expect(tokenHash?.params[2]).toMatch(/^[a-f0-9]{64}$/)
    const queued = clients[0]?.calls.find((call) => call.sql.includes("'agent.dispatch_queued'"))
    expect(queued?.params[4]).toBe('capture_artifact_analysis:dispatch_queued:work-1')
  })

  it('queues mesh dispatch for already-ready analysis when auto-dispatch is enabled later', async () => {
    process.env.CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH = '1'
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows: [], rowCount: 0 }
      if (sql.includes("metadata -> 'capture_artifact_analysis' ->> 'status' = 'ready'")) {
        return {
          rows: [
            {
              id: 'work-ready',
              support_packet_id: 'packet-ready',
              capture_session_id: '00000000-0000-4000-8000-000000000456',
              title: 'Captured portal feedback',
              summary: 'The user could not find the submit button.',
              status: 'triaged',
              lane: 'agent',
              severity: 'normal',
              route: '/portal/estimates/share-1',
              entity_type: 'estimate_share',
              entity_id: 'share-1',
              created_by_user_id: 'e2e-admin',
              reversibility_window_seconds: 86400,
              metadata: {
                capture_artifact_analysis: {
                  status: 'ready',
                  eligible_artifact_count: 2,
                  processed_artifact_count: 2,
                  pending_artifact_count: 0,
                },
              },
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      if (sql.includes('insert into mutation_outbox')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const runner = createCaptureArtifactAnalysisRunner({ pool, storage: storage() })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 0, skipped: 0, failed: 0 })

    const outbox = clients[0]?.calls.find((call) => call.sql.includes('insert into mutation_outbox'))
    expect(outbox?.params[4]).toBe('context_work_item:dispatch_mesh:work-ready')
    const payload = JSON.parse(String(outbox?.params[3])) as Record<string, unknown>
    expect(payload).toMatchObject({
      work_item_id: 'work-ready',
      capture_session_id: '00000000-0000-4000-8000-000000000456',
      lane: 'agent',
      work_request_brief: {
        schema: 'sitelayer.capture_analysis_ready.v1',
        capture_session_id: '00000000-0000-4000-8000-000000000456',
        callback: {
          path: '/api/work-requests/work-ready/agent-callback',
          token_type: 'scoped_bearer',
        },
        capture_export: {
          command: 'npm run capture:export',
          args: ['--', '--include-artifact-files'],
          env: {
            CAPTURE_SESSION_ID: '00000000-0000-4000-8000-000000000456',
          },
        },
      },
    })
    expect(payload.callback).toMatchObject({
      path: '/api/work-requests/work-ready/agent-callback',
      token_type: 'scoped_bearer',
    })
    expect(typeof (payload.callback as Record<string, unknown>).token).toBe('string')
    const tokenHash = clients[0]?.calls.find((call) => call.sql.includes('agent_callback_token_hash'))
    expect(tokenHash?.params[2]).toMatch(/^[a-f0-9]{64}$/)
    const queued = clients[0]?.calls.find((call) => call.sql.includes("'agent.dispatch_queued'"))
    expect(queued?.params[4]).toBe('capture_artifact_analysis:dispatch_queued:work-ready')
  })

  it('refreshes zero-eligible finalized sessions so audio-only captures do not stall when audio analysis is off', async () => {
    process.env.CAPTURE_ARTIFACT_ANALYSIS_AUTO_DISPATCH = '1'
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows: [], rowCount: 0 }
      if (sql.includes("metadata ->> 'source' = 'capture_session_finalize'")) {
        return { rows: [{ id: 'work-audio-only' }], rowCount: 1 }
      }
      if (sql.includes('update context_work_items') && sql.includes('capture_artifact_analysis')) {
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes("metadata -> 'capture_artifact_analysis' ->> 'status' = 'ready'")) {
        return {
          rows: [
            {
              id: 'work-audio-only',
              support_packet_id: 'packet-audio-only',
              capture_session_id: '00000000-0000-4000-8000-000000000789',
              title: 'Captured audio feedback',
              summary: 'The user described a hidden edge case.',
              status: 'new',
              lane: 'both',
              severity: 'normal',
              route: '/desktop/projects/p1',
              entity_type: 'project',
              entity_id: 'p1',
              created_by_user_id: 'e2e-admin',
              reversibility_window_seconds: 86400,
              metadata: {
                capture_artifact_analysis: {
                  status: 'ready',
                  eligible_artifact_count: 0,
                  processed_artifact_count: 0,
                  pending_artifact_count: 0,
                  audio_mode: 'off',
                },
              },
            },
          ],
          rowCount: 1,
        }
      }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      if (sql.includes('insert into mutation_outbox')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const runner = createCaptureArtifactAnalysisRunner({ pool, storage: storage() })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 0, skipped: 0, failed: 0 })

    const readiness = clients[0]?.calls.find(
      (call) => call.sql.includes('update context_work_items') && call.sql.includes('capture_artifact_analysis'),
    )
    expect(readiness?.params).toEqual([
      'co-1',
      'work-audio-only',
      'off',
      'off',
      ['transcript', 'text', 'rrweb', 'canvas_geometry'],
      false,
      false,
    ])
    const outbox = clients[0]?.calls.find((call) => call.sql.includes('insert into mutation_outbox'))
    expect(outbox?.params[5]).toBe('00000000-0000-4000-8000-000000000789')
    const payload = JSON.parse(String(outbox?.params[3])) as Record<string, unknown>
    expect(payload).toMatchObject({
      work_item_id: 'work-audio-only',
      capture_session_id: '00000000-0000-4000-8000-000000000789',
    })
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
        download_path: '/api/capture-sessions/00000000-0000-4000-8000-000000000123/artifacts/derived-transcript-1/file',
      },
    })
    expect(JSON.stringify(payload.analysis)).not.toContain('storage_key')
    expect(metadata.analyzer).toBe('local-whisper-v1')
  })

  it('extracts derived frame artifacts when frames-only video mode is enabled', async () => {
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
    let artifactInsert = 0
    const handler: QueryHandler = (sql) => {
      if (sql.includes('from capture_artifacts')) return { rows, rowCount: rows.length }
      if (sql.includes('insert into capture_artifacts')) {
        artifactInsert += 1
        return { rows: [{ id: `derived-video-${artifactInsert}` }], rowCount: 1 }
      }
      if (sql.includes('update context_work_items')) return { rows: [], rowCount: 1 }
      if (sql.includes('insert into context_handoff_events')) return { rows: [], rowCount: 1 }
      return { rows: [] }
    }
    const { pool, clients } = makeFakePool(handler)
    const storagePut = vi.fn(async () => {})
    const st = storage({ get: vi.fn(async () => Buffer.from('fake video bytes')), put: storagePut })
    const runner = createCaptureArtifactAnalysisRunner({
      pool,
      storage: st,
      videoFrameExtractor: vi.fn(async () => ({
        analyzer: 'test-frame-extractor-v1',
        duration_seconds: 4,
        frames: [
          {
            index: 1,
            time_seconds: 0.5,
            content_type: 'image/jpeg',
            bytes: Buffer.from('frame-one'),
            width: 320,
            height: 180,
          },
          {
            index: 2,
            time_seconds: 2.5,
            content_type: 'image/jpeg',
            bytes: Buffer.from('frame-two'),
            width: 320,
            height: 180,
          },
        ],
      })),
    })

    await expect(runner.forceAnalyze('co-1')).resolves.toEqual({ ran: true, analyzed: 1, skipped: 0, failed: 0 })

    expect(st.get).toHaveBeenCalledWith('co-1/capture-sessions/session-1/screen.webm')
    expect(storagePut).toHaveBeenCalledTimes(3)
    expect(storagePut).toHaveBeenNthCalledWith(
      1,
      'co-1/capture-sessions/00000000-0000-4000-8000-000000000123/derived/artifact-video-frame-01.jpg',
      expect.any(Buffer),
      'image/jpeg',
    )
    expect(storagePut).toHaveBeenNthCalledWith(
      3,
      'co-1/capture-sessions/00000000-0000-4000-8000-000000000123/derived/artifact-video-video-frame-manifest.json',
      expect.any(Buffer),
      'application/json; charset=utf-8',
    )
    const insert = clients[0]?.calls.find((call) => call.sql.includes('insert into context_handoff_events'))
    const payload = JSON.parse(insert?.params[2] as string) as { analysis: Record<string, unknown> }
    expect(payload.analysis).toMatchObject({
      status: 'attached',
      analyzer: 'test-frame-extractor-v1',
      derived_artifact: {
        id: 'derived-video-3',
        kind: 'video_frame_manifest',
      },
      stats: {
        duration_seconds: 4,
        extracted_frame_count: 2,
        manifest_artifact_id: 'derived-video-3',
        frame_artifact_ids: ['derived-video-1', 'derived-video-2'],
      },
    })
    expect(payload.analysis.derived_artifacts).toHaveLength(2)
  })
})
