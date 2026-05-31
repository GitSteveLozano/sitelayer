import type { Pool, PoolClient } from 'pg'
import type { Logger } from '@sitelayer/logger'
import { appendWorkflowEvent, fetchDueRentals, processRentalInvoice, recordLedger } from '@sitelayer/queue'
import {
  RENTAL_WORKFLOW_NAME,
  RENTAL_WORKFLOW_SCHEMA_VERSION,
  transitionRentalWorkflow,
  type RentalWorkflowSnapshot,
} from '@sitelayer/workflows'
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
 * Emit the worker-only cadence transitions through the rental reducer so the
 * `invoiced_pending` state is reachable in the event log and replay-verifiable.
 *
 * The cadence cycle for an already-RETURNED rental is
 * `returned → INVOICE_QUEUED → invoiced_pending → INVOICE_POSTED → returned`.
 * `processRentalInvoice` already left the row's `status` at `returned` (its
 * `next_status` for a returned rental), so this records the two intermediate
 * event-log rows and advances `state_version` to match — the row's `status`
 * value is unchanged (net round-trip back to `returned`).
 *
 * Strictly gated: only fires when the pre-invoice status was `returned`, so
 * the reducer's `assertRentalTransition` (INVOICE_QUEUED only legal from
 * `returned`) never throws on an `active` rental. `appendWorkflowEvent` uses
 * `on conflict (entity_id, state_version) do nothing`, and the row's
 * `state_version` is persisted, so a re-run of the same cadence tick is an
 * idempotent no-op rather than a duplicate or a swallowed event.
 */
async function emitRentalCadenceEvents(
  client: PoolClient,
  args: { companyId: string; rentalId: string },
): Promise<void> {
  const versionResult = await client.query<{ state_version: number; status: string }>(
    `select state_version, status from rentals where company_id = $1 and id = $2 for update`,
    [args.companyId, args.rentalId],
  )
  const current = versionResult.rows[0]
  // Belt-and-braces: re-check status under the lock. If a concurrent path
  // already moved it off `returned`, skip rather than risk an illegal
  // transition.
  if (!current || current.status !== 'returned') return

  let snapshot: RentalWorkflowSnapshot = { state: 'returned', state_version: current.state_version }

  // returned → invoiced_pending
  const queued = transitionRentalWorkflow(snapshot, { type: 'INVOICE_QUEUED' })
  await appendWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: RENTAL_WORKFLOW_NAME,
    schemaVersion: RENTAL_WORKFLOW_SCHEMA_VERSION,
    entityType: 'rental',
    entityId: args.rentalId,
    stateVersion: snapshot.state_version,
    eventType: 'INVOICE_QUEUED',
    eventPayload: { type: 'INVOICE_QUEUED' },
    snapshotAfter: queued as unknown as Record<string, unknown>,
    actorUserId: null,
  })
  snapshot = queued

  // invoiced_pending → returned (next cadence cycle)
  const posted = transitionRentalWorkflow(snapshot, { type: 'INVOICE_POSTED' })
  await appendWorkflowEvent(client, {
    companyId: args.companyId,
    workflowName: RENTAL_WORKFLOW_NAME,
    schemaVersion: RENTAL_WORKFLOW_SCHEMA_VERSION,
    entityType: 'rental',
    entityId: args.rentalId,
    stateVersion: snapshot.state_version,
    eventType: 'INVOICE_POSTED',
    eventPayload: { type: 'INVOICE_POSTED' },
    snapshotAfter: posted as unknown as Record<string, unknown>,
    actorUserId: null,
  })

  // Persist the advanced state_version so the next cadence cycle records at a
  // fresh version (the `do nothing` conflict guard relies on this).
  await client.query(`update rentals set state_version = $3 where company_id = $1 and id = $2`, [
    args.companyId,
    args.rentalId,
    posted.state_version,
  ])
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
          // Worker-only rental workflow cadence transitions. Only an
          // already-RETURNED rental walks returned → invoiced_pending →
          // returned; an `active` rental is still on site and stays `active`,
          // so it has no cadence event to emit. Gated on a produced bill so we
          // only mark a billing cycle that actually invoiced.
          if (rental.status === 'returned' && result.bill) {
            await emitRentalCadenceEvents(client, { companyId: rental.company_id, rentalId: rental.id })
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
