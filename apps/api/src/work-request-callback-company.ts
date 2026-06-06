import type { QueryResultRow } from 'pg'
import type { ActiveCompany } from './auth-types.js'

type CompanyRow = {
  id: string
  slug: string
  name: string
  created_at: string
}

export interface WorkRequestCallbackCompanyExecutor {
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
}

export function matchWorkRequestCallbackWorkItemId(method: string | undefined, pathname: string): string | null {
  if (method !== 'POST') return null
  const match = pathname.match(/^\/api\/work-requests\/([^/]+)\/agent-callback$/)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

export async function resolveWorkRequestCallbackCompany(
  executor: WorkRequestCallbackCompanyExecutor,
  workItemId: string,
): Promise<ActiveCompany | null> {
  const result = await executor.query<CompanyRow>(
    `select c.id, c.slug, c.name, c.created_at
       from context_work_items w
       join companies c on c.id = w.company_id
      where w.id = $1
      limit 1`,
    [workItemId],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    created_at: row.created_at,
    role: 'admin',
  }
}
