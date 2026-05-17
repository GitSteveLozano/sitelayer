import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { fetchDueRentals, processRentalInvoice, recordLedger } from '@sitelayer/queue'
import { captureWithEntityContext } from '../instrument.js'
import { setCompanyGuc } from '../runner-utils.js'

// Cap per heartbeat so an accidentally-backdated rental (or an import that
// seeded 10 000 rows) can't stall the worker or flood the audit log in one
// tick.
const RENTAL_INVOICE_MAX_PER_HEARTBEAT = 50

export interface RentalInvoiceSummary {
  processed: number
  billed: number
  skipped: number
  amount: number
}

export function createRentalInvoiceRunner(deps: { pool: Pool; logger: Logger }) {
  const { pool, logger } = deps

  return async function drainRentalInvoices(companyId: string): Promise<RentalInvoiceSummary> {
    const client = await pool.connect()
    try {
      const due = await fetchDueRentals(client, companyId, RENTAL_INVOICE_MAX_PER_HEARTBEAT)
      if (due.length === 0) {
        return { processed: 0, billed: 0, skipped: 0, amount: 0 }
      }
      let billed = 0
      let skipped = 0
      let amount = 0
      for (const rental of due) {
        await client.query('begin')
        try {
          await setCompanyGuc(client, rental.company_id)
          const result = await processRentalInvoice(client, rental)
          // Mirror the API's POST /api/rentals/:id/invoke ledger writes so a
          // worker-billed rental still surfaces in sync_events / mutation_outbox
          // and reaches QBO downstream. Same idempotency keys (versioned for
          // rentals so consecutive ticks don't collapse into one outbox row).
          if (result.bill) {
            await recordLedger(client, {
              companyId: rental.company_id,
              entityType: 'material_bill',
              entityId: result.bill.id,
              mutationType: 'create',
              idempotencyKey: `material_bill:create:${result.bill.id}`,
              syncPayload: {
                action: 'create',
                bill: result.bill,
                source: 'rental_invoice',
                rental_id: rental.id,
                origin: 'worker',
              },
              outboxPayload: {
                ...(result.bill as unknown as Record<string, unknown>),
                source: 'rental_invoice',
                rental_id: rental.id,
              },
            })
          }
          await recordLedger(client, {
            companyId: rental.company_id,
            entityType: 'rental',
            entityId: rental.id,
            mutationType: 'invoice',
            idempotencyKey: `rental:invoice:${rental.id}:${result.rental.version}`,
            syncPayload: {
              action: 'invoice',
              rental: result.rental,
              days: result.days,
              amount: result.amount,
              invoiced_through: result.invoiced_through,
              origin: 'worker',
            },
            outboxPayload: {
              rental: result.rental,
              bill_id: result.bill?.id ?? null,
              days: result.days,
              amount: result.amount,
            },
          })
          await client.query('commit')
          if (result.bill) {
            billed += 1
            amount += result.amount
          } else {
            skipped += 1
          }
        } catch (error) {
          await client.query('rollback')
          logger.error({ err: error, rental_id: rental.id }, '[worker] rental invoice failed')
          captureWithEntityContext(error, {
            scope: 'rental_invoice',
            entity_type: 'rental',
            entity_id: rental.id,
            company_id: rental.company_id,
          })
        }
      }
      return { processed: due.length, billed, skipped, amount }
    } finally {
      client.release()
    }
  }
}
