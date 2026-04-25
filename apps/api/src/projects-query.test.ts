import { describe, expect, it } from 'vitest'
import { buildListProjectsQuery, DEFAULT_PROJECTS_LIMIT, parseProjectsQuery } from './projects-query.js'

function makeParams(input: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(input)) p.set(k, v)
  return p
}

describe('parseProjectsQuery', () => {
  it('returns nulls for empty/missing filters and the default limit', () => {
    const q = parseProjectsQuery(new URLSearchParams())
    expect(q).toEqual({ q: null, status: null, customer_id: null, cursor: null, limit: DEFAULT_PROJECTS_LIMIT })
  })

  it('trims and preserves all filters', () => {
    const q = parseProjectsQuery(makeParams({ q: '  maple  ', status: 'active', customer_id: 'cust-1' }))
    expect(q.q).toBe('maple')
    expect(q.status).toBe('active')
    expect(q.customer_id).toBe('cust-1')
  })

  it('clamps limit to 1..100', () => {
    expect(parseProjectsQuery(makeParams({ limit: '0' })).limit).toBe(1)
    expect(parseProjectsQuery(makeParams({ limit: '500' })).limit).toBe(100)
    expect(parseProjectsQuery(makeParams({ limit: 'banana' })).limit).toBe(DEFAULT_PROJECTS_LIMIT)
  })

  it('preserves the cursor as a string (callers cast to timestamptz)', () => {
    const q = parseProjectsQuery(makeParams({ cursor: '2026-04-23T12:00:00.000Z' }))
    expect(q.cursor).toBe('2026-04-23T12:00:00.000Z')
  })
})

describe('buildListProjectsQuery', () => {
  it('builds the bare list query with only company scope when no filters set', () => {
    const built = buildListProjectsQuery('co-1', {
      q: null,
      status: null,
      customer_id: null,
      cursor: null,
      limit: 100,
    })
    expect(built.values).toEqual(['co-1', 100])
    expect(built.sql).toMatch(/where p\.company_id = \$1\s+order by p\.updated_at desc/)
    expect(built.sql).toMatch(/left join customers c/)
    expect(built.sql).toMatch(/limit \$2/)
  })

  it('combines q, status, customer_id with AND and binds values in order', () => {
    const built = buildListProjectsQuery('co-1', {
      q: 'maple',
      status: 'active',
      customer_id: 'cust-99',
      cursor: null,
      limit: 50,
    })
    expect(built.values).toEqual(['co-1', '%maple%', 'active', 'cust-99', 50])
    // Ensure the q clause references customer.name + project.customer_name
    expect(built.sql).toContain('p.name ilike $2')
    expect(built.sql).toContain('p.customer_name ilike $2')
    expect(built.sql).toContain("coalesce(c.name, '') ilike $2")
    expect(built.sql).toContain('p.status = $3')
    expect(built.sql).toContain('p.customer_id = $4')
    // Three filter clauses + company scope, all combined with `and`
    const andCount = (built.sql.match(/\sand\s/gi) ?? []).length
    expect(andCount).toBeGreaterThanOrEqual(3)
  })

  it('appends cursor before limit when supplied', () => {
    const built = buildListProjectsQuery('co-1', {
      q: 'maple',
      status: null,
      customer_id: null,
      cursor: '2026-04-23T12:00:00.000Z',
      limit: 25,
    })
    expect(built.values).toEqual(['co-1', '%maple%', '2026-04-23T12:00:00.000Z', 25])
    expect(built.sql).toContain('p.updated_at < $3::timestamptz')
    expect(built.sql).toContain('limit $4')
  })
})
