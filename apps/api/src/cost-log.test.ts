import { describe, expect, it, vi } from 'vitest'
import type { PoolClient } from 'pg'
import { recordCostLog } from './cost-log.js'

/**
 * Shape-only coverage for the cost-log helper. We mock a PoolClient with
 * a `query` spy and assert the SQL + parameter shape the caller commits.
 * Live integration coverage (RLS scoping, jsonb round-trip) lives behind
 * the standard RUN_API_INTEGRATION gate alongside the rest of the
 * tenant-scoped migrations and is out of scope here — this test only
 * proves the helper inserts the columns it promises to insert.
 */

function makeMockClient(): { client: PoolClient; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const client = { query } as unknown as PoolClient
  return { client, query }
}

describe('recordCostLog', () => {
  it('inserts the seven columns the migration declares', async () => {
    const { client, query } = makeMockClient()
    await recordCostLog(client, {
      companyId: 'co-123',
      operation: 'qbo_api_call',
      costUsd: 0.05,
      description: 'qbo:customer:query',
      requestId: 'req-abc',
      sentryTrace: 'trace-xyz-1',
      metadata: { entity: 'Customer', count: 42 },
    })
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('insert into company_usage_log')
    expect(sql).toContain('company_id, operation, cost_usd, description, request_id, sentry_trace, metadata')
    expect(params).toEqual([
      'co-123',
      'qbo_api_call',
      '0.050000',
      'qbo:customer:query',
      'req-abc',
      'trace-xyz-1',
      JSON.stringify({ entity: 'Customer', count: 42 }),
    ])
  })

  it('serializes cost to six decimal places (placeholder precision)', async () => {
    const { client, query } = makeMockClient()
    await recordCostLog(client, {
      companyId: 'co-1',
      operation: 'blueprint_vision_page',
      costUsd: 0.25,
    })
    const params = (query.mock.calls[0] as [string, unknown[]])[1]
    expect(params[2]).toBe('0.250000')
  })

  it('defaults description, request_id, sentry_trace to null and metadata to {}', async () => {
    const { client, query } = makeMockClient()
    await recordCostLog(client, {
      companyId: 'co-1',
      operation: 'qbo_api_call',
      costUsd: 0.05,
    })
    const params = (query.mock.calls[0] as [string, unknown[]])[1]
    expect(params[3]).toBeNull()
    expect(params[4]).toBeNull()
    expect(params[5]).toBeNull()
    expect(params[6]).toBe('{}')
  })

  it('preserves an explicit null for request_id / sentry_trace', async () => {
    const { client, query } = makeMockClient()
    await recordCostLog(client, {
      companyId: 'co-1',
      operation: 'qbo_api_call',
      costUsd: 0.05,
      requestId: null,
      sentryTrace: null,
    })
    const params = (query.mock.calls[0] as [string, unknown[]])[1]
    expect(params[4]).toBeNull()
    expect(params[5]).toBeNull()
  })

  it('rounds very small costs at the 6-decimal precision the column allows', async () => {
    const { client, query } = makeMockClient()
    await recordCostLog(client, {
      companyId: 'co-1',
      operation: 'qbo_api_call',
      costUsd: 0.0000005,
    })
    const params = (query.mock.calls[0] as [string, unknown[]])[1]
    // toFixed(6) rounds 0.0000005 to '0.000001' on most platforms; the assertion
    // doesn't pin the exact value, only that the helper truncates to 6 decimals
    // (i.e. doesn't pass a longer string that would overflow numeric(10,6)).
    expect(typeof params[2]).toBe('string')
    expect(params[2]).toMatch(/^0\.\d{6}$/)
  })
})
