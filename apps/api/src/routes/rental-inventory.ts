import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  calculateJobRentalBillingRun,
  initialJobRentalNextBillingDate,
  isHumanRentalBillingEvent,
  nextRentalBillingEvents,
  transitionRentalBillingWorkflow,
  type JobRentalContractForBilling,
  type JobRentalLineForBilling,
  type RentalBillingHumanEventType,
  type RentalBillingWorkflowEvent,
  type RentalBillingWorkflowSnapshot,
  type RentalBillingWorkflowState,
  type WorkflowSnapshot,
} from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { observeAudit } from '../metrics.js'
import { isValidDateInput, parseExpectedVersion } from '../http-utils.js'

export type RentalInventoryRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

type DbExecutor = Pick<Pool | PoolClient, 'query'>

type InventoryItemRow = {
  id: string
  company_id: string
  code: string
  description: string
  category: string
  unit: string
  default_rental_rate: string
  replacement_value: string | null
  tracking_mode: string
  active: boolean
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type InventoryLocationRow = {
  id: string
  company_id: string
  project_id: string | null
  name: string
  location_type: string
  is_default: boolean
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type InventoryMovementRow = {
  id: string
  company_id: string
  inventory_item_id: string
  from_location_id: string | null
  to_location_id: string | null
  project_id: string | null
  movement_type: string
  quantity: string
  occurred_on: string
  ticket_number: string | null
  notes: string | null
  version: number
  created_at: string
}

type JobRentalContractRow = {
  id: string
  company_id: string
  project_id: string
  customer_id: string | null
  billing_cycle_days: number
  billing_mode: string
  billing_start_date: string
  last_billed_through: string | null
  next_billing_date: string
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type JobRentalLineRow = {
  id: string
  company_id: string
  contract_id: string
  inventory_item_id: string
  item_code: string | null
  item_description: string | null
  quantity: string
  agreed_rate: string
  rate_unit: string
  on_rent_date: string
  off_rent_date: string | null
  last_billed_through: string | null
  billable: boolean
  taxable: boolean
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type RentalBillingRunRow = {
  id: string
  company_id: string
  contract_id: string
  project_id: string
  customer_id: string | null
  period_start: string
  period_end: string
  status: string
  state_version: number
  subtotal: string
  qbo_invoice_id: string | null
  approved_at: string | null
  approved_by: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

type RentalBillingRunLineRow = {
  id: string
  company_id: string
  billing_run_id: string
  contract_line_id: string
  inventory_item_id: string
  quantity: string
  agreed_rate: string
  rate_unit: string
  billable_days: number
  period_start: string
  period_end: string
  amount: string
  taxable: boolean
  description: string | null
  created_at: string
}

const INVENTORY_ITEM_COLUMNS = `
  id,
  company_id,
  code,
  description,
  category,
  unit,
  default_rental_rate,
  replacement_value,
  tracking_mode,
  active,
  notes,
  version,
  deleted_at,
  created_at,
  updated_at
`

const INVENTORY_LOCATION_COLUMNS = `
  id,
  company_id,
  project_id,
  name,
  location_type,
  is_default,
  version,
  deleted_at,
  created_at,
  updated_at
`

const INVENTORY_MOVEMENT_COLUMNS = `
  id,
  company_id,
  inventory_item_id,
  from_location_id,
  to_location_id,
  project_id,
  movement_type,
  quantity,
  to_char(occurred_on, 'YYYY-MM-DD') as occurred_on,
  ticket_number,
  notes,
  version,
  created_at
`

const JOB_RENTAL_CONTRACT_COLUMNS = `
  id,
  company_id,
  project_id,
  customer_id,
  billing_cycle_days,
  billing_mode,
  to_char(billing_start_date, 'YYYY-MM-DD') as billing_start_date,
  to_char(last_billed_through, 'YYYY-MM-DD') as last_billed_through,
  to_char(next_billing_date, 'YYYY-MM-DD') as next_billing_date,
  status,
  notes,
  version,
  deleted_at,
  created_at,
  updated_at
`

const JOB_RENTAL_LINE_COLUMNS = `
  l.id,
  l.company_id,
  l.contract_id,
  l.inventory_item_id,
  i.code as item_code,
  i.description as item_description,
  l.quantity,
  l.agreed_rate,
  l.rate_unit,
  to_char(l.on_rent_date, 'YYYY-MM-DD') as on_rent_date,
  to_char(l.off_rent_date, 'YYYY-MM-DD') as off_rent_date,
  to_char(l.last_billed_through, 'YYYY-MM-DD') as last_billed_through,
  l.billable,
  l.taxable,
  l.status,
  l.notes,
  l.version,
  l.deleted_at,
  l.created_at,
  l.updated_at
`

const RENTAL_BILLING_RUN_COLUMNS = `
  id,
  company_id,
  contract_id,
  project_id,
  customer_id,
  to_char(period_start, 'YYYY-MM-DD') as period_start,
  to_char(period_end, 'YYYY-MM-DD') as period_end,
  status,
  state_version,
  subtotal,
  qbo_invoice_id,
  approved_at,
  approved_by,
  posted_at,
  failed_at,
  error,
  workflow_engine,
  workflow_run_id,
  version,
  deleted_at,
  created_at,
  updated_at
`

const RENTAL_BILLING_RUN_LINE_COLUMNS = `
  id,
  company_id,
  billing_run_id,
  contract_line_id,
  inventory_item_id,
  quantity,
  agreed_rate,
  rate_unit,
  billable_days,
  to_char(period_start, 'YYYY-MM-DD') as period_start,
  to_char(period_end, 'YYYY-MM-DD') as period_end,
  amount,
  taxable,
  description,
  created_at
`

function billingRunRowToSnapshot(row: RentalBillingRunRow): RentalBillingWorkflowSnapshot {
  return {
    state: row.status as RentalBillingWorkflowState,
    state_version: row.state_version,
    approved_at: row.approved_at,
    approved_by: row.approved_by,
    posted_at: row.posted_at,
    failed_at: row.failed_at,
    error: row.error,
    qbo_invoice_id: row.qbo_invoice_id,
  }
}

type RentalBillingWorkflowContext = {
  id: string
  company_id: string
  contract_id: string
  project_id: string
  customer_id: string | null
  period_start: string
  period_end: string
  subtotal: string
  qbo_invoice_id: string | null
  approved_at: string | null
  approved_by: string | null
  posted_at: string | null
  failed_at: string | null
  error: string | null
  workflow_engine: string
  workflow_run_id: string | null
  created_at: string
  updated_at: string
  lines: RentalBillingRunLineRow[]
}

function billingRunWorkflowSnapshotResponse(
  row: RentalBillingRunRow,
  lines: RentalBillingRunLineRow[],
): WorkflowSnapshot<RentalBillingWorkflowState, RentalBillingHumanEventType, RentalBillingWorkflowContext> {
  return {
    state: row.status as RentalBillingWorkflowState,
    state_version: row.state_version,
    context: {
      id: row.id,
      company_id: row.company_id,
      contract_id: row.contract_id,
      project_id: row.project_id,
      customer_id: row.customer_id,
      period_start: row.period_start,
      period_end: row.period_end,
      subtotal: row.subtotal,
      qbo_invoice_id: row.qbo_invoice_id,
      approved_at: row.approved_at,
      approved_by: row.approved_by,
      posted_at: row.posted_at,
      failed_at: row.failed_at,
      error: row.error,
      workflow_engine: row.workflow_engine,
      workflow_run_id: row.workflow_run_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      lines,
    },
    next_events: nextRentalBillingEvents(row.status as RentalBillingWorkflowState),
  }
}

const RATE_UNITS = new Set(['day', 'cycle', 'week', 'month', 'each'])
const TRACKING_MODES = new Set(['quantity', 'serialized'])
const LOCATION_TYPES = new Set(['yard', 'job', 'in_transit', 'repair', 'lost', 'damaged'])
const MOVEMENT_TYPES = new Set(['deliver', 'return', 'transfer', 'adjustment', 'damaged', 'lost', 'repair'])

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text ? text : null
}

function parseNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function parsePositiveNumber(value: unknown): number | null {
  const parsed = parseNumber(value, Number.NaN)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = parseNumber(value, fallback)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN
}

function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  const text = String(value ?? fallback)
    .trim()
    .toLowerCase()
  return allowed.has(text) ? text : fallback
}

async function existsInCompany(
  executor: DbExecutor,
  table: string,
  companyId: string,
  id: string | null,
): Promise<boolean> {
  if (!id) return true
  const result = await executor.query(`select 1 from ${table} where company_id = $1 and id = $2 limit 1`, [
    companyId,
    id,
  ])
  return Boolean(result.rows[0])
}

async function loadProject(
  executor: DbExecutor,
  companyId: string,
  projectId: string,
): Promise<{ id: string; customer_id: string | null } | null> {
  const result = await executor.query<{ id: string; customer_id: string | null }>(
    `select id, customer_id from projects where company_id = $1 and id = $2 and deleted_at is null`,
    [companyId, projectId],
  )
  return result.rows[0] ?? null
}

async function loadContractBillingData(
  executor: DbExecutor,
  companyId: string,
  contractId: string,
): Promise<{ contract: JobRentalContractRow | null; lines: JobRentalLineRow[] }> {
  const contractResult = await executor.query<JobRentalContractRow>(
    `select ${JOB_RENTAL_CONTRACT_COLUMNS} from job_rental_contracts where company_id = $1 and id = $2 and deleted_at is null`,
    [companyId, contractId],
  )
  const contract = contractResult.rows[0] ?? null
  if (!contract) return { contract: null, lines: [] }

  const lineResult = await executor.query<JobRentalLineRow>(
    `
    select ${JOB_RENTAL_LINE_COLUMNS}
    from job_rental_lines l
    join inventory_items i on i.company_id = l.company_id and i.id = l.inventory_item_id
    where l.company_id = $1 and l.contract_id = $2 and l.deleted_at is null
    order by l.created_at asc
    `,
    [companyId, contractId],
  )
  return { contract, lines: lineResult.rows }
}

async function selectJobRentalLineById(
  executor: DbExecutor,
  companyId: string,
  lineId: string,
): Promise<JobRentalLineRow | null> {
  const result = await executor.query<JobRentalLineRow>(
    `
    select ${JOB_RENTAL_LINE_COLUMNS}
    from job_rental_lines l
    join inventory_items i on i.company_id = l.company_id and i.id = l.inventory_item_id
    where l.company_id = $1 and l.id = $2
    `,
    [companyId, lineId],
  )
  return result.rows[0] ?? null
}

function toBillingContract(row: JobRentalContractRow): JobRentalContractForBilling {
  return {
    billing_cycle_days: row.billing_cycle_days,
    billing_start_date: row.billing_start_date,
    last_billed_through: row.last_billed_through,
    next_billing_date: row.next_billing_date,
  }
}

function toBillingLine(row: JobRentalLineRow): JobRentalLineForBilling {
  return {
    id: row.id,
    inventory_item_id: row.inventory_item_id,
    item_code: row.item_code,
    item_description: row.item_description,
    quantity: row.quantity,
    agreed_rate: row.agreed_rate,
    rate_unit: row.rate_unit,
    on_rent_date: row.on_rent_date,
    off_rent_date: row.off_rent_date,
    last_billed_through: row.last_billed_through,
    billable: row.billable,
    taxable: row.taxable,
    status: row.status,
  }
}

export async function handleRentalInventoryRoutes(
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
    const clauses = ['company_id = $1']
    const itemId = url.searchParams.get('item_id')
    const projectId = url.searchParams.get('project_id')
    if (itemId) {
      values.push(itemId)
      clauses.push(`inventory_item_id = $${values.length}`)
    }
    if (projectId) {
      values.push(projectId)
      clauses.push(`project_id = $${values.length}`)
    }
    const result = await ctx.pool.query<InventoryMovementRow>(
      `
      select ${INVENTORY_MOVEMENT_COLUMNS}
      from inventory_movements
      where ${clauses.join(' and ')}
      order by occurred_on desc, created_at desc
      limit 500
      `,
      values,
    )
    ctx.sendJson(200, { inventoryMovements: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/inventory/movements') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
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
    const movement = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<InventoryMovementRow>(
        `
        insert into inventory_movements (
          company_id, inventory_item_id, from_location_id, to_location_id,
          project_id, movement_type, quantity, occurred_on, ticket_number, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10)
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

  if (req.method === 'GET' && url.pathname.match(/^\/api\/projects\/[^/]+\/rental-contracts$/)) {
    const projectId = url.pathname.split('/')[3] ?? ''
    const result = await ctx.pool.query<JobRentalContractRow>(
      `
      select ${JOB_RENTAL_CONTRACT_COLUMNS}
      from job_rental_contracts
      where company_id = $1 and project_id = $2 and deleted_at is null
      order by created_at desc
      `,
      [ctx.company.id, projectId],
    )
    ctx.sendJson(200, { rentalContracts: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/projects\/[^/]+\/rental-contracts$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = url.pathname.split('/')[3] ?? ''
    const body = await ctx.readBody()
    const project = await loadProject(ctx.pool, ctx.company.id, projectId)
    if (!project) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    const billingStartDate = optionalString(body.billing_start_date) ?? todayISO()
    if (!isValidDateInput(billingStartDate)) {
      ctx.sendJson(400, { error: 'billing_start_date must be YYYY-MM-DD' })
      return true
    }
    const cycleDays = Math.max(1, Math.floor(parseNumber(body.billing_cycle_days, 25) || 25))
    const customerId = optionalString(body.customer_id) ?? project.customer_id
    if (customerId && !(await existsInCompany(ctx.pool, 'customers', ctx.company.id, customerId))) {
      ctx.sendJson(400, { error: 'customer_id not found for company' })
      return true
    }
    const contract = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<JobRentalContractRow>(
        `
        insert into job_rental_contracts (
          company_id, project_id, customer_id, billing_cycle_days, billing_mode,
          billing_start_date, next_billing_date, status, notes
        )
        values ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9)
        returning ${JOB_RENTAL_CONTRACT_COLUMNS}
        `,
        [
          ctx.company.id,
          projectId,
          customerId,
          cycleDays,
          optionalString(body.billing_mode) ?? 'arrears',
          billingStartDate,
          initialJobRentalNextBillingDate(billingStartDate, cycleDays),
          optionalString(body.status) ?? 'active',
          optionalString(body.notes),
        ],
      )
      const row = result.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'job_rental_contract',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, contract)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/rental-contracts\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const contractId = url.pathname.split('/')[3] ?? ''
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    if (body.billing_start_date !== undefined && !isValidDateInput(body.billing_start_date)) {
      ctx.sendJson(400, { error: 'billing_start_date must be YYYY-MM-DD' })
      return true
    }
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<JobRentalContractRow>(
        `
        update job_rental_contracts
        set
          customer_id = coalesce($3, customer_id),
          billing_cycle_days = coalesce($4, billing_cycle_days),
          billing_mode = coalesce($5, billing_mode),
          billing_start_date = coalesce($6::date, billing_start_date),
          next_billing_date = coalesce($7::date, next_billing_date),
          status = coalesce($8, status),
          notes = coalesce($9, notes),
          version = version + 1,
          updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null
          and ($10::int is null or version = $10)
        returning ${JOB_RENTAL_CONTRACT_COLUMNS}
        `,
        [
          ctx.company.id,
          contractId,
          body.customer_id ?? null,
          body.billing_cycle_days ?? null,
          optionalString(body.billing_mode),
          body.billing_start_date ?? null,
          body.next_billing_date ?? null,
          optionalString(body.status),
          optionalString(body.notes),
          expectedVersion,
        ],
      )
      const row = result.rows[0]
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'job_rental_contract',
        entityId: contractId,
        action: 'update',
        row,
        idempotencyKey: `job_rental_contract:update:${contractId}:${row.version}`,
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'job_rental_contracts',
          'company_id = $1 and id = $2',
          [ctx.company.id, contractId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'rental contract not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/rental-contracts\/[^/]+\/lines$/)) {
    const contractId = url.pathname.split('/')[3] ?? ''
    const result = await ctx.pool.query<JobRentalLineRow>(
      `
      select ${JOB_RENTAL_LINE_COLUMNS}
      from job_rental_lines l
      join inventory_items i on i.company_id = l.company_id and i.id = l.inventory_item_id
      where l.company_id = $1 and l.contract_id = $2 and l.deleted_at is null
      order by l.created_at asc
      `,
      [ctx.company.id, contractId],
    )
    ctx.sendJson(200, { rentalLines: result.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/rental-contracts\/[^/]+\/lines$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const contractId = url.pathname.split('/')[3] ?? ''
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
    const contractResult = await ctx.pool.query<JobRentalContractRow>(
      `select ${JOB_RENTAL_CONTRACT_COLUMNS} from job_rental_contracts where company_id = $1 and id = $2 and deleted_at is null`,
      [ctx.company.id, contractId],
    )
    const contract = contractResult.rows[0]
    if (!contract) {
      ctx.sendJson(404, { error: 'rental contract not found' })
      return true
    }
    const agreedRate = parseNonNegativeNumber(body.agreed_rate, 0)
    if (!Number.isFinite(agreedRate)) {
      ctx.sendJson(400, { error: 'agreed_rate must be a non-negative number' })
      return true
    }
    const onRentDate = optionalString(body.on_rent_date) ?? contract.billing_start_date
    if (!isValidDateInput(onRentDate)) {
      ctx.sendJson(400, { error: 'on_rent_date must be YYYY-MM-DD' })
      return true
    }
    if (body.off_rent_date && !isValidDateInput(body.off_rent_date)) {
      ctx.sendJson(400, { error: 'off_rent_date must be YYYY-MM-DD' })
      return true
    }
    const line = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{ id: string }>(
        `
        insert into job_rental_lines (
          company_id, contract_id, inventory_item_id, quantity, agreed_rate,
          rate_unit, on_rent_date, off_rent_date, billable, taxable, status, notes
        )
        values ($1, $2, $3, $4, $5, $6, $7::date, $8::date, coalesce($9, true), coalesce($10, true), $11, $12)
        returning id
        `,
        [
          ctx.company.id,
          contractId,
          itemId,
          quantity,
          agreedRate,
          normalizeEnum(body.rate_unit, RATE_UNITS, 'cycle'),
          onRentDate,
          body.off_rent_date ?? null,
          body.billable ?? true,
          body.taxable ?? true,
          optionalString(body.status) ?? 'active',
          optionalString(body.notes),
        ],
      )
      const rowId = result.rows[0]!.id
      const row = await selectJobRentalLineById(client, ctx.company.id, rowId)
      if (!row) throw new Error('inserted rental line not found')
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'job_rental_line',
        entityId: row.id,
        action: 'create',
        row,
      })
      return row
    })
    ctx.sendJson(201, line)
    return true
  }

  if (req.method === 'PATCH' && url.pathname.match(/^\/api\/rental-contract-lines\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const lineId = url.pathname.split('/')[3] ?? ''
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const updated = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{ id: string }>(
        `
        update job_rental_lines
        set
          quantity = coalesce($3, quantity),
          agreed_rate = coalesce($4, agreed_rate),
          rate_unit = coalesce($5, rate_unit),
          on_rent_date = coalesce($6::date, on_rent_date),
          off_rent_date = case when $7::text = '__clear__' then null
                               when $7::text is null then off_rent_date
                               else $7::date end,
          billable = coalesce($8, billable),
          taxable = coalesce($9, taxable),
          status = coalesce($10, status),
          notes = coalesce($11, notes),
          version = version + 1,
          updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null
          and ($12::int is null or version = $12)
        returning id
        `,
        [
          ctx.company.id,
          lineId,
          body.quantity ?? null,
          body.agreed_rate ?? null,
          body.rate_unit ? normalizeEnum(body.rate_unit, RATE_UNITS, 'cycle') : null,
          body.on_rent_date ?? null,
          body.off_rent_date === null ? '__clear__' : (body.off_rent_date ?? null),
          body.billable ?? null,
          body.taxable ?? null,
          optionalString(body.status),
          optionalString(body.notes),
          expectedVersion,
        ],
      )
      const rowId = result.rows[0]?.id
      if (!rowId) return null
      const row = await selectJobRentalLineById(client, ctx.company.id, rowId)
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'job_rental_line',
        entityId: lineId,
        action: 'update',
        row,
        idempotencyKey: `job_rental_line:update:${lineId}:${row.version}`,
      })
      return row
    })
    if (!updated) {
      if (
        !(await ctx.checkVersion(
          'job_rental_lines',
          'company_id = $1 and id = $2',
          [ctx.company.id, lineId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'rental line not found' })
      return true
    }
    ctx.sendJson(200, updated)
    return true
  }

  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/rental-contract-lines\/[^/]+$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const lineId = url.pathname.split('/')[3] ?? ''
    const body = await ctx.readBody()
    const expectedVersion = parseExpectedVersion(body.expected_version ?? body.version)
    const deleted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{ id: string }>(
        `
        update job_rental_lines
        set deleted_at = now(), status = 'deleted', version = version + 1, updated_at = now()
        where company_id = $1 and id = $2 and deleted_at is null
          and ($3::int is null or version = $3)
        returning id
        `,
        [ctx.company.id, lineId, expectedVersion],
      )
      const rowId = result.rows[0]?.id
      if (!rowId) return null
      const row = await selectJobRentalLineById(client, ctx.company.id, rowId)
      if (!row) return null
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'job_rental_line',
        entityId: lineId,
        action: 'delete',
        row,
      })
      return row
    })
    if (!deleted) {
      if (
        !(await ctx.checkVersion(
          'job_rental_lines',
          'company_id = $1 and id = $2',
          [ctx.company.id, lineId],
          expectedVersion,
        ))
      ) {
        return true
      }
      ctx.sendJson(404, { error: 'rental line not found' })
      return true
    }
    ctx.sendJson(200, deleted)
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/rental-contracts\/[^/]+\/billing-runs\/preview$/)) {
    const contractId = url.pathname.split('/')[3] ?? ''
    const body = await ctx.readBody()
    const referenceDate = optionalString(body.reference_date) ?? todayISO()
    if (!isValidDateInput(referenceDate)) {
      ctx.sendJson(400, { error: 'reference_date must be YYYY-MM-DD' })
      return true
    }
    const { contract, lines } = await loadContractBillingData(ctx.pool, ctx.company.id, contractId)
    if (!contract) {
      ctx.sendJson(404, { error: 'rental contract not found' })
      return true
    }
    const preview = calculateJobRentalBillingRun(toBillingContract(contract), lines.map(toBillingLine), referenceDate)
    ctx.sendJson(200, { contract, preview })
    return true
  }

  if (req.method === 'GET' && url.pathname.match(/^\/api\/rental-contracts\/[^/]+\/billing-runs$/)) {
    const contractId = url.pathname.split('/')[3] ?? ''
    const runs = await ctx.pool.query<RentalBillingRunRow>(
      `
      select ${RENTAL_BILLING_RUN_COLUMNS}
      from rental_billing_runs
      where company_id = $1 and contract_id = $2 and deleted_at is null
      order by period_start desc
      `,
      [ctx.company.id, contractId],
    )
    ctx.sendJson(200, { billingRuns: runs.rows })
    return true
  }

  if (req.method === 'POST' && url.pathname.match(/^\/api\/rental-contracts\/[^/]+\/billing-runs$/)) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const contractId = url.pathname.split('/')[3] ?? ''
    const body = await ctx.readBody()
    const referenceDate = optionalString(body.reference_date) ?? todayISO()
    if (!isValidDateInput(referenceDate)) {
      ctx.sendJson(400, { error: 'reference_date must be YYYY-MM-DD' })
      return true
    }
    const current = await loadContractBillingData(ctx.pool, ctx.company.id, contractId)
    if (!current.contract) {
      ctx.sendJson(404, { error: 'rental contract not found' })
      return true
    }
    const preview = calculateJobRentalBillingRun(
      toBillingContract(current.contract),
      current.lines.map(toBillingLine),
      referenceDate,
    )
    if (!preview.is_due && body.force !== true) {
      ctx.sendJson(400, { error: 'billing run is not due yet', preview })
      return true
    }
    if (preview.lines.length === 0) {
      ctx.sendJson(400, { error: 'no billable rental lines for this period', preview })
      return true
    }
    const duplicate = await ctx.pool.query(
      `
      select 1 from rental_billing_runs
      where company_id = $1 and contract_id = $2 and period_start = $3::date and period_end = $4::date
        and deleted_at is null
      limit 1
      `,
      [ctx.company.id, contractId, preview.period_start, preview.period_end],
    )
    if (duplicate.rows[0]) {
      ctx.sendJson(409, { error: 'billing run already exists for this period', preview })
      return true
    }

    const created = await withMutationTx(async (client: PoolClient) => {
      const fresh = await loadContractBillingData(client, ctx.company.id, contractId)
      if (!fresh.contract) throw new Error('rental contract disappeared during billing run')
      const calculation = calculateJobRentalBillingRun(
        toBillingContract(fresh.contract),
        fresh.lines.map(toBillingLine),
        referenceDate,
      )
      const runResult = await client.query<RentalBillingRunRow>(
        `
        insert into rental_billing_runs (
          company_id, contract_id, project_id, customer_id, period_start, period_end, status, subtotal
        )
        values ($1, $2, $3, $4, $5::date, $6::date, 'generated', $7)
        returning ${RENTAL_BILLING_RUN_COLUMNS}
        `,
        [
          ctx.company.id,
          fresh.contract.id,
          fresh.contract.project_id,
          fresh.contract.customer_id,
          calculation.period_start,
          calculation.period_end,
          calculation.subtotal,
        ],
      )
      const run = runResult.rows[0]!
      const runLines: RentalBillingRunLineRow[] = []
      for (const line of calculation.lines) {
        if (!line.inventory_item_id) continue
        const inserted = await client.query<RentalBillingRunLineRow>(
          `
          insert into rental_billing_run_lines (
            company_id, billing_run_id, contract_line_id, inventory_item_id,
            quantity, agreed_rate, rate_unit, billable_days, period_start,
            period_end, amount, taxable, description
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11, $12, $13)
          returning ${RENTAL_BILLING_RUN_LINE_COLUMNS}
          `,
          [
            ctx.company.id,
            run.id,
            line.line_id,
            line.inventory_item_id,
            line.quantity,
            line.agreed_rate,
            line.rate_unit,
            line.billable_days,
            line.period_start,
            line.period_end,
            line.amount,
            line.taxable,
            line.description,
          ],
        )
        runLines.push(inserted.rows[0]!)
        await client.query(
          `
          update job_rental_lines
          set last_billed_through = $3::date, version = version + 1, updated_at = now()
          where company_id = $1 and id = $2
          `,
          [ctx.company.id, line.line_id, line.period_end],
        )
      }
      const contractUpdate = await client.query<JobRentalContractRow>(
        `
        update job_rental_contracts
        set last_billed_through = $3::date,
            next_billing_date = $4::date,
            version = version + 1,
            updated_at = now()
        where company_id = $1 and id = $2
        returning ${JOB_RENTAL_CONTRACT_COLUMNS}
        `,
        [ctx.company.id, fresh.contract.id, calculation.period_end, calculation.next_billing_date],
      )
      const contract = contractUpdate.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'rental_billing_run',
        entityId: run.id,
        action: 'create',
        row: { ...run, lines: runLines },
        syncPayload: { action: 'create', billingRun: run, lines: runLines },
      })
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'job_rental_contract',
        entityId: contract.id,
        action: 'bill',
        row: contract,
        idempotencyKey: `job_rental_contract:bill:${contract.id}:${contract.version}`,
      })
      return { billingRun: run, lines: runLines, contract, calculation }
    })
    ctx.sendJson(201, created)
    return true
  }

  // ---------------------------------------------------------------------------
  // Rental billing run workflow surface — see docs/DETERMINISTIC_WORKFLOWS.md.
  //
  // GET  /api/rental-billing-runs/:id          → WorkflowSnapshot
  // POST /api/rental-billing-runs/:id/events   → { event, stateVersion } applies
  //                                              the pure reducer in one tx.
  // ---------------------------------------------------------------------------

  const billingRunSnapshotMatch = url.pathname.match(/^\/api\/rental-billing-runs\/([^/]+)$/)
  if (req.method === 'GET' && billingRunSnapshotMatch) {
    const runId = billingRunSnapshotMatch[1]!
    const runResult = await ctx.pool.query<RentalBillingRunRow>(
      `select ${RENTAL_BILLING_RUN_COLUMNS}
       from rental_billing_runs
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
      [ctx.company.id, runId],
    )
    const run = runResult.rows[0]
    if (!run) {
      ctx.sendJson(404, { error: 'rental billing run not found' })
      return true
    }
    const linesResult = await ctx.pool.query<RentalBillingRunLineRow>(
      `select ${RENTAL_BILLING_RUN_LINE_COLUMNS}
       from rental_billing_run_lines
       where company_id = $1 and billing_run_id = $2
       order by created_at asc`,
      [ctx.company.id, runId],
    )
    ctx.sendJson(200, billingRunWorkflowSnapshotResponse(run, linesResult.rows))
    return true
  }

  const billingRunEventMatch = url.pathname.match(/^\/api\/rental-billing-runs\/([^/]+)\/events$/)
  if (req.method === 'POST' && billingRunEventMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const runId = billingRunEventMatch[1]!
    const body = await ctx.readBody()
    const eventType = optionalString(body.event)
    if (!eventType || !isHumanRentalBillingEvent(eventType)) {
      ctx.sendJson(400, {
        error: 'event must be one of APPROVE, POST_REQUESTED, RETRY_POST, VOID',
      })
      return true
    }
    const stateVersionRaw = body.state_version
    const stateVersion =
      typeof stateVersionRaw === 'number'
        ? stateVersionRaw
        : typeof stateVersionRaw === 'string'
          ? Number(stateVersionRaw)
          : Number.NaN
    if (!Number.isInteger(stateVersion) || stateVersion < 1) {
      ctx.sendJson(400, { error: 'state_version is required and must be a positive integer' })
      return true
    }

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const lockedResult = await client.query<RentalBillingRunRow>(
          `select ${RENTAL_BILLING_RUN_COLUMNS}
           from rental_billing_runs
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
          [ctx.company.id, runId],
        )
        const current = lockedResult.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.state_version !== stateVersion) {
          return { kind: 'version_conflict' as const, run: current }
        }

        const reducerEvent = buildReducerEvent(eventType as RentalBillingHumanEventType, ctx.currentUserId)
        let nextSnapshot: RentalBillingWorkflowSnapshot
        try {
          nextSnapshot = transitionRentalBillingWorkflow(billingRunRowToSnapshot(current), reducerEvent)
        } catch (err) {
          return {
            kind: 'illegal_transition' as const,
            run: current,
            message: err instanceof Error ? err.message : String(err),
          }
        }

        const updateResult = await client.query<RentalBillingRunRow>(
          `update rental_billing_runs
             set status = $3,
                 state_version = $4,
                 approved_at = $5,
                 approved_by = $6,
                 posted_at = $7,
                 failed_at = $8,
                 error = $9,
                 qbo_invoice_id = $10,
                 version = version + 1,
                 updated_at = now()
           where company_id = $1 and id = $2
           returning ${RENTAL_BILLING_RUN_COLUMNS}`,
          [
            ctx.company.id,
            runId,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.approved_at ?? null,
            nextSnapshot.approved_by ?? null,
            nextSnapshot.posted_at ?? null,
            nextSnapshot.failed_at ?? null,
            nextSnapshot.error ?? null,
            nextSnapshot.qbo_invoice_id ?? null,
          ],
        )
        const updated = updateResult.rows[0]!
        const linesResult = await client.query<RentalBillingRunLineRow>(
          `select ${RENTAL_BILLING_RUN_LINE_COLUMNS}
           from rental_billing_run_lines
           where company_id = $1 and billing_run_id = $2
           order by created_at asc`,
          [ctx.company.id, runId],
        )
        // Audit/event ledger row keyed on state_version so each transition
        // produces a distinct row (history-friendly).
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'rental_billing_run',
          entityId: updated.id,
          action: `event:${eventType.toLowerCase()}`,
          row: updated,
          idempotencyKey: `rental_billing_run:event:${updated.id}:${updated.state_version}`,
        })
        // POST_REQUESTED additionally enqueues a stable-keyed outbox row that
        // the worker QBO-push handler claims. The key is per-run (NOT per
        // state_version) so RETRY_POST → POST_REQUESTED replays the same key
        // and the row's `on conflict do update` resets it to pending without
        // creating duplicate work.
        if (eventType === 'POST_REQUESTED') {
          await recordMutationLedger(client, {
            companyId: ctx.company.id,
            entityType: 'rental_billing_run',
            entityId: updated.id,
            action: 'post_qbo_invoice',
            mutationType: 'post_qbo_invoice',
            row: updated,
            outboxPayload: {
              billing_run_id: updated.id,
              contract_id: updated.contract_id,
              project_id: updated.project_id,
              customer_id: updated.customer_id,
              period_start: updated.period_start,
              period_end: updated.period_end,
              subtotal: updated.subtotal,
              lines: linesResult.rows,
            },
            idempotencyKey: `rental_billing_run:post:${updated.id}`,
          })
        }
        return { kind: 'ok' as const, run: updated, lines: linesResult.rows, eventType }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'rental billing run not found' })
        return true
      }
      if (result.kind === 'version_conflict') {
        ctx.sendJson(409, {
          error: 'state_version mismatch — reload and retry',
          snapshot: billingRunWorkflowSnapshotResponse(result.run, []),
        })
        return true
      }
      if (result.kind === 'illegal_transition') {
        ctx.sendJson(409, {
          error: result.message,
          snapshot: billingRunWorkflowSnapshotResponse(result.run, []),
        })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'rental_billing_run',
        entityId: result.run.id,
        action: `event:${result.eventType.toLowerCase()}`,
        after: result.run,
      })
      observeAudit('rental_billing_run', `event:${result.eventType.toLowerCase()}`)
      ctx.sendJson(200, billingRunWorkflowSnapshotResponse(result.run, result.lines))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  return false
}

function buildReducerEvent(eventType: RentalBillingHumanEventType, actorUserId: string): RentalBillingWorkflowEvent {
  const nowIso = new Date().toISOString()
  if (eventType === 'APPROVE') {
    return { type: 'APPROVE', approved_at: nowIso, approved_by: actorUserId }
  }
  if (eventType === 'POST_REQUESTED') {
    return { type: 'POST_REQUESTED' }
  }
  if (eventType === 'RETRY_POST') {
    return { type: 'RETRY_POST' }
  }
  return { type: 'VOID' }
}
