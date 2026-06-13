import type http from 'node:http'
import { handleInventoryAvailabilityRoutes } from './inventory-availability.js'
import { handleRentalBillingStateRoutes } from './rental-billing-state.js'
import { handleRentalContractLinesRoutes } from './rental-contract-lines.js'
import { handleRentalContractsRoutes } from './rental-contracts.js'
import { handleRentalInventoryCrudRoutes } from './rental-inventory-crud.js'
import { handleRentalInventoryCsvRoutes } from './rental-inventory-csv.js'
import type { RentalInventoryRouteCtx } from './rental-inventory.types.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

export type { RentalInventoryRouteCtx } from './rental-inventory.types.js'

/**
 * Thin barrel that fans the rental-inventory request out to the focused
 * split modules. Order is significant only in the sense that earlier modules
 * "win" the URL space they own; the split is by URL prefix so there is no
 * actual overlap, but the order matches the historical handler so any future
 * route additions stay easy to bisect.
 *
 * Split modules:
 * - rental-inventory-crud.ts    — items + locations + movements CRUD
 * - inventory-availability.ts   — stock availability query (read-only rollup)
 * - rental-inventory-csv.ts     — bulk CSV import (upsert by code)
 * - rental-contracts.ts         — contracts + billing-run create/preview
 * - rental-contract-lines.ts    — contract lines + per-line rate tiers
 * - rental-billing-state.ts     — billing run workflow events (state machine)
 */
export async function handleRentalInventoryRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalInventoryRouteCtx,
): Promise<boolean> {
  if (await handleRentalInventoryCrudRoutes(req, url, ctx)) return true
  if (await handleInventoryAvailabilityRoutes(req, url, ctx)) return true
  if (await handleRentalInventoryCsvRoutes(req, url, ctx)) return true
  if (await handleRentalContractsRoutes(req, url, ctx)) return true
  if (await handleRentalContractLinesRoutes(req, url, ctx)) return true
  if (await handleRentalBillingStateRoutes(req, url, ctx)) return true
  return false
}

/**
 * Self-registered dispatch descriptor for the `rental-inventory` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const rentalInventoryRouteDescriptor: DispatchRouteDescriptor = {
  name: 'rental-inventory',
  order: 450,
  handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson, checkVersion, ctx }) =>
    handleRentalInventoryRoutes(req, url, {
      pool,
      company,
      currentUserId,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
      checkVersion,
      storage: ctx.storage,
      maxMovementPhotoBytes: Number(process.env.MAX_MOVEMENT_PHOTO_BYTES ?? 25 * 1024 * 1024),
      movementPhotoDownloadPresigned: ctx.blueprintDownloadPresigned,
      sendFileContent: ctx.sendFileContent,
      sendFileRedirect: ctx.sendFileRedirect,
    }),
}
