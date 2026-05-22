import { describe, expect, it } from 'vitest'
import {
  matchWorkRequestCallbackWorkItemId,
  resolveWorkRequestCallbackCompany,
  type WorkRequestCallbackCompanyExecutor,
} from './work-request-callback-company.js'

class FakeExecutor implements WorkRequestCallbackCompanyExecutor {
  public readonly queries: Array<{ sql: string; params: unknown[] }> = []

  constructor(private readonly rows: Array<{ id: string; slug: string; name: string; created_at: string }>) {}

  async query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params: params ?? [] })
    return { rows: this.rows as T[] }
  }
}

describe('work request callback company resolution', () => {
  it('matches only POST agent-callback paths and decodes the work item id', () => {
    expect(matchWorkRequestCallbackWorkItemId('POST', '/api/work-requests/work-item-1/agent-callback')).toBe(
      'work-item-1',
    )
    expect(matchWorkRequestCallbackWorkItemId('POST', '/api/work-requests/work%20item/agent-callback')).toBe(
      'work item',
    )
    expect(matchWorkRequestCallbackWorkItemId('GET', '/api/work-requests/work-item-1/agent-callback')).toBeNull()
    expect(matchWorkRequestCallbackWorkItemId('POST', '/api/work-requests/%E0%A4%A/agent-callback')).toBeNull()
    expect(matchWorkRequestCallbackWorkItemId('POST', '/api/work-requests/work-item-1')).toBeNull()
  })

  it('binds callback requests to the company that owns the work item', async () => {
    const executor = new FakeExecutor([
      { id: 'co-steve', slug: 'steve-co', name: 'Steve Co', created_at: '2026-05-22T00:00:00.000Z' },
    ])

    const company = await resolveWorkRequestCallbackCompany(executor, 'work-item-1')

    expect(company).toEqual({
      id: 'co-steve',
      slug: 'steve-co',
      name: 'Steve Co',
      created_at: '2026-05-22T00:00:00.000Z',
      role: 'admin',
    })
    expect(executor.queries[0]?.sql).toContain('from context_work_items w')
    expect(executor.queries[0]?.sql).toContain('join companies c on c.id = w.company_id')
    expect(executor.queries[0]?.params).toEqual(['work-item-1'])
  })

  it('returns null when the callback work item is unknown', async () => {
    const executor = new FakeExecutor([])

    await expect(resolveWorkRequestCallbackCompany(executor, 'missing-work-item')).resolves.toBeNull()
  })
})
