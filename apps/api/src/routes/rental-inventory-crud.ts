import type http from 'node:http'
import type { PoolClient } from 'pg'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidDateInput, parseExpectedVersion } from '../http-utils.js'
import {
  INVENTORY_ITEM_COLUMNS,
  INVENTORY_LOCATION_COLUMNS,
  INVENTORY_MOVEMENT_COLUMNS,
  LOCATION_TYPES,
  MOVEMENT_TYPES,
  TRACKING_MODES,
  existsInCompany,
  normalizeEnum,
  optionalString,
  parseNonNegativeNumber,
  parsePositiveNumber,
  todayISO,
  type InventoryItemRow,
  type InventoryLocationRow,
  type InventoryMovementRow,
  type RentalInventoryRouteCtx,
} from './rental-inventory.types.js'

/**
 * Handle the inventory catalog CRUD surface — items, locations, and the
 * movement ledger. These are the read/write paths that maintain the
 * "what stock do we own and where is it" picture; the contract/billing
 * surfaces live in `rental-contracts-crud.ts` and `rental-billing-state.ts`.
 *
 * Routes:
 * - GET    /api/inventory/items                — list non-deleted items
 * - POST   /api/inventory/items                — create item (admin/office)
 * - PATCH  /api/inventory/items/:id            — versioned update
 * - DELETE /api/inventory/items/:id            — versioned soft-delete
 * - GET    /api/inventory/locations            — list non-deleted locations
 * - POST   /api/inventory/locations            — create location (admin/office)
 * - GET    /api/inventory/movements            — recent movements (filterable)
 * - POST   /api/inventory/movements            — append movement
 *
 * The CSV bulk-upsert endpoint (`/api/inventory/items/import`) lives in
 * `rental-inventory-csv.ts`, and the materialized availability view lives in
 * `inventory-availability.ts`.
 */
export async function handleRentalInventoryCrudRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalInventoryRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/inventory/items') {
    const result = await ctx.pool.query<InventoryItemRow>(
      `
      select ${INVENTORY_ITEM_COLUMNS}
      from inventory_items
      where company_id = $1 and deleted_at is null
      order by active desc, code asc
      `,
      [ctx.company.id],
    )
    ctx.sendJson(200, { inventoryItems: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/items') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const code = String(body.code ?? '').trim()
    const description = String(body.description ?? '').trim()
    if (!code || !description) {
      ctx.sendJson(400, { error: 'code and description are required' })
      return true
    }
    const defaultRentalRate = parseNonNegativeNumber(body.default_rental_rate, 0)
    const replacementValue =
      body.replacement_value === undefined || body.replacement_value === null || body.replacement_value === ''
        ? null
        : parseNonNegativeNumber(body.replacement_value, 0)
    if (!Number.isFinite(defaultRentalRate) || (replacementValue !== null && !Number.isFinite(replacementValue))) {
      ctx.sendJson(400, { error: 'rates must be non-negative numbers' })
      return true
    }
    const item = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<InventoryItemRow>(
        `
        insert into inventory_items (
          company_id, code, description, category, unit, default_rental_rate,
          replacement_value, tracking_mode, active, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, true), $10)
        returning ${INVENTORY_ITEM_COLUMNS}
        `,
        [
          ctx.company.id,
          code,
          description,
          optionalString(body.category) ?? 'scaffold',
          optionalString(body.unit) ?? 'ea',
          defaultRentalRate,
          replacementValue,
          normalizeEnum(body.tracking_mode, TRACKING_MODES, 'quantity'),
          body.active ?? true,
          optionalString(body.notes),
        ],
      )
      const row = result.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'inventory_item',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, item)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/inventory\/items\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const itemId = url.pathname.split('/')[4] ?? ''
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<InventoryItemRow>(
        `
        update inventory_items
        set
          code = coalesce($3, code),
          description = coalesce($4, description),
          category = coalesce($5, category),
          unit = coalesce($6, unit),
          default_rental_rate = coalesce($7, default_rental_rate),
          replacement_value = coalesce($8, replacement_value),
          tracking_mode = coalesce($9, tracking_mode),
          active = coalesce($10, active),
          notes = coalesce($11, notes),
          version = version + 1,
          updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null
          and ($12::int is null or version = $12)
        returning ${INVENTORY_ITEM_COLUMNS}
        `,
        [
          ctx.company.id,
          itemId,
          optionalString(body.code),
          optionalString(body.description),
          optionalString(body.category),
          optionalString(body.unit),
          body.default_rental_rate ?? null,
          body.replacement_value ?? null,
          body.tracking_mode ? normalizeEnum(body.tracking_mode, TRACKING_MODES, 'quantity') : null,
          body.active ?? null,
          optionalString(body.notes),
          expectedVersion,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'inventory_item',
        entityId: itemId,
        action: 'update',
        row,
        idempotencyKey: `inventory_item:update:${itemId}:${row.version}`,
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'inventory_items',
          'company_id = $1 and id = $2',
          [ctx.company.id, itemId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'inventory item not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/inventory\/items\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const itemId = url.pathname.split('/')[4] ?? ''
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<InventoryItemRow>(
        `
        update inventory_items
        set deleted_at = now(), active = false, version = version + 1, updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null
          and ($3::int is null or version = $3)
        returning ${INVENTORY_ITEM_COLUMNS}
        `,
        [ctx.company.id, itemId, expectedVersion],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'inventory_item',
        entityId: itemId,
        action: 'delete',
        row,
      })
      return row
    })
    if (!deleted) {
      if (
        !(await ctx.checkVersion(
          'inventory_items',
          'company_id = $1 and id = $2',
          [ctx.company.id, itemId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'inventory item not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/inventory/locations') {
    const result = await ctx.pool.query<InventoryLocationRow>(
      `
      select ${INVENTORY_LOCATION_COLUMNS}
      from inventory_locations
      where company_id = $1 and deleted_at is null
      order by is_default desc, name asc
      `,
      [ctx.company.id],
    )
    ctx.sendJson(200, { inventoryLocations: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/locations') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const name = String(body.name ?? '').trim()
    if (!name) {
      ctx.sendJson(400, { error: 'name is required' })
      return true
    }
    const projectId = optionalString(body.project_id)
    if (projectId && !(await existsInCompany(ctx.pool, 'projects', ctx.company.id, projectId))) {
      ctx.sendJson(400, { error: 'project_id not found for company' })
      return true
    }
    const location = await withMutationTx(async (client: PoolClient) => {
      if (body.is_default) {
        await client.query('update inventory_locations set is_default = false where company_id = $1', [ctx.company.id])
      }
      const result = await client.query<InventoryLocationRow>(
        `
        insert into inventory_locations (company_id, project_id, name, location_type, is_default)
        values ($1, $2, $3, $4, coalesce($5, false))
        returning ${INVENTORY_LOCATION_COLUMNS}
        `,
        [
          ctx.company.id,
          projectId,
          name,
          normalizeEnum(body.location_type, LOCATION_TYPES, projectId ? 'job' : 'yard'),
          body.is_default ?? false,
        ],
      )
      const row = result.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'inventory_location',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, location)
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/inventory/movements') {
    const values: unknown[] = [ctx.company.id]
    const clauses = ['m.company_id = $1']
    const itemId = url.searchParams.get('item_id')
    const projectId = url.searchParams.get('project_id')
    const movementType = url.searchParams.get('type')
    if (itemId) {
      values.push(itemId)
      clauses.push(`m.inventory_item_id = $${values.length}`)
    }
    if (projectId) {
      values.push(projectId)
      clauses.push(`m.project_id = $${values.length}`)
    }
    if (movementType && MOVEMENT_TYPES.has(movementType)) {
      values.push(movementType)
      clauses.push(`m.movement_type = $${values.length}`)
    }
    const result = await ctx.pool.query<
      InventoryMovementRow & {
        item_code: string | null
        item_description: string | null
        from_location_name: string | null
        to_location_name: string | null
        project_name: string | null
      }
    >(
      `
      select
        m.id,
        m.company_id,
        m.inventory_item_id,
        m.from_location_id,
        m.to_location_id,
        m.project_id,
        m.movement_type,
        m.quantity,
        to_char(m.occurred_on, 'YYYY-MM-DD') as occurred_on,
        m.ticket_number,
        m.notes,
        m.version,
        m.created_at,
        i.code as item_code,
        i.description as item_description,
        fl.name as from_location_name,
        tl.name as to_location_name,
        p.name as project_name
      from inventory_movements m
      left join inventory_items i on i.company_id = m.company_id and i.id = m.inventory_item_id
      left join inventory_locations fl on fl.company_id = m.company_id and fl.id = m.from_location_id
      left join inventory_locations tl on tl.company_id = m.company_id and tl.id = m.to_location_id
      left join projects p on p.company_id = m.company_id and p.id = m.project_id
      where ${clauses.join(' and ')}
      order by m.occurred_on desc, m.created_at desc
      limit 500
      `,
      values,
    )
    ctx.sendJson(200, { inventoryMovements: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/movements') {
    // Workers can scan-dispatch from the field but only with full scan
    // context; admin/foreman/office can post any movement (e.g. yard
    // adjustments without a scan).
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'worker'])) return true
    const body = await ctx.readBody()
    const itemId = optionalString(body.inventory_item_id)
    const quantity = parsePositiveNumber(body.quantity)
    if (!itemId || quantity === null) {
      ctx.sendJson(400, { error: 'inventory_item_id and positive quantity are required' })
      return true
    }
    if (!(await existsInCompany(ctx.pool, 'inventory_items', ctx.company.id, itemId))) {
      ctx.sendJson(400, { error: 'inventory_item_id not found for company' })
      return true
    }
    const fromLocationId = optionalString(body.from_location_id)
    const toLocationId = optionalString(body.to_location_id)
    if (!(await existsInCompany(ctx.pool, 'inventory_locations', ctx.company.id, fromLocationId))) {
      ctx.sendJson(400, { error: 'from_location_id not found for company' })
      return true
    }
    if (!(await existsInCompany(ctx.pool, 'inventory_locations', ctx.company.id, toLocationId))) {
      ctx.sendJson(400, { error: 'to_location_id not found for company' })
      return true
    }
    const projectId = optionalString(body.project_id)
    if (projectId && !(await existsInCompany(ctx.pool, 'projects', ctx.company.id, projectId))) {
      ctx.sendJson(400, { error: 'project_id not found for company' })
      return true
    }
    const occurredOn = optionalString(body.occurred_on) ?? todayISO()
    if (!isValidDateInput(occurredOn)) {
      ctx.sendJson(400, { error: 'occurred_on must be YYYY-MM-DD' })
      return true
    }

    // Phase 4 scan dispatch context — all optional. When the worker
    // app POSTs from rnt-scan-dispatch it stamps worker_id (looked up
    // from the auth context if not supplied), the raw QR/barcode
    // payload, and the device geolocation so the audit trail can show
    // "Mike scanned cup-lock at 8:42a near 165 Front St."
    const workerId = optionalString(body.worker_id)
    if (workerId && !(await existsInCompany(ctx.pool, 'workers', ctx.company.id, workerId))) {
      ctx.sendJson(400, { error: 'worker_id not found for company' })
      return true
    }
    const scanPayload = optionalString(body.scan_payload)
    const scannedAtRaw = optionalString(body.scanned_at)
    const scannedAt = scannedAtRaw && !Number.isNaN(Date.parse(scannedAtRaw)) ? scannedAtRaw : null
    const lat = body.lat === undefined ? null : Number(body.lat)
    const lng = body.lng === undefined ? null : Number(body.lng)
    if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
      ctx.sendJson(400, { error: 'lat must be between -90 and 90' })
      return true
    }
    if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
      ctx.sendJson(400, { error: 'lng must be between -180 and 180' })
      return true
    }

    // Workers may only POST scan-driven movements — no manual yard
    // adjustments. The scan_payload + worker_id pair is the audit
    // trail; without them the worker should be using fm-rentals
    // through their foreman. The cast is needed because CompanyRole
    // doesn't yet include 'worker' as a value — the role table will
    // gain it when worker-direct auth lands; the gate stays in place
    // so the contract is documented.
    if ((ctx.company.role as string) === 'worker' && (!scanPayload || !workerId)) {
      ctx.sendJson(403, { error: 'workers may only create scan-driven movements (scan_payload + worker_id required)' })
      return true
    }

    const movement = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<InventoryMovementRow>(
        `
        insert into inventory_movements (
          company_id, inventory_item_id, from_location_id, to_location_id,
          project_id, movement_type, quantity, occurred_on, ticket_number, notes,
          worker_id, clerk_user_id, scan_payload, scanned_at, lat, lng
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13, $14, $15, $16)
        returning ${INVENTORY_MOVEMENT_COLUMNS}
        `,
        [
          ctx.company.id,
          itemId,
          fromLocationId,
          toLocationId,
          projectId,
          normalizeEnum(body.movement_type, MOVEMENT_TYPES, 'adjustment'),
          quantity,
          occurredOn,
          optionalString(body.ticket_number),
          optionalString(body.notes),
          workerId,
          // The clerk user is implied by auth — we always stamp who hit
          // the endpoint (whether or not a worker_id was attached).
          scanPayload || scannedAt || workerId ? ctx.currentUserId : null,
          scanPayload,
          scannedAt,
          lat,
          lng,
        ],
      )
      const row = result.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'inventory_movement',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, movement)
    return true
  }

  return false
}
