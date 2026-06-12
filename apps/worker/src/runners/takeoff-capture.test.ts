import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import {
  BlueprintVisionProviderError,
  type LiveBlueprintCaptureOutcome,
  type RunLiveBlueprintCaptureArgs,
} from '@sitelayer/pipe-blueprint'
import { createTakeoffCaptureRunner, priceFromUsage, type TakeoffCapturePayload } from './takeoff-capture.js'
import type { ObjectStorageClient } from './blueprint-storage-gc.js'

// Unit tests for the async AI blueprint-capture runner. Same fake-pg surface
// as estimate-share-email.test.ts: the runner is a drainAgentMutations
// wrapper, so the SQL shapes are begin/commit, the claim UPDATE … RETURNING
// id, payload, the draft guard SELECT … FOR UPDATE, the draft transition
// UPDATE, the company_usage_log INSERT, and the per-row applied/parked acks.
//
// Honesty contract under test:
//   - SUCCESS writes result + provenance + REAL token usage to the draft and
//     prices the usage-log row from actual tokens.
//   - PROVIDER ERROR marks the draft 'failed' with the error surfaced and
//     writes ZERO quantity rows — no DEMO/stub fallback anywhere.

const testLogger = createLogger('takeoff-capture-runner-test', { level: 'silent' })

type FakeRow = QueryResultRow

interface FakeCall {
  sql: string
  params: ReadonlyArray<unknown>
}

type Responder = (sql: string, params: ReadonlyArray<unknown>) => Partial<QueryResult<FakeRow>> | Error | undefined

function buildResponse(r: Partial<QueryResult<FakeRow>>): QueryResult<FakeRow> {
  return {
    rows: r.rows ?? [],
    rowCount: r.rowCount ?? r.rows?.length ?? 0,
    command: r.command ?? '',
    oid: r.oid ?? 0,
    fields: r.fields ?? [],
  }
}

function makePool(responder: Responder): { pool: Pool; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const query = vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
    calls.push({ sql, params: params ?? [] })
    const r = responder(sql, params ?? [])
    if (r instanceof Error) throw r
    return buildResponse(r ?? {})
  })
  function makeClient(): PoolClient {
    const client: Partial<PoolClient> = {
      query: query as unknown as PoolClient['query'],
      release: vi.fn() as unknown as PoolClient['release'],
    }
    return client as PoolClient
  }
  const pool: Partial<Pool> = {
    query: query as unknown as Pool['query'],
    connect: vi.fn(async () => makeClient()) as unknown as Pool['connect'],
  }
  return { pool: pool as Pool, calls }
}

const COMPANY_ID = 'company-1'
const DRAFT_ID = 'draft-1'

const PAYLOAD: TakeoffCapturePayload = {
  draft_id: DRAFT_ID,
  project_id: 'project-1',
  kind: 'blueprint_vision',
  provider: 'gemini',
  payload: {},
  storage_path: 'company-1/bp-1/blueprint.pdf',
  mime_type: 'application/pdf',
}

function claimResponder(opts: {
  payload?: TakeoffCapturePayload
  draft?: FakeRow | null
  claimedOnce?: { done: boolean }
}): Responder {
  const claimed = opts.claimedOnce ?? { done: false }
  return (sql) => {
    if (sql.includes('update mutation_outbox') && sql.includes('returning id, payload')) {
      if (claimed.done) return { rows: [] }
      claimed.done = true
      return { rows: [{ id: 'outbox-1', payload: opts.payload ?? PAYLOAD }] }
    }
    if (sql.includes('from takeoff_drafts') && sql.includes('for update')) {
      const draft =
        opts.draft === null ? null : (opts.draft ?? { id: DRAFT_ID, capture_status: 'processing', deleted_at: null })
      return { rows: draft ? [draft] : [] }
    }
    return { rows: [] }
  }
}

const FAKE_STORAGE: ObjectStorageClient = {
  put: vi.fn(async () => undefined),
  get: vi.fn(async () => Buffer.from('%PDF-1.4 fake')),
  deleteObject: vi.fn(async () => undefined),
}

const SUCCESS_OUTCOME: LiveBlueprintCaptureOutcome = {
  result: {
    schemaVersion: '1.0.0',
    takeoffId: 'tk-1',
    projectId: 'project-1',
    capturedAt: '2026-06-12T00:00:00.000Z',
    producedAt: '2026-06-12T00:00:01.000Z',
    source: 'blueprint.vision',
    pipelineVersion: '0.1.0',
    units: 'imperial',
    quantities: [
      {
        id: 'q_1',
        description: 'Exterior wall EPS',
        masterformatCode: '07 24 00',
        unit: 'sqft',
        value: 4200,
        confidence: 0.92,
        provenance: { kind: 'blueprint' },
      },
    ],
  } as unknown as LiveBlueprintCaptureOutcome['result'],
  pipelineVersion: '0.1.0',
  provenance: 'gemini-live',
  usage: { provider: 'gemini', model: 'gemini-3.1-flash-lite', input_tokens: 1234, output_tokens: 88 },
}

