import type http from 'node:http'
import { handleInventoryAvailabilityRoutes } from './inventory-availability.js'
import { handleRentalBillingStateRoutes } from './rental-billing-state.js'
import { handleRentalContractsCrudRoutes } from './rental-contracts-crud.js'
import { handleRentalInventoryCrudRoutes } from './rental-inventory-crud.js'
import { handleRentalInventoryCsvRoutes } from './rental-inventory-csv.js'
import type { RentalInventoryRouteCtx } from './rental-inventory.types.js'

export type { RentalInventoryRouteCtx } from './rental-inventory.types.js'

/**
 * Thin barrel that fans the rental-inventory request out to the focused
 * split modules. Order is significant only in the sense that earlier modules
 * "win" the URL space they own; the split is by URL prefix so there is no
 * actual overlap, but the order matches the historical handler so any future
 * route additions stay easy to bisect.
 *
 * Split modules:
 * - rental-inventory-crud.ts   — items + locations + movements CRUD
 * - inventory-availability.ts  — stock availability query (read-only rollup)
 * - rental-inventory-csv.ts    — bulk CSV import (upsert by code)
 * - rental-contracts-crud.ts   — contracts + lines + billing-run create/preview
 * - rental-billing-state.ts    — billing run workflow events (state machine)
 */
export async function handleRentalInventoryRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalInventoryRouteCtx,
): Promise<boolean> {
  if (await handleRentalInventoryCrudRoutes(req, url, ctx)) return true
  if (await handleInventoryAvailabilityRoutes(req, url, ctx)) return true
  if (await handleRentalInventoryCsvRoutes(req, url, ctx)) return true
  if (await handleRentalContractsCrudRoutes(req, url, ctx)) return true
  if (await handleRentalBillingStateRoutes(req, url, ctx)) return true
  return false
}
