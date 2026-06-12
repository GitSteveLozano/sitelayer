import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import type { EmailMessage } from '../email.js'
import {
  createEstimateShareEmailRunner,
  renderEstimateShareEmail,
  resolvePortalBaseUrl,
  type EstimateShareEmailPayload,
} from './estimate-share-email.js'

// Unit tests for the send_estimate_share runner. Same fake-pg surface as
// welcome-email.test.ts: the runner is a drainAgentMutations wrapper, so the
// SQL shapes are `begin`/`commit`, the claim UPDATE … RETURNING id, payload,
// the share guard SELECT, and the per-row applied/parked acks.

const testLogger = createLogger('estimate-share-email-runner-test', { level: 'silent' })

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

const PAYLOAD: EstimateShareEmailPayload = {
  estimate_share_link_id: 'share-1',
  project_id: 'project-1',
  recipient_email: 'client@example.com',
  recipient_name: 'Pat Client',
  message: 'Here is the scaffold estimate we discussed.',
  include_signed_link: true,
  share_url_path: '/portal/estimates/tok123',
}

const LIVE_SHARE = {
  id: 'share-1',
  revoked_at: null,
  expires_at: '2026-12-31T00:00:00.000Z',
  expired: false,
  project_name: 'Main St Scaffold',
  company_name: 'LA Operations',
}

function claimResponder(opts: {
  payload?: EstimateShareEmailPayload
  share?: FakeRow | null
  claimedOnce?: { done: boolean }
}): Responder {
  const claimed = opts.claimedOnce ?? { done: false }
  return (sql) => {
    if (sql.includes('update mutation_outbox') && sql.includes('returning id, payload')) {
      if (claimed.done) return { rows: [] }
      claimed.done = true
      return { rows: [{ id: 'outbox-1', payload: opts.payload ?? PAYLOAD }] }
    }
    if (sql.includes('from estimate_share_links')) {
      return { rows: opts.share === null ? [] : [opts.share ?? LIVE_SHARE] }
    }
    return { rows: [] }
  }
}

describe('renderEstimateShareEmail', () => {
  it('renders subject, link, note, and expiry', () => {
    const out = renderEstimateShareEmail({
      recipientName: 'Pat',
      companyName: 'LA Operations',
      projectName: 'Main St Scaffold',
      message: 'A note from the estimator.',
      shareUrl: 'https://sitelayer.sandolab.xyz/portal/estimates/tok123',
      expiresAt: '2026-12-31T00:00:00.000Z',
    })
    expect(out.subject).toBe('LA Operations sent you an estimate for Main St Scaffold')
    expect(out.text).toContain('Hi Pat,')
    expect(out.text).toContain('A note from the estimator.')
    expect(out.text).toContain('https://sitelayer.sandolab.xyz/portal/estimates/tok123')
    expect(out.text).toContain('expires on')
    expect(out.html).toContain('href="https://sitelayer.sandolab.xyz/portal/estimates/tok123"')
  })

  it('escapes HTML in user-supplied fields', () => {
    const out = renderEstimateShareEmail({
      recipientName: '<script>',
      companyName: '<b>Co</b>',
      projectName: null,
      message: '<img src=x>',
      shareUrl: 'https://example.com/portal/estimates/t',
      expiresAt: null,
    })
    expect(out.html).not.toContain('<script>')
    expect(out.html).not.toContain('<img')
    expect(out.html).toContain('&lt;script&gt;')
  })

  it('falls back gracefully when names are missing', () => {
    const out = renderEstimateShareEmail({
      recipientName: null,
      companyName: '',
      projectName: null,
      message: null,
      shareUrl: 'https://example.com/p',
      expiresAt: null,
    })
    expect(out.text).toContain('Hi there,')
    expect(out.subject).toBe('Your contractor sent you an estimate')
  })
})

describe('resolvePortalBaseUrl', () => {
  it('uses APP_PUBLIC_URL when set, trimming a trailing slash', () => {
    expect(resolvePortalBaseUrl({ APP_PUBLIC_URL: 'https://demo.example.com/' } as NodeJS.ProcessEnv)).toBe(
      'https://demo.example.com',
    )
  })
  it('falls back to the production URL (same default as apps/api server.ts)', () => {
    expect(resolvePortalBaseUrl({} as NodeJS.ProcessEnv)).toBe('https://sitelayer.sandolab.xyz')
  })
})

