import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  assembleDebugBundle,
  fetchAxiomEnrichment,
  fetchSentryEnrichment,
  processAssembleDebugBundle,
} from './pushers/debug-bundle.js'
import type { QueueClient } from './index.js'

type QueuedResponse<T extends QueryResultRow = QueryResultRow> = Pick<QueryResult<T>, 'rows' | 'rowCount'> | Error

class FakeQueueClient implements QueueClient {
  readonly calls: Array<{ text: string; values?: unknown[] }> = []

  constructor(private readonly responses: QueuedResponse[] = []) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
    this.calls.push(values ? { text, values } : { text })
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return {
      rows: (response?.rows ?? []) as T[],
      rowCount: response?.rowCount ?? 0,
      command: '',
      oid: 0,
      fields: [],
    }
  }
}

function sqlCalls(client: FakeQueueClient) {
  return client.calls.map((c) => c.text.replace(/\s+/g, ' ').trim())
}

const COMPANY = 'c0000000-0000-0000-0000-000000000001'
const WORK_ITEM = 'w0000000-0000-0000-0000-000000000001'
const SESSION = 's0000000-0000-0000-0000-000000000001'
const OUTBOX = 'o0000000-0000-0000-0000-000000000001'

// A fetch that always throws — lets us assert the bundle stays env-gated (the
// fetch is never reached) without making a real network call.
const explodingFetch = (() => {
  throw new Error('fetch should not be called when unconfigured')
}) as unknown as typeof fetch

describe('assembleDebugBundle env-gating', () => {
  const SENTRY = ['SENTRY_ORG', 'SENTRY_AUTH_TOKEN', 'SENTRY_HOST'] as const
  const AXIOM = ['AXIOM_TOKEN', 'AXIOM_DATASET'] as const
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of [...SENTRY, ...AXIOM]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of [...SENTRY, ...AXIOM]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('is a silent no-op when Sentry + Axiom env are unset (never calls fetch)', async () => {
    const bundle = await assembleDebugBundle(
      { capture_session_id: SESSION, trace_ids: ['abc123-def'], request_ids: ['req-1'] },
      explodingFetch,
    )
    expect(bundle.schema).toBe('sitelayer.debug_bundle.v1')
    expect(bundle.sentry).toEqual({ status: 'unconfigured' })
    expect(bundle.axiom).toEqual({ status: 'unconfigured' })
    // The pinned ids are carried through (trace normalized to the short head).
    expect(bundle.trace_ids).toEqual(['abc123'])
    expect(bundle.request_ids).toEqual(['req-1'])
    expect(bundle.capture_session_id).toBe(SESSION)
  })

  it('fetchSentryEnrichment reports no_trace when configured but no trace pinned', async () => {
    process.env.SENTRY_ORG = 'org'
    process.env.SENTRY_AUTH_TOKEN = 'tok'
    const result = await fetchSentryEnrichment([], explodingFetch)
    expect(result).toEqual({ status: 'no_trace' })
  })

  it('fetchAxiomEnrichment reports no_ids when configured but no ids pinned', async () => {
    process.env.AXIOM_TOKEN = 'tok'
    process.env.AXIOM_DATASET = 'ds'
    const result = await fetchAxiomEnrichment([], [], explodingFetch)
    expect(result).toEqual({ status: 'no_ids' })
  })

  it('fetchSentryEnrichment pulls + counts trace nodes when configured', async () => {
    process.env.SENTRY_ORG = 'org'
    process.env.SENTRY_AUTH_TOKEN = 'tok'
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ transactions: [{ a: 1 }, { b: 2 }] }),
      }) as unknown as Response) as unknown as typeof fetch
    const result = await fetchSentryEnrichment(['trace-head'], fakeFetch)
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.trace_id).toBe('trace-head')
      expect(result.node_count).toBe(2)
    }
  })
})

describe('processAssembleDebugBundle', () => {
  it('empty claim → idle summary, only the claim tx ran', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin
      { rows: [], rowCount: 0 }, // claim returns nothing
      { rows: [], rowCount: 0 }, // commit
    ])
    const summary = await processAssembleDebugBundle(client, COMPANY, 5, explodingFetch)
    expect(summary).toEqual({ processed: 0, assembled: 0, failed: 0, skipped: 0 })
    const queries = sqlCalls(client)
    expect(queries[0]).toBe('begin')
    expect(queries[1]).toMatch(/^update mutation_outbox/i)
    expect(queries[1]).toContain("mutation_type = 'assemble_debug_bundle'")
    expect(queries[2]).toBe('commit')
  })

  it('claims a row, writes the debug_bundle artifact, marks the outbox applied', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      {
        rows: [{ id: OUTBOX, entity_id: WORK_ITEM, payload: { capture_session_id: SESSION }, attempt_count: 1 }],
        rowCount: 1,
      }, // claim
      { rows: [], rowCount: 0 }, // commit (claim tx)
      { rows: [], rowCount: 0 }, // begin (per-row tx)
      { rows: [{ id: SESSION, retention_expires_at: null }], rowCount: 1 }, // session exists
      { rows: [{ id: 'artifact-1' }], rowCount: 1 }, // artifact upsert returning id
      { rows: [], rowCount: 0 }, // update outbox applied
      { rows: [], rowCount: 0 }, // commit (per-row tx)
    ])
    const summary = await processAssembleDebugBundle(client, COMPANY, 5, explodingFetch)
    expect(summary).toEqual({ processed: 1, assembled: 1, failed: 0, skipped: 0 })
    const queries = sqlCalls(client)
    expect(queries.some((q) => /insert into capture_artifacts/i.test(q) && /debug_bundle/.test(q))).toBe(true)
    expect(queries.some((q) => /update mutation_outbox set status = 'applied'/i.test(q))).toBe(true)
  })

  it('skips (marks applied) a claimed row with no capture_session_id', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      { rows: [{ id: OUTBOX, entity_id: WORK_ITEM, payload: {}, attempt_count: 1 }], rowCount: 1 }, // claim
      { rows: [], rowCount: 0 }, // commit (claim tx)
      { rows: [], rowCount: 0 }, // begin (per-row tx)
      { rows: [], rowCount: 0 }, // update outbox applied (skip path)
      { rows: [], rowCount: 0 }, // commit (per-row tx)
    ])
    const summary = await processAssembleDebugBundle(client, COMPANY, 5, explodingFetch)
    expect(summary).toEqual({ processed: 1, assembled: 0, failed: 0, skipped: 1 })
    // No artifact insert should have run.
    expect(sqlCalls(client).some((q) => /insert into capture_artifacts/i.test(q))).toBe(false)
  })

  it('skips (marks applied) when the capture session row has vanished', async () => {
    const client = new FakeQueueClient([
      { rows: [], rowCount: 0 }, // begin (claim tx)
      {
        rows: [{ id: OUTBOX, entity_id: WORK_ITEM, payload: { capture_session_id: SESSION }, attempt_count: 1 }],
        rowCount: 1,
      }, // claim
      { rows: [], rowCount: 0 }, // commit (claim tx)
      { rows: [], rowCount: 0 }, // begin (per-row tx)
      { rows: [], rowCount: 0 }, // session lookup returns nothing
      { rows: [], rowCount: 0 }, // update outbox applied (skip path)
      { rows: [], rowCount: 0 }, // commit (per-row tx)
    ])
    const summary = await processAssembleDebugBundle(client, COMPANY, 5, explodingFetch)
    expect(summary).toEqual({ processed: 1, assembled: 0, failed: 0, skipped: 1 })
  })
})
