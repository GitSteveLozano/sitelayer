import type http from 'node:http'
import type { PoolClient } from 'pg'
import { calculateJobRentalBillingRun, initialJobRentalNextBillingDate } from '@sitelayer/domain'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidDateInput, parseExpectedVersion } from '../http-utils.js'
import {
  JOB_RENTAL_CONTRACT_COLUMNS,
  JOB_RENTAL_LINE_COLUMNS,
  RATE_UNITS,
  RENTAL_BILLING_RUN_COLUMNS,
  RENTAL_BILLING_RUN_LINE_COLUMNS,
  existsInCompany,
  loadContractBillingData,
  loadProject,
  normalizeEnum,
  optionalString,
  parseNonNegativeNumber,
  parseNumber,
  parsePositiveNumber,
  selectJobRentalLineById,
  toBillingContract,
  toBillingLine,
  todayISO,
  type JobRentalContractRow,
  type JobRentalLineRow,
  type RentalBillingRunLineRow,
  type RentalBillingRunRow,
  type RentalInventoryRouteCtx,
} from './rental-inventory.types.js'

/**
 * Handle the rental contract CRUD surface — contracts, contract lines, and
 * the "generate next billing run" path that materializes a `rental_billing_run`
 * row plus its lines from the current contract state. The workflow surface
 * for transitioning that row (`approve`, `post_requested`, `void`, etc.) lives
 * in `rental-billing-state.ts`.
 *
 * Routes:
 * - GET    /api/projects/:id/rental-contracts             — list per project
 * - POST   /api/projects/:id/rental-contracts             — create contract
 * - PATCH  /api/rental-contracts/:id                      — versioned update
 * - GET    /api/rental-contracts/:id/lines                — list contract lines
 * - POST   /api/rental-contracts/:id/lines                — add line
 * - PATCH  /api/rental-contract-lines/:id                 — versioned update
 * - DELETE /api/rental-contract-lines/:id                 — versioned soft-delete
 * - POST   /api/rental-contracts/:id/billing-runs/preview — dry-run calc
 * - GET    /api/rental-contracts/:id/billing-runs         — list runs
 * - POST   /api/rental-contracts/:id/billing-runs         — create billing run
 */
export async function handleRentalContractsCrudRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalInventoryRouteCtx,
): Promise<boolean> {
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

  return false
}