describe('createEstimateShareEmailRunner', () => {
  it('sends the share email and marks the row applied', async () => {
    const { pool, calls } = makePool(claimResponder({}))
    const sendEmail = vi.fn(async (_msg: EmailMessage) => ({ ok: true as const, provider: 'console' as const }))
    const runner = createEstimateShareEmailRunner({
      pool,
      logger: testLogger,
      sendEmail,
      portalBaseUrl: 'https://app.example.com',
    })
    const summary = await runner('company-1')
    expect(summary).toEqual({ processed: 1, insightsCreated: 0, failed: 0 })
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const msg = sendEmail.mock.calls[0]![0]
    expect(msg.to).toBe('client@example.com')
    expect(msg.subject).toBe('LA Operations sent you an estimate for Main St Scaffold')
    expect(msg.text).toContain('https://app.example.com/portal/estimates/tok123')
    expect(msg.text).toContain('Here is the scaffold estimate we discussed.')
    // Row acked as applied.
    const applied = calls.find((c) => c.sql.includes("status = 'applied'"))
    expect(applied).toBeDefined()
  })

  it('skips (applies without sending) when the share has been revoked', async () => {
    const { pool, calls } = makePool(
      claimResponder({ share: { ...LIVE_SHARE, revoked_at: '2026-06-01T00:00:00.000Z' } }),
    )
    const sendEmail = vi.fn(async () => ({ ok: true as const, provider: 'console' as const }))
    const runner = createEstimateShareEmailRunner({ pool, logger: testLogger, sendEmail })
    const summary = await runner('company-1')
    expect(summary.processed).toBe(1)
    expect(summary.failed).toBe(0)
    expect(sendEmail).not.toHaveBeenCalled()
    expect(calls.some((c) => c.sql.includes("status = 'applied'"))).toBe(true)
  })

  it('skips when the share has expired', async () => {
    const { pool } = makePool(claimResponder({ share: { ...LIVE_SHARE, expired: true } }))
    const sendEmail = vi.fn(async () => ({ ok: true as const, provider: 'console' as const }))
    const runner = createEstimateShareEmailRunner({ pool, logger: testLogger, sendEmail })
    const summary = await runner('company-1')
    expect(summary.failed).toBe(0)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('fails the row (standard retry/park path) when the share row is missing', async () => {
    const { pool, calls } = makePool(claimResponder({ share: null }))
    const sendEmail = vi.fn(async () => ({ ok: true as const, provider: 'console' as const }))
    const runner = createEstimateShareEmailRunner({ pool, logger: testLogger, sendEmail })
    const summary = await runner('company-1')
    expect(summary.failed).toBe(1)
    expect(sendEmail).not.toHaveBeenCalled()
    // drainAgentMutations reschedules/parks via the case-when update.
    expect(calls.some((c) => c.sql.includes("when attempt_count >= 5 then 'failed'"))).toBe(true)
  })

  it('fails the row when the payload is malformed (missing recipient)', async () => {
    const { pool } = makePool(claimResponder({ payload: { ...PAYLOAD, recipient_email: 'not-an-email' } }))
    const sendEmail = vi.fn(async () => ({ ok: true as const, provider: 'console' as const }))
    const runner = createEstimateShareEmailRunner({ pool, logger: testLogger, sendEmail })
    const summary = await runner('company-1')
    expect(summary.failed).toBe(1)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('fails the row when the provider send throws (transient — retried by backoff)', async () => {
    const { pool } = makePool(claimResponder({}))
    const sendEmail = vi.fn(async () => {
      throw new Error('resend http 503')
    })
    const runner = createEstimateShareEmailRunner({ pool, logger: testLogger, sendEmail })
    const summary = await runner('company-1')
    expect(summary).toEqual({ processed: 1, insightsCreated: 0, failed: 1 })
  })

  it('claims rows of mutation_type send_estimate_share specifically', async () => {
    const { pool, calls } = makePool(claimResponder({}))
    const sendEmail = vi.fn(async () => ({ ok: true as const, provider: 'console' as const }))
    const runner = createEstimateShareEmailRunner({ pool, logger: testLogger, sendEmail })
    await runner('company-1')
    const claim = calls.find((c) => c.sql.includes('returning id, payload'))
    expect(claim?.params?.[1]).toBe('send_estimate_share')
  })
})
