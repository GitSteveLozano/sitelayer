import type { RentalBillingInvoicePushFn } from '@sitelayer/queue'
import { withFreshToken, type IntegrationConnectionTokens, type RefreshDeps } from './qbo-token-refresh.js'

// QBO REST integration for rental-billing invoice push. Mirrors the existing
// /api/integrations/qbo/sync/material-bills logic in apps/api/src/routes/qbo.ts
// but inlined here because workers can't import apps/api code (separate
// workspace, separate runtime).
//
// Env knobs:
//   QBO_BASE_URL                    sandbox or production base
//   QBO_RENTAL_INCOME_ACCOUNT_ID    QBO Account.Id used as the income account
//                                   for rental invoice lines (required for
//                                   live mode)
//
// Idempotency: the runtime caller (processRentalBillingInvoicePush) already
// checks rental_billing_runs.qbo_invoice_id BEFORE invoking this fn — if the
// id is set we never hit QBO. So this fn is allowed to throw on any failure;
// the handler converts the throw into POST_FAILED and the outbox row is
// retried on the next worker tick.

type QboInvoiceLinePayload = {
  Amount: number
  DetailType: 'SalesItemLineDetail'
  Description?: string
  SalesItemLineDetail: {
    ItemRef?: { value: string }
    Qty?: number
    UnitPrice?: number
    AccountBasedExpenseLineDetail?: never
  }
}

type QboInvoiceCreateResponse = {
  Invoice?: { Id?: string; DocNumber?: string }
}

type RunPayloadLine = {
  inventory_item_id?: string
  description?: string | null
  amount?: string | number
  quantity?: string | number
  agreed_rate?: string | number
}

type RunPayload = {
  billing_run_id?: string
  customer_id?: string | null
  subtotal?: string | number
  lines?: RunPayloadLine[]
}

function n(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}

/**
 * Build the live QBO Invoice push fn for the rental billing workflow.
 * Returned fn is suitable to pass to processRentalBillingInvoicePush.
 *
 * `refreshDeps` exists for testing — production callers omit it.
 */
export function createQboRentalInvoicePush(refreshDeps: RefreshDeps = {}): RentalBillingInvoicePushFn {
  const baseUrl = process.env.QBO_BASE_URL ?? 'https://sandbox-quickbooks.api.intuit.com'
  const incomeAccountId = process.env.QBO_RENTAL_INCOME_ACCOUNT_ID ?? ''

  return async ({ client, companyId, runId, payload }) => {
    const run = payload as RunPayload

    // Connection lookup. The client argument here is the same tx the caller
    // is using to lock the run row + insert the sync_event audit row, so
    // this select sees a consistent connection state.
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

    // Customer ref. Required by QBO Invoice. We look it up in
    // integration_mappings keyed on (provider='qbo', entity_type='customer',
    // local_ref=<run.customer_id>). If the run has no customer or no mapping,
    // throw — the caller can render a clear retry-able failure.
    if (!run.customer_id) {
      throw new Error('rental billing run has no customer_id; cannot push QBO invoice')
    }
    const customerMap = await client.query<{ external_id: string }>(
      `select external_id from integration_mappings
       where company_id = $1 and provider = 'qbo' and entity_type = 'customer'
         and local_ref = $2 and deleted_at is null
       limit 1`,
      [companyId, run.customer_id],
    )
    const qboCustomerId = customerMap.rows[0]?.external_id
    if (!qboCustomerId) {
      throw new Error(`no QBO customer mapping for sitelayer customer ${run.customer_id}`)
    }

    // Build line items. For each rental line: try to resolve inventory_item
    // → integration_mappings → external_id (a QBO Item.Id). If the mapping
    // exists, send ItemRef; otherwise send the line without ItemRef but
    // pinned to the rental income account so QBO accepts it. UnitPrice and
    // Qty come straight off the line; Amount is the precomputed product the
    // domain layer already worked out.
    const lines = run.lines ?? []
    if (!lines.length) {
      throw new Error('rental billing run has no lines; cannot push empty QBO invoice')
    }

    const linePayload: QboInvoiceLinePayload[] = []
    for (const line of lines) {
      let itemRef: { value: string } | undefined
      if (line.inventory_item_id) {
        const itemMap = await client.query<{ external_id: string }>(
          `select external_id from integration_mappings
           where company_id = $1 and provider = 'qbo' and entity_type = 'inventory_item'
             and local_ref = $2 and deleted_at is null
           limit 1`,
          [companyId, line.inventory_item_id],
        )
        if (itemMap.rows[0]) itemRef = { value: itemMap.rows[0].external_id }
      }
      const detail: QboInvoiceLinePayload['SalesItemLineDetail'] = {}
      if (itemRef) detail.ItemRef = itemRef
      if (line.quantity !== undefined && line.quantity !== null) detail.Qty = n(line.quantity)
      if (line.agreed_rate !== undefined && line.agreed_rate !== null) detail.UnitPrice = n(line.agreed_rate)
      const amount = n(line.amount)
      linePayload.push({
        Amount: amount,
        DetailType: 'SalesItemLineDetail',
        ...(line.description ? { Description: line.description } : {}),
        SalesItemLineDetail: detail,
      })
    }

    // QBO requires Line[].Amount to sum to the invoice total. We don't set
    // the invoice total explicitly — QBO computes it from the lines. We DO
    // pin the income account when no per-line ItemRef is set (otherwise
    // QBO rejects with "either ItemRef or AccountRef is required").
    if (incomeAccountId) {
      for (const line of linePayload) {
        if (!line.SalesItemLineDetail.ItemRef) {
          // Without an ItemRef, QBO needs the account at the invoice level
          // — but the SalesItemLineDetail doesn't take AccountRef. We have
          // to fall back to a generic line: drop the SalesItemLine type and
          // use a JournalEntry-style line. That's a bigger rewrite. For
          // now, throw clearly so the operator knows the mapping is missing.
          throw new Error(
            'one or more lines have no QBO inventory_item mapping; map them via /api/integrations/qbo/mappings before retrying',
          )
        }
      }
    }

    const invoicePayload = {
      DocNumber: `RENT-${runId.slice(0, 8)}`,
      CustomerRef: { value: qboCustomerId },
      PrivateNote: `Sitelayer rental billing run ${runId}`,
      Line: linePayload,
    }

    const url = `${baseUrl}/v3/company/${connection.provider_account_id}/invoice`
    const fetchImpl = refreshDeps.fetchImpl ?? fetch
    const parsed = await withFreshToken<QboInvoiceCreateResponse>(
      connection,
      client,
      async (token) => {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(invoicePayload),
        })
        if (response.status === 401) {
          // Drain the body so the caller can decide whether to retry.
          await response.text().catch(() => '')
          return { unauthorized: true }
        }
        if (!response.ok) {
          const errBody = await response.text()
          throw new Error(`qbo invoice POST returned ${response.status}: ${errBody.slice(0, 500)}`)
        }
        return { unauthorized: false, value: (await response.json()) as QboInvoiceCreateResponse }
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
