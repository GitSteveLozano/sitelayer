import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Identity } from '../auth.js'
import { handleAdminJobsRoutes, type AdminJobsRouteDeps } from './admin-jobs.js'

const clerkAdmin: Identity = { userId: 'admin-sub', source: 'clerk' }
const ENV_IDS = new Set(['admin-sub'])

const JOB_RUN_ROW = {
  job_name: 'queue-prune',
  scope: 'global',
  last_started_at: '2026-06-03T00:00:00.000Z',
  last_finished_at: '2026-06-03T00:00:01.000Z',
  last_status: 'ok',
  last_error: '',
  last_duration_ms: 1000,
  // bigint columns arrive from pg as strings — assert we normalize them to numbers.
  run_count: '42',
  success_count: '40',
  failure_count: '2',
  skipped_count: '0',
  next_eligible_at: '2026-06-03T00:05:00.000Z',
  updated_at: '2026-06-03T00:00:01.000Z',
}

class FakePool {
  queries: string[] = []
  async query(text: string, _values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push(text)
    if (/from job_runs/i.test(text)) {
      return { rows: [JOB_RUN_ROW] }
    }
    if (/group by status/i.test(text)) {
      const table = /from\s+mutation_outbox/i.test(text) ? 'mutation_outbox' : 'sync_events'
      if (table === 'mutation_outbox') {
        return {
          rows: [
            { status: 'pending', n: 3 },
            { status: 'processing', n: 1 },
            { status: 'failed', n: 2 },
            { status: 'applied', n: 10 },
            // an unrecognized status rolls into "other"
            { status: 'dead', n: 4 },
          ],
        }
      }
      return {
        rows: [
          { status: 'pending', n: 5 },
          { status: 'applied', n: 7 },
        ],
      }
    }
    if (/oldest_pending_age_seconds/i.test(text)) {
      const table = /from\s+mutation_outbox/i.test(text) ? 'mutation_outbox' : 'sync_events'
      // mutation_outbox has pending rows; sync_events min(created_at) → NULL path is exercised elsewhere.
      return { rows: [{ oldest_pending_age_seconds: table === 'mutation_outbox' ? '123.5' : null }] }
    }
    return { rows: [] }
  }
}

function capture() {
  const calls: Array<{ status: number; body: unknown }> = []
  const sendJson = (status: number, body: unknown) => calls.push({ status, body })
  return { calls, sendJson }
}

function req(method: string): IncomingMessage {
  return { method } as IncomingMessage
}

function deps(over: Partial<AdminJobsRouteDeps>): AdminJobsRouteDeps {
  const { sendJson } = capture()
  return { pool: new FakePool(), identity: clerkAdmin, sendJson, envIds: ENV_IDS, ...over }
}

describe('handleAdminJobsRoutes — namespace + gate', () => {
  it('ignores non-jobs paths (returns false, no response)', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminJobsRoutes(req('GET'), new URL('http://x/api/admin/companies'), deps({ sendJson }))
    expect(handled).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('rejects a non-Clerk identity with 401', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminJobsRoutes(
      req('GET'),
      new URL('http://x/api/admin/jobs'),
      deps({ sendJson, identity: { userId: 'x', source: 'header' } }),
    )
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(401)
  })

  it('rejects a Clerk non-superadmin with 403', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminJobsRoutes(
      req('GET'),
      new URL('http://x/api/admin/jobs'),
      deps({ sendJson, envIds: new Set() }),
    )
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(403)
  })

  it('rejects a non-GET method with 405 (read-only)', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminJobsRoutes(req('POST'), new URL('http://x/api/admin/jobs'), deps({ sendJson }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(405)
  })

  it('the gate runs before any query (non-clerk → never touches the DB)', async () => {
    const { sendJson } = capture()
    const pool = new FakePool()
    await handleAdminJobsRoutes(
      req('GET'),
      new URL('http://x/api/admin/jobs'),
      deps({ sendJson, pool, identity: { userId: 'x', source: 'header' } }),
    )
    expect(pool.queries.some((q) => /from job_runs/i.test(q))).toBe(false)
  })
})

