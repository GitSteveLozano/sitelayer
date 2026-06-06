import type { RentalInvoicePushFn } from '@sitelayer/queue'
import { Sentry } from './instrument.js'
import { withFreshToken, type IntegrationConnectionTokens, type RefreshDeps } from './qbo-token-refresh.js'

// QBO REST integration for the rental CADENCE invoice push (the worker-tick
// path, distinct from rental_billing_run's human-approved push in
// qbo-invoice-push.ts). The cadence push invoices a single already-billed
// rental period as a one-line QBO Invoice pinned to the rental income account.
//
// Env knobs (shared with qbo-invoice-push.ts):
//   QBO_BASE_URL                    sandbox or production base
//   QBO_RENTAL_INCOME_ACCOUNT_ID    QBO Account.Id for the rental income line
//                                   (required for live mode)
//
// Idempotency: the runtime caller (processRentalInvoicePush) gates on the
// rental still being in `returned` BEFORE invoking this fn, and the outbox
// idempotency_key is versioned on the rental's state_version, so a re-claim
// after crash never double-pushes for the same cadence cycle. We also append
// ?requestid=<idempotency hint> so Intuit dedupes a retry that lands after it
// already accepted the create. This fn may throw on any failure; the handler
// converts the throw into a failed sync_event + outbox retry.

type QboInvoiceCreateResponse = {
  Invoice?: { Id?: string; DocNumber?: string }
}

type RentalCadencePayload = {
  rental_id?: string
  bill_id?: string | null
  amount?: string | number
  days?: string | number
  invoiced_through?: string | null
}

function n(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}

/**
 * Build the live QBO Invoice push fn for the rental cadence workflow.
 * Returned fn is suitable to pass to processRentalInvoicePush.
 *
 * `refreshDeps` exists for testing — production callers omit it.
 */
export function createQboRentalCadencePush(refreshDeps: RefreshDeps = {}): RentalInvoicePushFn {
  const baseUrl = process.env.QBO_BASE_URL ?? 'https://sandbox-quickbooks.api.intuit.com'
  const incomeAccountId = process.env.QBO_RENTAL_INCOME_ACCOUNT_ID ?? ''

  return async ({ client, companyId, rentalId, payload }) => {
    const cadence = payload as RentalCadencePayload
    const amount = n(cadence.amount)
    if (amount <= 0) {
      throw new Error('rental cadence push has non-positive amount; nothing to invoice')
    }

    // Resolve the rental's customer in the same tx the caller holds the rental
    // lock in, so this read sees a consistent connection state.
    const rentalRow = await client.query<{ customer_id: string | null; item_description: string }>(
      `select customer_id, item_description from rentals
       where company_id = $1 and id = $2 and deleted_at is null limit 1`,
      [companyId, rentalId],
    )
    const rental = rentalRow.rows[0]
    if (!rental) {
      throw new Error('rental not found for cadence push')
    }
    if (!rental.customer_id) {
      throw new Error('rental has no customer_id; cannot push QBO invoice')
    }

    const conn = await client.query<IntegrationConnectionTokens>(
      `select id, provider_account_id, access_token, refresh_token, status, access_token_expires_at
       from integration_connections
       where company_id = $1 and provider = 'qbo' and deleted_at is null
       limit 1`,
      [companyId],
    )
    const connection = conn.rows[0]
    if (!connection?.provider_account_id) {
      throw new Error('qbo connection missing realm id')
    }
    if (connection.status !== 'connected') {
      throw new Error(`qbo connection status is ${connection.status}, refusing to push`)
    }
    if (!connection.access_token && !connection.refresh_token) {
      throw new Error('qbo connection has neither access_token nor refresh_token; operator must reconnect')
    }
    if (!incomeAccountId) {
      throw new Error('QBO_RENTAL_INCOME_ACCOUNT_ID is required for live rental cadence push')
    }

    const customerMap = await client.query<{ external_id: string }>(
      `select external_id from integration_mappings
       where company_id = $1 and provider = 'qbo' and entity_type = 'customer'
         and local_ref = $2 and deleted_at is null
       limit 1`,
      [companyId, rental.customer_id],
    )
    const qboCustomerId = customerMap.rows[0]?.external_id
    if (!qboCustomerId) {
      throw new Error(`no QBO customer mapping for sitelayer customer ${rental.customer_id}`)
    }

    const description = `Rental: ${rental.item_description}${
      cadence.invoiced_through ? ` (through ${cadence.invoiced_through})` : ''
    }`
    const invoicePayload = {
      DocNumber: `RENT-${rentalId.slice(0, 8)}`,
      CustomerRef: { value: qboCustomerId },
      PrivateNote: `Sitelayer rental cadence invoice ${rentalId}`,
      Line: [
        {
          Amount: amount,
          DetailType: 'SalesItemLineDetail' as const,
          Description: description,
          SalesItemLineDetail: {
            ItemRef: undefined as { value: string } | undefined,
            AccountRef: { value: incomeAccountId },
          },
        },
      ],
    }

    // Intuit idempotency: requestid keyed on the rental id keeps a retry that
    // lands after Intuit accepted the create from minting a second invoice.
    const url = `${baseUrl}/v3/company/${connection.provider_account_id}/invoice?requestid=${encodeURIComponent(rentalId)}`
    const fetchImpl = refreshDeps.fetchImpl ?? fetch
    let qboAttempt = 0
    const parsed = await withFreshToken<QboInvoiceCreateResponse>(
      connection,
      client,
      async (token) => {
        const attempt = qboAttempt++
        return Sentry.startSpan(
          {
            name: 'qbo.request',
            op: 'http.client',
            attributes: {
              'http.url': url,
              'http.method': 'POST',
              'qbo.attempt': attempt,
              'qbo.kind': 'rental_cadence_invoice_push',
              rental_id: rentalId,
              company_id: companyId,
            },
          },
          async (span) => {
            const response = await fetchImpl(url, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(invoicePayload),
            })
            span?.setAttribute('http.status_code', response.status)
            if (!response.ok) span?.setStatus({ code: 2, message: `qbo_${response.status}` })
            if (response.status === 401) {
              await response.text().catch(() => '')
              return { unauthorized: true as const }
            }
            if (!response.ok) {
              const errBody = await response.text()
              throw new Error(`qbo invoice POST returned ${response.status}: ${errBody.slice(0, 500)}`)
            }
            return { unauthorized: false as const, value: (await response.json()) as QboInvoiceCreateResponse }
          },
        )
      },
      refreshDeps,
    )
    const invoiceId = parsed.Invoice?.Id
    if (!invoiceId) {
      throw new Error('qbo invoice POST succeeded but Invoice.Id missing in response')
    }
    return { qbo_invoice_id: invoiceId }
  }
}
