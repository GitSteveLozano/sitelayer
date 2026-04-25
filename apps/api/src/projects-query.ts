/**
 * `/api/projects` server-side filtering.
 *
 * Pure parser + SQL builder so the unit test can assert query shape and
 * value binding without touching Postgres. The handler in `server.ts` calls
 * `parseProjectsQuery()` and `buildListProjectsQuery()` and passes the
 * resulting (sql, values) into `pool.query`.
 */

export type ProjectsQuery = {
  q: string | null
  status: string | null
  customer_id: string | null
  cursor: string | null
  limit: number
}

export const DEFAULT_PROJECTS_LIMIT = 100
const MAX_PROJECTS_LIMIT = 100

/**
 * Read a `URLSearchParams` and produce a normalized projects query. Empty
 * strings are coerced to `null` so the SQL builder can decide whether the
 * filter participates at all.
 */
export function parseProjectsQuery(params: URLSearchParams): ProjectsQuery {
  const q = (params.get('q') ?? '').trim()
  const status = (params.get('status') ?? '').trim()
  const customerId = (params.get('customer_id') ?? '').trim()
  const cursor = (params.get('cursor') ?? '').trim()
  const rawLimit = Number(params.get('limit') ?? DEFAULT_PROJECTS_LIMIT)
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_PROJECTS_LIMIT, Math.floor(rawLimit)))
    : DEFAULT_PROJECTS_LIMIT
  return {
    q: q ? q : null,
    status: status ? status : null,
    customer_id: customerId ? customerId : null,
    cursor: cursor ? cursor : null,
    limit,
  }
}

export type BuiltProjectsQuery = {
  sql: string
  values: unknown[]
  /** Echo of the limit so the caller can decide whether to surface a `next` cursor. */
  limit: number
}

/**
 * Build the SQL + bind values for `listProjects` with optional filters.
 *
 * - `q` matches projects.name, projects.customer_name, and (when joined)
 *   customers.name via ILIKE %q% (combined with OR).
 * - `status` is exact equality.
 * - `customer_id` is exact equality on projects.customer_id.
 * - All present filters combine with AND.
 * - `cursor` is a timestamp (ISO 8601). Rows whose `updated_at` is strictly
 *   less than the cursor are returned, preserving the `order by updated_at
 *   desc` ordering.
 */
export function buildListProjectsQuery(companyId: string, query: ProjectsQuery): BuiltProjectsQuery {
  const values: unknown[] = [companyId]
  const clauses: string[] = ['p.company_id = $1']

  if (query.q !== null) {
    values.push(`%${query.q}%`)
    const idx = values.length
    clauses.push(`(p.name ilike $${idx} or p.customer_name ilike $${idx} or coalesce(c.name, '') ilike $${idx})`)
  }
  if (query.status !== null) {
    values.push(query.status)
    clauses.push(`p.status = $${values.length}`)
  }
  if (query.customer_id !== null) {
    values.push(query.customer_id)
    clauses.push(`p.customer_id = $${values.length}`)
  }
  if (query.cursor !== null) {
    values.push(query.cursor)
    clauses.push(`p.updated_at < $${values.length}::timestamptz`)
  }

  values.push(query.limit)
  const limitIdx = values.length

  const sql = `
    select
      p.id, p.customer_id, p.name, p.customer_name, p.division_code, p.status, p.bid_total,
      p.labor_rate, p.target_sqft_per_hr, p.bonus_pool, p.closed_at, p.summary_locked_at,
      p.site_lat, p.site_lng, p.site_radius_m,
      p.version, p.created_at, p.updated_at
    from projects p
    left join customers c on c.id = p.customer_id and c.company_id = p.company_id
    where ${clauses.join(' and ')}
    order by p.updated_at desc
    limit $${limitIdx}
  `

  return { sql, values, limit: query.limit }
}