describe('handleAdminJobsRoutes — authorized GET (contract shape)', () => {
  it('returns generated_at + job_runs + queues from mocked rows', async () => {
    const { calls, sendJson } = capture()
    const handled = await handleAdminJobsRoutes(req('GET'), new URL('http://x/api/admin/jobs'), deps({ sendJson }))
    expect(handled).toBe(true)
    expect(calls[0]?.status).toBe(200)

    const body = calls[0]?.body as {
      generated_at: string
      job_runs: Array<Record<string, unknown>>
      queues: Record<string, Record<string, unknown>>
    }

    expect(typeof body.generated_at).toBe('string')
    expect(Number.isNaN(Date.parse(body.generated_at))).toBe(false)

    // job_runs: one row, bigint string columns normalized to numbers.
    expect(body.job_runs).toHaveLength(1)
    expect(body.job_runs[0]).toMatchObject({
      job_name: 'queue-prune',
      scope: 'global',
      last_status: 'ok',
      last_error: '',
      last_duration_ms: 1000,
      run_count: 42,
      success_count: 40,
      failure_count: 2,
      skipped_count: 0,
      next_eligible_at: '2026-06-03T00:05:00.000Z',
      updated_at: '2026-06-03T00:00:01.000Z',
    })

    // queues.mutation_outbox: known statuses + "other" + total + oldest age.
    expect(body.queues.mutation_outbox).toEqual({
      pending: 3,
      processing: 1,
      failed: 2,
      applied: 10,
      other: 4,
      total: 20,
      oldest_pending_age_seconds: 123.5,
    })

    // queues.sync_events: no pending rows → oldest age is null; zero-fills.
    expect(body.queues.sync_events).toEqual({
      pending: 5,
      processing: 0,
      failed: 0,
      applied: 7,
      other: 0,
      total: 12,
      oldest_pending_age_seconds: null,
    })
  })

  it('orders job_runs query by last_finished_at desc nulls last + reads job_runs without app.company_id', async () => {
    const { sendJson } = capture()
    const pool = new FakePool()
    await handleAdminJobsRoutes(req('GET'), new URL('http://x/api/admin/jobs'), deps({ sendJson, pool }))
    const jobQuery = pool.queries.find((q) => /from job_runs/i.test(q))
    expect(jobQuery).toBeDefined()
    expect(/order by last_finished_at desc nulls last/i.test(jobQuery!)).toBe(true)
    // No GUC / company scoping is set on the plain pool path.
    expect(pool.queries.some((q) => /app\.company_id|set local/i.test(q))).toBe(false)
  })

  it('returns empty job_runs + zeroed queues when there is no data', async () => {
    class EmptyPool {
      async query(): Promise<{ rows: unknown[] }> {
        return { rows: [] }
      }
    }
    const { calls, sendJson } = capture()
    await handleAdminJobsRoutes(
      req('GET'),
      new URL('http://x/api/admin/jobs'),
      deps({ sendJson, pool: new EmptyPool() }),
    )
    const body = calls[0]?.body as {
      job_runs: unknown[]
      queues: { mutation_outbox: QueueLike; sync_events: QueueLike }
    }
    expect(body.job_runs).toHaveLength(0)
    expect(body.queues.mutation_outbox).toEqual({
      pending: 0,
      processing: 0,
      failed: 0,
      applied: 0,
      other: 0,
      total: 0,
      oldest_pending_age_seconds: null,
    })
    expect(body.queues.sync_events.total).toBe(0)
  })
})

type QueueLike = {
  pending: number
  processing: number
  failed: number
  applied: number
  other: number
  total: number
  oldest_pending_age_seconds: number | null
}
