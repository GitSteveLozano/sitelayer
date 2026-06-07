import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  assembleDebugBundle,
  fetchAxiomEnrichment,
  fetchSentryEnrichment,
  fetchSupportPacketContext,
  processAssembleDebugBundle,
  type SupportPacketContext,
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
const PACKET = 'p0000000-0000-0000-0000-000000000001'

// The in-process evidence the support packet pinned at finalize — what the
// local fallback materializes into the bundle with NO external creds.
const packetContext: SupportPacketContext = {
  support_packet_id: PACKET,
  problem: 'Steve clicked finalize and nothing happened',
  route: '/projects/123/takeoff',
  actor_user_id: 'e2e-admin',
  build_sha: 'abc1234',
  server_context: {
    anchors: [{ transition: 'capture.recording -> capture.stopped', replay_divergence: true }],
    timeline: [{ when: '2026-06-06T00:00:00Z', source: 'api', line: 'POST /finalize 500' }],
    request_ids: ['req-1', 'req-2'],
    trace_ids: ['abc123'],
  },
}

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

  it('does NOT call fetch when Sentry + Axiom env are unset, and carries the pinned ids', async () => {
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
    // No packet context supplied → no local server_context / agent_prompt.
    expect(bundle.server_context).toBeNull()
    expect(bundle.agent_prompt).toBeNull()
  })

  it('LOCAL FALLBACK: with NO external creds but a support-packet context, the bundle carries the in-process server_context + agent_prompt', async () => {
    const bundle = await assembleDebugBundle(
      { support_packet_id: PACKET, capture_session_id: SESSION, trace_ids: ['abc123-def'], request_ids: ['req-1'] },
      explodingFetch,
      packetContext,
    )
    // External enrichment is absent (creds unset) — but a real local artifact exists.
    expect(bundle.sentry).toEqual({ status: 'unconfigured' })
    expect(bundle.axiom).toEqual({ status: 'unconfigured' })
    expect(bundle.server_context).not.toBeNull()
    expect(bundle.server_context?.anchors).toHaveLength(1)
    expect(bundle.server_context?.timeline).toHaveLength(1)
    expect(bundle.server_context?.request_ids).toEqual(['req-1', 'req-2'])
    expect(bundle.server_context?.trace_ids).toEqual(['abc123'])
    expect(bundle.agent_prompt).toContain(PACKET)
    expect(bundle.agent_prompt).toContain('1 statechart transition anchor')
    expect(bundle.support_packet_id).toBe(PACKET)
    // Prompt-injection defense: the user-supplied problem rides INSIDE the
    // delimited untrusted block (with the preamble), not as a trusted line.
    const prompt = bundle.agent_prompt ?? ''
    expect(prompt).toContain('<<<UNTRUSTED_CAPTURED_EVIDENCE>>>')
    expect(prompt).toContain('<<<END_UNTRUSTED_CAPTURED_EVIDENCE>>>')
    expect(prompt).toContain('SECURITY NOTICE')
    const open = prompt.indexOf('<<<UNTRUSTED_CAPTURED_EVIDENCE>>>')
    const close = prompt.indexOf('<<<END_UNTRUSTED_CAPTURED_EVIDENCE>>>')
    expect(prompt.slice(open, close)).toContain('Steve clicked finalize and nothing happened')
  })

  it('ENV-PRESENT MERGE: external Sentry/Axiom evidence is merged into the SAME bundle as the in-process context', async () => {
    process.env.SENTRY_ORG = 'org'
    process.env.SENTRY_AUTH_TOKEN = 'tok'
    process.env.AXIOM_TOKEN = 'atok'
    process.env.AXIOM_DATASET = 'ds'
    const fakeFetch = (async (url: string) => {
      if (String(url).includes('axiom')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            tables: [{ fields: [{ name: '_time' }, { name: 'message' }], columns: [['t1'], ['boom']] }],
          }),
        } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ transactions: [{ a: 1 }] }) } as unknown as Response
    }) as unknown as typeof fetch
    const bundle = await assembleDebugBundle(
      { support_packet_id: PACKET, capture_session_id: SESSION, trace_ids: ['abc123-def'], request_ids: ['req-1'] },
      fakeFetch,
      packetContext,
    )
    expect(bundle.sentry.status).toBe('ok')
    expect(bundle.axiom.status).toBe('ok')
    // The local in-process evidence is STILL present alongside the external merge.
    expect(bundle.server_context?.anchors).toHaveLength(1)
    expect(bundle.agent_prompt).toContain(PACKET)
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

