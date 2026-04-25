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
