import { describe, expect, it, vi } from 'vitest'
import type { QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { markJobRunStarted, recordJobRun, withJobRun, type JobRunClient } from './job-runs.js'

// Unit tests for the job_runs ledger writer. job_runs is a GLOBAL
// (company-agnostic, no-RLS) run ledger; each runner upserts ONE row per
// run keyed on job_name. We don't bind to a real Postgres — a fake client
// captures the SQL text + bound params and returns scripted responses.

const testLogger = createLogger('job-runs-test', { level: 'silent' })

interface CapturedQuery {
  sql: string
  params: unknown[]
}

function makeClient(opts: { failOn?: (sql: string) => boolean } = {}): {
  client: JobRunClient
  calls: CapturedQuery[]
} {
  const calls: CapturedQuery[] = []
  const client: JobRunClient = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] })
      if (opts.failOn?.(sql)) {
        throw new Error('boom')
      }
      return {
        rows: [],
        rowCount: 0,
        command: '',
        oid: 0,
        fields: [],
      } as QueryResult<QueryResultRow>
    }) as unknown as JobRunClient['query'],
  }
  return { client, calls }
}

// Normalize whitespace so assertions don't depend on indentation.
const flat = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

// Guarded accessor — keeps `noUncheckedIndexedAccess` happy and fails the
// test loudly if the expected call wasn't captured.
function at(calls: CapturedQuery[], i: number): CapturedQuery {
  const call = calls[i]
  if (!call) throw new Error(`expected a captured query at index ${i}, got ${calls.length}`)
  return call
}

describe('recordJobRun', () => {
  it('emits an INSERT ... ON CONFLICT (job_name) DO UPDATE upsert', async () => {
    const { client, calls } = makeClient()
    await recordJobRun(client, 'queue_prune', { status: 'ok', durationMs: 12 }, testLogger)
    expect(calls).toHaveLength(1)
    const sql = flat(at(calls, 0).sql)
    expect(sql).toContain('insert into public.job_runs')
    expect(sql).toContain('on conflict (job_name) do update set')
    // run_count always increments by one on conflict.
    expect(sql).toContain('run_count = public.job_runs.run_count + 1')
    expect(sql).toContain('last_finished_at = now()')
    expect(sql).toContain('updated_at = now()')
  })

  it('maps status=ok to a +1 success delta and 0 failure/skipped', async () => {
    const { client, calls } = makeClient()
    await recordJobRun(client, 'notification_drain', { status: 'ok' }, testLogger)
    // Params: [jobName, scope, status, lastError, durationMs,
    //          successDelta, failureDelta, skippedDelta, nextEligibleAt, metadata]
    const p = at(calls, 0).params
    expect(p[0]).toBe('notification_drain')
    expect(p[2]).toBe('ok')
    expect(p[5]).toBe(1) // success delta
    expect(p[6]).toBe(0) // failure delta
    expect(p[7]).toBe(0) // skipped delta
  })

  it('maps status=error to a +1 failure delta and coalesces a null error to empty string', async () => {
    const { client, calls } = makeClient()
    await recordJobRun(client, 'lane_health_keeper', { status: 'error', error: null }, testLogger)
    const p = at(calls, 0).params
    expect(p[2]).toBe('error')
    expect(p[3]).toBe('') // last_error coalesced from null
    expect(p[5]).toBe(0)
    expect(p[6]).toBe(1) // failure delta
    expect(p[7]).toBe(0)
  })

  it('maps status=skipped to a +1 skipped delta', async () => {
    const { client, calls } = makeClient()
    await recordJobRun(client, 'queue_prune', { status: 'skipped' }, testLogger)
    const p = at(calls, 0).params
    expect(p[2]).toBe('skipped')
    expect(p[5]).toBe(0)
    expect(p[6]).toBe(0)
    expect(p[7]).toBe(1) // skipped delta
  })

  it('the ON CONFLICT branch increments success/failure/skipped by the same deltas', async () => {
    const { client, calls } = makeClient()
    await recordJobRun(client, 'queue_prune', { status: 'ok' }, testLogger)
    const sql = flat(at(calls, 0).sql)
    expect(sql).toContain('success_count = public.job_runs.success_count + $6')
    expect(sql).toContain('failure_count = public.job_runs.failure_count + $7')
    expect(sql).toContain('skipped_count = public.job_runs.skipped_count + $8')
  })

  it('defaults scope to "global" and serializes metadata as JSON', async () => {
    const { client, calls } = makeClient()
    await recordJobRun(client, 'worker_heartbeat', { status: 'ok', metadata: { idle: true, companies: 3 } }, testLogger)
    const p = at(calls, 0).params
    expect(p[1]).toBe('global') // scope default
    expect(p[9]).toBe(JSON.stringify({ idle: true, companies: 3 }))
  })

  it('honours an explicit scope override', async () => {
    const { client, calls } = makeClient()
    await recordJobRun(client, 'worker_heartbeat', { status: 'ok', scope: 'tenant-x' }, testLogger)
    expect(at(calls, 0).params[1]).toBe('tenant-x')
  })

  it('NEVER throws when the query fails — swallows + logs', async () => {
    const { client } = makeClient({ failOn: () => true })
    await expect(recordJobRun(client, 'queue_prune', { status: 'ok' }, testLogger)).resolves.toBeUndefined()
  })
})

describe('markJobRunStarted', () => {
  it('upserts last_status=running and last_started_at=now()', async () => {
    const { client, calls } = makeClient()
    await markJobRunStarted(client, 'worker_heartbeat', 'global', testLogger)
    const sql = flat(at(calls, 0).sql)
    expect(sql).toContain('insert into public.job_runs')
    expect(sql).toContain('on conflict (job_name) do update set')
    expect(sql).toContain("last_status = 'running'")
    expect(sql).toContain('last_started_at = now()')
  })

  it('NEVER throws when the query fails', async () => {
    const { client } = makeClient({ failOn: () => true })
    await expect(markJobRunStarted(client, 'worker_heartbeat', 'global', testLogger)).resolves.toBeUndefined()
  })
})

describe('withJobRun', () => {
  it('stamps running, runs fn, records ok, and returns fn result', async () => {
    const { client, calls } = makeClient()
    const result = await withJobRun(client, 'queue_prune', async () => 42, { logger: testLogger })
    expect(result).toBe(42)
    // First call = markJobRunStarted (running), second = recordJobRun (ok).
    expect(calls).toHaveLength(2)
    expect(flat(at(calls, 0).sql)).toContain("last_status = 'running'")
    expect(at(calls, 1).params[2]).toBe('ok')
  })

  it('records error with the thrown message and re-raises the original error', async () => {
    const { client, calls } = makeClient()
    await expect(
      withJobRun(
        client,
        'queue_prune',
        async () => {
          throw new Error('fn exploded')
        },
        { logger: testLogger },
      ),
    ).rejects.toThrow('fn exploded')
    // running stamp + error record.
    expect(calls).toHaveLength(2)
    expect(at(calls, 1).params[2]).toBe('error')
    expect(at(calls, 1).params[3]).toBe('fn exploded')
  })

  it('a ledger-write failure does not mask fn success', async () => {
    // Fail ONLY the recordJobRun upsert (the one carrying run_count).
    const { client } = makeClient({ failOn: (sql) => sql.includes('run_count') })
    await expect(withJobRun(client, 'queue_prune', async () => 'value', { logger: testLogger })).resolves.toBe('value')
  })
})
