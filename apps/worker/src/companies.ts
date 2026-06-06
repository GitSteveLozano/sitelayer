import type { Pool } from 'pg'

export interface ActiveCompany {
  id: string
  slug: string
}

/**
 * List the companies the worker should drain in a heartbeat.
 *
 * MULTI-TENANT: the worker historically drained a SINGLE company
 * (process.env.ACTIVE_COMPANY_SLUG, default 'la-operations'). That made
 * every per-company drain — QBO sync, rental invoicing, estimate push,
 * payroll — silently skip every OTHER tenant. This helper makes the worker
 * iterate ALL companies, mirroring the cross-tenant notification drain
 * (which already pulls across every company).
 *
 * ACTIVE_COMPANY_SLUG is kept as an OPTIONAL single-company override (e.g.
 * for targeted reprocessing or a single-tenant deployment). When set to a
 * known slug, only that company is returned; when unset, ALL companies are
 * returned. An ACTIVE_COMPANY_SLUG that matches no row returns an empty
 * list (the heartbeat then logs "waiting for company slug", preserving the
 * old single-tenant boot behavior).
 *
 * The `companies` table has no active/archived/deleted column today, so
 * "active" == "exists". If such a column is added later, narrow the WHERE
 * here; the caller contract (a list of {id, slug}) is unchanged.
 */
export async function listActiveCompanies(pool: Pool, overrideSlug?: string | null): Promise<ActiveCompany[]> {
  const slug = (overrideSlug ?? '').trim()
  if (slug) {
    const result = await pool.query<ActiveCompany>('select id, slug from companies where slug = $1 limit 1', [slug])
    return result.rows
  }
  const result = await pool.query<ActiveCompany>('select id, slug from companies order by created_at asc, id asc')
  return result.rows
}