describe('fetchSupportPacketContext', () => {
  it('returns null (no query) for an empty/absent support_packet_id', async () => {
    const client = new FakeQueueClient([])
    expect(await fetchSupportPacketContext(client, COMPANY, null)).toBeNull()
    expect(await fetchSupportPacketContext(client, COMPANY, '  ')).toBeNull()
    expect(client.calls).toHaveLength(0)
  })

  it('reads the packet and bounds the server_context slice', async () => {
    const client = new FakeQueueClient([
      {
        rows: [
          {
            id: PACKET,
            problem: 'p',
            route: '/r',
            actor_user_id: 'a',
            build_sha: 's',
            server_context: {
              anchors: [{ a: 1 }],
              timeline: [{ t: 1 }, { t: 2 }],
              request_ids: ['r1', 'r2'],
              trace_ids: ['abc-def'],
              // an unrelated heavy key must be DROPPED from the slice
              domain_snapshot: { huge: true },
            },
          },
        ],
        rowCount: 1,
      },
    ])
    const ctx = await fetchSupportPacketContext(client, COMPANY, PACKET)
    expect(ctx).not.toBeNull()
    expect(ctx?.support_packet_id).toBe(PACKET)
    expect(ctx?.server_context.anchors).toHaveLength(1)
    expect(ctx?.server_context.timeline).toHaveLength(2)
    expect(ctx?.server_context.request_ids).toEqual(['r1', 'r2'])
    expect(ctx?.server_context.trace_ids).toEqual(['abc'])
    expect(ctx?.server_context).not.toHaveProperty('domain_snapshot')
    expect(client.calls[0]?.text).toMatch(/from support_debug_packets/i)
  })

  it('returns null when the packet row is gone', async () => {
    const client = new FakeQueueClient([{ rows: [], rowCount: 0 }])
    expect(await fetchSupportPacketContext(client, COMPANY, PACKET)).toBeNull()
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

  it('LOCAL FALLBACK: claims a row WITH a support_packet_id, reads the packet, writes a bundle artifact (no external creds)', async () => {
    const SENTRY = ['SENTRY_ORG', 'SENTRY_AUTH_TOKEN'] as const
    const AXIOM = ['AXIOM_TOKEN', 'AXIOM_DATASET'] as const
    const saved: Record<string, string | undefined> = {}
    for (const k of [...SENTRY, ...AXIOM]) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
    try {
      const client = new FakeQueueClient([
        { rows: [], rowCount: 0 }, // begin (claim tx)
        {
          rows: [
            {
              id: OUTBOX,
              entity_id: WORK_ITEM,
              payload: { support_packet_id: PACKET, capture_session_id: SESSION },
              attempt_count: 1,
            },
          ],
          rowCount: 1,
        }, // claim
        { rows: [], rowCount: 0 }, // commit (claim tx)
        { rows: [], rowCount: 0 }, // begin (per-row tx)
        {
          rows: [
            {
              id: PACKET,
              problem: 'p',
              route: '/r',
              actor_user_id: 'e2e-admin',
              build_sha: 'sha',
              server_context: { anchors: [{ x: 1 }], timeline: [{ y: 2 }], request_ids: ['req-1'], trace_ids: ['abc'] },
            },
          ],
          rowCount: 1,
        }, // fetchSupportPacketContext
        { rows: [{ id: SESSION, retention_expires_at: null }], rowCount: 1 }, // session exists
        { rows: [{ id: 'artifact-1' }], rowCount: 1 }, // artifact upsert returning id
        { rows: [], rowCount: 0 }, // update outbox applied
        { rows: [], rowCount: 0 }, // commit (per-row tx)
      ])
      const summary = await processAssembleDebugBundle(client, COMPANY, 5, explodingFetch)
      expect(summary).toEqual({ processed: 1, assembled: 1, failed: 0, skipped: 0 })
      const queries = sqlCalls(client)
      // The support packet was read for the local server_context.
      expect(queries.some((q) => /from support_debug_packets/i.test(q))).toBe(true)
      // And a real artifact was written.
      expect(queries.some((q) => /insert into capture_artifacts/i.test(q) && /debug_bundle/.test(q))).toBe(true)
    } finally {
      for (const k of [...SENTRY, ...AXIOM]) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
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
