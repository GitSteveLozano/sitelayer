import type { Pool, PoolClient } from 'pg'
import type {
  RentalBillingHumanEventType,
  RentalBillingWorkflowSnapshot,
  RentalBillingWorkflowState,
  WorkflowSnapshot,
} from '@sitelayer/workflows'
import type { JobRentalContractForBilling, JobRentalLineForBilling } from '@sitelayer/domain'
import { nextRentalBillingEvents } from '@sitelayer/workflows'
import type { ActiveCompany } from '../auth-types.js'

/**
 * Route context shared across the rental-inventory split modules. This is the
 * exact shape the original `handleRentalInventoryRoutes` consumed, so the
 * split modules stay drop-in compatible with `apps/api/src/server.ts`.
 */
export type RentalInventoryRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

export type DbExecutor = Pick<Pool | PoolClient, 'query'>

export type InventoryItemRow = {
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

export type InventoryLocationRow = {
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

export type InventoryMovementRow = {
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

export type JobRentalContractRow = {
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

export type JobRentalLineRow = {
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

export type RentalBillingRunRow = {
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

export type RentalBillingRunLineRow = {
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

export type RentalBillingWorkflowContext = {
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

// ---------------------------------------------------------------------------
// SQL column constants. Centralized here because multiple split modules need
// to project the same shape (e.g. CRUD inserts and the workflow GET both
// project `RENTAL_BILLING_RUN_COLUMNS`).
// ---------------------------------------------------------------------------

export const INVENTORY_ITEM_COLUMNS = `
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

export const INVENTORY_LOCATION_COLUMNS = `
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

export const INVENTORY_MOVEMENT_COLUMNS = `
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

export const JOB_RENTAL_CONTRACT_COLUMNS = `
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

export const JOB_RENTAL_LINE_COLUMNS = `
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

export const RENTAL_BILLING_RUN_COLUMNS = `
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

export const RENTAL_BILLING_RUN_LINE_COLUMNS = `
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

// Enum allow-lists shared by CRUD + CSV import paths.
export const RATE_UNITS = new Set(['day', 'cycle', 'week', 'month', 'each'])
export const TRACKING_MODES = new Set(['quantity', 'serialized'])
export const LOCATION_TYPES = new Set(['yard', 'job', 'in_transit', 'repair', 'lost', 'damaged'])
export const MOVEMENT_TYPES = new Set(['deliver', 'return', 'transfer', 'adjustment', 'damaged', 'lost', 'repair'])

// ---------------------------------------------------------------------------
// Generic helpers (input parsing + lightweight company-scoped existence
// checks). Pure / stateless — safe to share across split modules.
// ---------------------------------------------------------------------------

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

export function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text ? text : null
}

export function parseNumber(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export function parsePositiveNumber(value: unknown): number | null {
  const parsed = parseNumber(value, Number.NaN)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = parseNumber(value, fallback)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : Number.NaN
}

export function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  const text = String(value ?? fallback)
    .trim()
    .toLowerCase()
  return allowed.has(text) ? text : fallback
}

export async function existsInCompany(
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

export async function loadProject(
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

export async function loadContractBillingData(
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

export async function selectJobRentalLineById(
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

export function toBillingContract(row: JobRentalContractRow): JobRentalContractForBilling {
  return {
    billing_cycle_days: row.billing_cycle_days,
    billing_start_date: row.billing_start_date,
    last_billed_through: row.last_billed_through,
    next_billing_date: row.next_billing_date,
  }
}

export function toBillingLine(row: JobRentalLineRow): JobRentalLineForBilling {
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

export function billingRunRowToSnapshot(row: RentalBillingRunRow): RentalBillingWorkflowSnapshot {
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

export function billingRunWorkflowSnapshotResponse(
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