describe('priceFromUsage', () => {
  it('prices real token usage against the model pricing snapshot', () => {
    const usd = priceFromUsage({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    })
    // 0.25 input + 1.5 output per million.
    expect(usd).toBe(1.75)
  })

  it('returns null (not a made-up number) for unknown models or absent usage', () => {
    expect(
      priceFromUsage({ provider: 'gemini', model: 'gemini-99-future', input_tokens: 10, output_tokens: 10 }),
    ).toBeNull()
    expect(
      priceFromUsage({ provider: 'gemini', model: 'gemini-3.1-flash-lite', input_tokens: null, output_tokens: null }),
    ).toBeNull()
  })
})

describe('takeoff_capture_pipeline runner', () => {
  it('success: writes result + provenance + real usage onto the draft and logs real cost', async () => {
    const { pool, calls } = makePool(claimResponder({}))
    const runCapture = vi.fn(async (_args: RunLiveBlueprintCaptureArgs) => SUCCESS_OUTCOME)
    const runner = createTakeoffCaptureRunner({ pool, storage: FAKE_STORAGE, logger: testLogger, runCapture })

    const summary = await runner(COMPANY_ID)
    expect(summary).toEqual({ processed: 1, insightsCreated: 1, failed: 0 })
    expect(runCapture).toHaveBeenCalledOnce()
    expect(runCapture.mock.calls[0]![0]).toMatchObject({
      provider: 'gemini',
      projectId: 'project-1',
      storagePath: PAYLOAD.storage_path,
    })

    const draftUpdate = calls.find(
      (c) => c.sql.includes('update takeoff_drafts') && c.sql.includes("capture_status = 'ready'"),
    )
    expect(draftUpdate, 'expected the ready transition UPDATE').toBeTruthy()
    const [cid, draftId, resultJson, reviewRequired, pipelineVersion, provenance, usageJson] = draftUpdate!.params
    expect(cid).toBe(COMPANY_ID)
    expect(draftId).toBe(DRAFT_ID)
    expect(JSON.parse(resultJson as string).quantities).toHaveLength(1)
    expect(reviewRequired).toBe(false)
    expect(pipelineVersion).toBe('0.1.0')
    expect(provenance).toBe('gemini-live')
    expect(JSON.parse(usageJson as string)).toEqual({
      provider: 'gemini',
      model: 'gemini-3.1-flash-lite',
      input_tokens: 1234,
      output_tokens: 88,
    })

    const costInsert = calls.find((c) => c.sql.includes('insert into company_usage_log'))
    expect(costInsert, 'expected a usage-log insert priced from real tokens').toBeTruthy()
    const metadata = JSON.parse(costInsert!.params[4] as string) as Record<string, unknown>
    expect(metadata.estimation).toBe('provider_usage')
    expect(metadata.input_tokens).toBe(1234)
    expect(metadata.output_tokens).toBe(88)
    // No flat per-page fiction anywhere.
    expect(metadata.per_page_usd).toBeUndefined()

    const applied = calls.find((c) => c.sql.includes("status = 'applied'"))
    expect(applied, 'outbox row should complete').toBeTruthy()
  })

  it('provider error: marks the draft failed with the error surfaced and writes NO stub rows', async () => {
    const { pool, calls } = makePool(claimResponder({}))
    const runCapture = vi.fn(async () => {
      throw new BlueprintVisionProviderError('gemini', 'gemini gemini-3.1-flash-lite returned HTTP 429: quota')
    })
    const runner = createTakeoffCaptureRunner({ pool, storage: FAKE_STORAGE, logger: testLogger, runCapture })

    const summary = await runner(COMPANY_ID)
    // The row completes (applied) — failure is recorded on the DRAFT, loudly.
    expect(summary.processed).toBe(1)
    expect(summary.failed).toBe(0)

    const failUpdate = calls.find((c) => c.sql.includes("capture_status = 'failed'"))
    expect(failUpdate, 'expected the failed transition UPDATE').toBeTruthy()
    expect(String(failUpdate!.params[2])).toMatch(/HTTP 429/)

    // ZERO fabricated quantities: no result write, no cost log.
    expect(calls.some((c) => c.sql.includes('takeoff_result_json ='))).toBe(false)
    expect(calls.some((c) => c.sql.includes('insert into company_usage_log'))).toBe(false)
  })

  it('skips a draft that is already ready (idempotent replay, never re-billed)', async () => {
    const { pool, calls } = makePool(
      claimResponder({ draft: { id: DRAFT_ID, capture_status: 'ready', deleted_at: null } }),
    )
    const runCapture = vi.fn(async () => SUCCESS_OUTCOME)
    const runner = createTakeoffCaptureRunner({ pool, storage: FAKE_STORAGE, logger: testLogger, runCapture })

    const summary = await runner(COMPANY_ID)
    expect(summary.processed).toBe(1)
    expect(runCapture).not.toHaveBeenCalled()
    expect(calls.some((c) => c.sql.includes('update takeoff_drafts'))).toBe(false)
  })

  it('marks the draft failed when object storage is not configured', async () => {
    const { pool, calls } = makePool(claimResponder({}))
    const runCapture = vi.fn(async () => SUCCESS_OUTCOME)
    const runner = createTakeoffCaptureRunner({ pool, storage: null, logger: testLogger, runCapture })

    await runner(COMPANY_ID)
    expect(runCapture).not.toHaveBeenCalled()
    const failUpdate = calls.find((c) => c.sql.includes("capture_status = 'failed'"))
    expect(failUpdate).toBeTruthy()
    expect(String(failUpdate!.params[2])).toMatch(/object-storage backend not configured/)
  })
})
