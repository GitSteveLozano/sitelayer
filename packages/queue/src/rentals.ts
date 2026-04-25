import { calculateRentalInvoice } from '@sitelayer/domain'
import type { QueueClient } from './index.js'

export interface RentalRow {
  id: string
  company_id: string
  project_id: string | null
  customer_id: string | null
  item_description: string
  daily_rate: string
  delivered_on: string
  returned_on: string | null
  next_invoice_at: string | null
  invoice_cadence_days: number
  last_invoice_amount: string | null
  last_invoiced_through: string | null
  status: string
  notes: string | null
  version: number
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface RentalMaterialBillRow {
  id: string
  project_id: string | null
  vendor_name: string
  amount: string
  bill_type: string
  description: string | null
  occurred_on: string | null
  created_at: string
}

export interface ProcessRentalInvoiceResult {
  /** The resulting material_bills row. Null when nothing was billed. */
  bill: RentalMaterialBillRow | null
  /** The rental row after status/next_invoice updates. */
  rental: RentalRow
  /** Days billed (zero when nothing fired). */
  days: number
  /** Billed amount in dollars. */
  amount: number
  /** Period end date (YYYY-MM-DD) billed through. */
  invoiced_through: string
  /** Period start date (YYYY-MM-DD) billed from. */
  period_start: string
}

export const RENTAL_SELECT_COLUMNS = `
  id,
  company_id,
  project_id,
  customer_id,
  item_description,
  daily_rate,
  to_char(delivered_on, 'YYYY-MM-DD') as delivered_on,
  to_char(returned_on, 'YYYY-MM-DD') as returned_on,
  next_invoice_at,
  invoice_cadence_days,
  last_invoice_amount,
  to_char(last_invoiced_through, 'YYYY-MM-DD') as last_invoiced_through,
  status,
  notes,
  version,
  deleted_at,
  created_at,
  updated_at
`

/**
 * Turn one rental row into a material_bills row of `bill_type='rental'` and
 * advance the rental's billing clock. Pure DB work — no HTTP, no Sentry, no
 * outbox — so the caller controls transactionality and side effects
 * (audit/outbox/sync_events).
 *
 * When the rental has no `project_id` linkage we skip the material_bill
 * insert (there's nowhere to attach the cost), but we still advance the
 * clock so the row doesn't get re-selected forever.
 */
export async function processRentalInvoice(
  client: QueueClient,
  rental: RentalRow,
  referenceDate: string = new Date().toISOString().slice(0, 10),
): Promise<ProcessRentalInvoiceResult> {
  const result = calculateRentalInvoice(
    {
      daily_rate: rental.daily_rate,
      delivered_on: rental.delivered_on,
      returned_on: rental.returned_on,
      invoice_cadence_days: rental.invoice_cadence_days,
      last_invoiced_through: rental.last_invoiced_through,
    },
    referenceDate,
  )

  if (result.days <= 0 || result.amount <= 0) {
    const updated = await client.query<RentalRow>(
      `
      update rentals
      set next_invoice_at = $3,
          status = $4,
          updated_at = now(),
          version = version + 1
      where company_id = $1 and id = $2
      returning ${RENTAL_SELECT_COLUMNS}
      `,
      [rental.company_id, rental.id, result.next_invoice_at, result.next_status],
    )
    return {
      bill: null,
      rental: updated.rows[0] ?? rental,
      days: 0,
      amount: 0,
      invoiced_through: result.invoiced_through,
      period_start: result.period_start,
    }
  }

  let billRow: RentalMaterialBillRow | null = null
  if (rental.project_id) {
    const description = `Rental: ${rental.item_description} (${result.period_start} → ${result.period_end}, ${result.days} day${
      result.days === 1 ? '' : 's'
    } @ ${Number(rental.daily_rate).toFixed(2)}/day)`
    const billResult = await client.query<RentalMaterialBillRow>(
      `
      insert into material_bills (company_id, project_id, vendor_name, amount, bill_type, description, occurred_on)
      values ($1, $2, $3, $4, 'rental', $5, $6::date)
      returning id, project_id, vendor_name, amount, bill_type, description, to_char(occurred_on, 'YYYY-MM-DD') as occurred_on, created_at
      `,
      [
        rental.company_id,
        rental.project_id,
        `Rental: ${rental.item_description}`,
        result.amount,
        description,
        result.period_end,
      ],
    )
    billRow = billResult.rows[0] ?? null
  }

  const updated = await client.query<RentalRow>(
    `
    update rentals
    set last_invoice_amount = $3,
        last_invoiced_through = $4::date,
        next_invoice_at = $5,
        status = $6,
        updated_at = now(),
        version = version + 1
    where company_id = $1 and id = $2
    returning ${RENTAL_SELECT_COLUMNS}
    `,
    [rental.company_id, rental.id, result.amount, result.invoiced_through, result.next_invoice_at, result.next_status],
  )

  return {
    bill: billRow,
    rental: updated.rows[0] ?? rental,
    days: result.days,
    amount: result.amount,
    invoiced_through: result.invoiced_through,
    period_start: result.period_start,
  }
}

/**
 * Fetch up to `limit` rentals whose next invoice tick has passed. The worker
 * uses this each heartbeat; the per-row cap keeps a runaway loop from
 * nuking a shift's audit log.
 */
export async function fetchDueRentals(client: QueueClient, companyId: string, limit = 50): Promise<RentalRow[]> {
  const result = await client.query<RentalRow>(
    `
    select ${RENTAL_SELECT_COLUMNS}
    from rentals
    where company_id = $1
      and deleted_at is null
      and status in ('active', 'returned')
      and next_invoice_at is not null
      and next_invoice_at <= now()
    order by next_invoice_at asc
    limit $2
    `,
    [companyId, Math.max(1, Math.min(500, Math.floor(limit)))],
  )
  return result.rows
}
