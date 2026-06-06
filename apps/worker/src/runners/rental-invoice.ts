import type { Pool, PoolClient } from 'pg'
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

/**
 * Enqueue the cadence invoice push for an already-RETURNED rental that just
 * billed. MIRRORS the rental_billing_run worker side: instead of dispatching
 * the INVOICE_QUEUED/INVOICE_POSTED transitions inline, we drop a
 * mutation_outbox row (mutation_type='post_rental_invoice') that the dedicated
 * pusher (runners/rental-invoice-push.ts → processRentalInvoicePush) drains on
 * a later tick. That handler runs the GATED QBO push (real invoice when
 * QBO_LIVE_RENTAL_INVOICE=1 + the company flag, else a deterministic stub id)
 * and then dispatches the cadence transitions through the rental reducer +
 * workflow_event_log. Splitting the push onto the outbox keeps the QBO HTTP
 * call (and its circuit breaker / retry / dead-letter) off this billing tick's
 * critical path.
 *
 * Strictly gated by the caller to a `returned` rental that produced a bill, so
 * the pusher's reducer dispatch (INVOICE_QUEUED only legal from `returned`)
 * never throws. The idempotency key is versioned on the rental's pre-push
 * state_version, so a re-run of the same cadence tick upserts the same outbox
 * row rather than enqueuing a duplicate push.
 */
async function enqueueRentalInvoicePush(
  client: PoolClient,
  args: {
    companyId: string
    rentalId: string
    billId: string | null
    amount: number
    days: number
    invoicedThrough: string
  },
): Promise<void> {
  const versionResult = await client.query<{ state_version: number; status: string }>(
    `select state_version, status from rentals where company_id = $1 and id = $2 for update`,
    [args.companyId, args.rentalId],
  )
  const current = versionResult.rows[0]
  // Re-check status under the lock. If a concurrent path already moved it off
  // `returned`, skip rather than enqueue a push the pusher would just skip.
  if (!current || current.status !== 'returned') return

  await recordLedger(client, {
    companyId: args.companyId,
    entityType: 'rental',
    entityId: args.rentalId,
    mutationType: 'post_rental_invoice',
    // Versioned on the pre-push state_version so consecutive cadence ticks
    // don't collapse into one outbox row, and a re-run of THIS tick upserts
    // the same row (idempotent enqueue).
    idempotencyKey: `rental:invoice_push:${args.rentalId}:${current.state_version}`,
    syncPayload: {
      action: 'post_rental_invoice',
      rental_id: args.rentalId,
      bill_id: args.billId,
      amount: args.amount,
      days: args.days,
      invoiced_through: args.invoicedThrough,
      origin: 'worker',
    },
  })
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
                ...result.bill,
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
          // Worker-only rental workflow cadence (Phase 2). Only an
          // already-RETURNED rental that produced a bill walks the
          // returned → invoiced_pending → returned cadence cycle; an `active`
          // rental is still on site and stays `active`, so it has no cadence
          // event to emit. We do NOT dispatch the transitions here — we enqueue
          // a post_rental_invoice outbox row and let the dedicated pusher
          // (rental-invoice-push.ts) run the gated QBO push + reducer dispatch,
          // exactly like rental_billing_run's POST_REQUESTED → worker apply.
          if (rental.status === 'returned' && result.bill) {
            await enqueueRentalInvoicePush(client, {
              companyId: rental.company_id,
              rentalId: rental.id,
              billId: result.bill.id,
              amount: result.amount,
              days: result.days,
              invoicedThrough: result.invoiced_through,
            })
          }
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
