import type { Pool } from 'pg'

/**
 * Catalog enforcement for the curated service-item ↔ division mapping
 * (`service_item_divisions`). Two flavors:
 *
 *   - `assertServiceItemCatalogStatus` (strict): used by takeoff measurement
 *     endpoints. Refuses both "no rows at all" and "wrong division" so
 *     uncurated catalog entries cannot leak into a takeoff.
 *   - The legacy permissive check stays inline in `server.ts` for
 *     `labor_entries`, where the xref is opt-in.
 *
 * This file deliberately avoids importing from `server.ts` so it can be unit
 * tested without booting the HTTP server.
 */

export type ServiceItemCatalogStatus =
  | { ok: true }
  | { ok: false; reason: 'no_curated_catalog' | 'division_not_allowed' }

export type CatalogQueryRunner = Pick<Pool, 'query'>

export async function assertServiceItemCatalogStatus(
  pool: CatalogQueryRunner,
  companyId: string,
  serviceItemCode: string,
  divisionCode: string | null,
): Promise<ServiceItemCatalogStatus> {
  const existing = await pool.query<{ exists: boolean }>(
    `select exists(
       select 1 from service_item_divisions
        where company_id = $1 and service_item_code = $2
     ) as exists`,
    [companyId, serviceItemCode],
  )
  if (!existing.rows[0]?.exists) {
    return { ok: false, reason: 'no_curated_catalog' }
  }
  if (!divisionCode) {
    return { ok: true }
  }
  const match = await pool.query<{ exists: boolean }>(
    `select exists(
       select 1 from service_item_divisions
        where company_id = $1 and service_item_code = $2 and division_code = $3
     ) as exists`,
    [companyId, serviceItemCode, divisionCode],
  )
  if (!match.rows[0]?.exists) {
    return { ok: false, reason: 'division_not_allowed' }
  }
  return { ok: true }
}

export function rejectionMessageForCatalog(reason: 'no_curated_catalog' | 'division_not_allowed'): string {
  if (reason === 'no_curated_catalog') {
    return 'service item not in curated catalog for any division'
  }
  return 'service item not allowed in this division'
}

export type ServiceItemCatalogIndex = {
  /**
   * Map of service_item_code -> Set of allowed division_codes for the company.
   * Empty Set entry means the catalog has the row with no specific divisions
   * (treated as `no_curated_catalog` by `check`).
   */
  divisionsByItem: Map<string, Set<string>>
  check(serviceItemCode: string, divisionCode: string | null): ServiceItemCatalogStatus
}

/**
 * Pre-load every (service_item_code, division_code) tuple for the company so
 * a batch of N measurements can be validated with one query instead of N×2.
 * Use for the takeoff replace-set endpoint; single-row writes can keep using
 * `assertServiceItemCatalogStatus`.
 */
export async function loadServiceItemCatalogIndex(
  pool: CatalogQueryRunner,
  companyId: string,
  serviceItemCodes: Iterable<string>,
): Promise<ServiceItemCatalogIndex> {
  const codes = Array.from(new Set(Array.from(serviceItemCodes).filter(Boolean)))
  const divisionsByItem = new Map<string, Set<string>>()
  if (codes.length === 0) {
    return makeIndex(divisionsByItem)
  }
  const result = await pool.query<{ service_item_code: string; division_code: string }>(
    `select service_item_code, division_code
       from service_item_divisions
      where company_id = $1
        and service_item_code = any($2::text[])`,
    [companyId, codes],
  )
  for (const row of result.rows) {
    let bucket = divisionsByItem.get(row.service_item_code)
    if (!bucket) {
      bucket = new Set()
      divisionsByItem.set(row.service_item_code, bucket)
    }
    bucket.add(row.division_code)
  }
  return makeIndex(divisionsByItem)
}

function makeIndex(divisionsByItem: Map<string, Set<string>>): ServiceItemCatalogIndex {
  return {
    divisionsByItem,
    check(serviceItemCode, divisionCode) {
      const allowed = divisionsByItem.get(serviceItemCode)
      if (!allowed || allowed.size === 0) {
        return { ok: false, reason: 'no_curated_catalog' }
      }
      if (!divisionCode) return { ok: true }
      if (!allowed.has(divisionCode)) {
        return { ok: false, reason: 'division_not_allowed' }
      }
      return { ok: true }
    },
  }
}
