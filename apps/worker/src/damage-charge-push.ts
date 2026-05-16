import type { PoolClient } from 'pg'
import { withFreshToken, type IntegrationConnectionTokens, type RefreshDeps } from './qbo-token-refresh.js'

/**
 * QBO push for damage_charges. One-line invoice per charge, keyed by
 * idempotency_key=`damage_charge_invoice:<id>`. The route enqueues an
 * outbox row when the charge transitions from open → invoiced; this
 * drain pushes it to QBO and writes back qbo_invoice_id.
 *
 * Live mode requires QBO_RENTAL_INCOME_ACCOUNT_ID (re-uses the rental
 * income account) or QBO_DAMAGE_INCOME_ACCOUNT_ID if set separately.
 */

type DamageChargePayload = {
  id?: string
  customer_id?: string | null
  project_id?: string
  kind?: 'damage' | 'loss' | 'late_return' | 'cleanup'
  description?: string
  quantity?: string | number | null
  unit_amount?: string | number | null
  total_amount?: string | number | null
  taxable?: boolean
  inventory_item_id?: string | null
  catalog_part_id?: string | null
}

function n(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export type DamageChargePushDeps = {
  refreshDeps?: RefreshDeps
  liveFlag?: boolean
}

export async function processDamageChargeInvoicePush(
  client: PoolClient,
  companyId: string,
  payload: DamageChargePayload,
  deps: DamageChargePushDeps = {},
): Promise<{ qbo_invoice_id: string | null; skipped: boolean }> {
  const chargeId = payload.id
  if (!chargeId) {
    throw new Error('damage_charge payload missing id')
  }

  // Idempotency: if the charge already has a qbo_invoice_id, skip.
  const existing = await client.query<{ qbo_invoice_id: string | null; status: string }>(
    'select qbo_invoice_id, status from damage_charges where company_id = $1 and id = $2 limit 1',
    [companyId, chargeId],
  )
  if (!existing.rows[0]) {
    throw new Error(`damage_charge ${chargeId} not found`)
  }
  if (existing.rows[0].qbo_invoice_id) {
    return { qbo_invoice_id: existing.rows[0].qbo_invoice_id, skipped: true }
  }

  // Live-mode gate: when QBO_LIVE_DAMAGE_INVOICE is off, mark as posted
  // with a synthetic id so dev/preview can exercise the workflow without
  // calling QBO. Mirrors the rental-billing stub pattern.
  const liveFlag = deps.liveFlag ?? process.env.QBO_LIVE_DAMAGE_INVOICE === '1'
  if (!liveFlag) {
    const synthetic = `STUB-DMG-${chargeId.slice(0, 8)}`
    await client.query(
      `update damage_charges set qbo_invoice_id = $3, updated_at = now()
       where company_id = $1 and id = $2`,
      [companyId, chargeId, synthetic],
    )
    return { qbo_invoice_id: synthetic, skipped: false }
  }

  if (!payload.customer_id) {
    throw new Error(`damage_charge ${chargeId} has no customer_id; cannot push QBO invoice`)
  }
  const customerMap = await client.query<{ external_id: string }>(
    `select external_id from integration_mappings
     where company_id = $1 and provider = 'qbo' and entity_type = 'customer'
       and local_ref = $2 and deleted_at is null limit 1`,
    [companyId, payload.customer_id],
  )
  const qboCustomerId = customerMap.rows[0]?.external_id
  if (!qboCustomerId) {
    throw new Error(`no QBO customer mapping for sitelayer customer ${payload.customer_id}`)
  }

  const conn = await client.query<IntegrationConnectionTokens>(
    `select id, provider_account_id, access_token, refresh_token, status, access_token_expires_at
     from integration_connections
     where company_id = $1 and provider = 'qbo' and deleted_at is null limit 1`,
    [companyId],
  )
  const connection = conn.rows[0]
  if (!connection?.provider_account_id) {
    throw new Error('qbo connection missing realm id')
  }
  if (connection.status !== 'connected') {
    throw new Error(`qbo connection status is ${connection.status}, refusing to push`)
  }

  const incomeAccountId = process.env.QBO_DAMAGE_INCOME_ACCOUNT_ID ?? process.env.QBO_RENTAL_INCOME_ACCOUNT_ID ?? ''
  const baseUrl = process.env.QBO_BASE_URL ?? 'https://sandbox-quickbooks.api.intuit.com'

  // Resolve inventory_item → QBO item; otherwise fall back to the income
  // account line (same pattern as rental-billing).
  let itemRef: { value: string } | undefined
  if (payload.inventory_item_id) {
    const itemMap = await client.query<{ external_id: string }>(
      `select external_id from integration_mappings
       where company_id = $1 and provider = 'qbo' and entity_type = 'inventory_item'
         and local_ref = $2 and deleted_at is null limit 1`,
      [companyId, payload.inventory_item_id],
    )
    if (itemMap.rows[0]) itemRef = { value: itemMap.rows[0].external_id }
  }

  const totalAmount = n(payload.total_amount) || n(payload.quantity) * n(payload.unit_amount)
  if (totalAmount <= 0) {
    throw new Error(`damage_charge ${chargeId} total_amount <= 0; refusing to push empty invoice`)
  }

  const detail: Record<string, unknown> = {}
  if (itemRef) detail.ItemRef = itemRef
  if (payload.quantity != null) detail.Qty = n(payload.quantity)
  if (payload.unit_amount != null) detail.UnitPrice = n(payload.unit_amount)

  if (!itemRef && !incomeAccountId) {
    throw new Error(
      'damage charge has no QBO inventory_item mapping and no QBO_DAMAGE_INCOME_ACCOUNT_ID — set one or map the item',
    )
  }

  const linePayload = [
    {
      Amount: totalAmount,
      DetailType: 'SalesItemLineDetail',
      Description: payload.description ?? `${payload.kind ?? 'damage'} charge`,
      SalesItemLineDetail: detail,
    },
  ]

  const invoicePayload = {
    DocNumber: `DMG-${chargeId.slice(0, 8)}`,
    CustomerRef: { value: qboCustomerId },
    PrivateNote: `Sitelayer damage charge ${chargeId}`,
    Line: linePayload,
  }

  const url = `${baseUrl}/v3/company/${connection.provider_account_id}/invoice`
  const fetchImpl = deps.refreshDeps?.fetchImpl ?? fetch
  const parsed = await withFreshToken<{ Invoice?: { Id?: string } }>(
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
        await response.text().catch(() => '')
        return { unauthorized: true }
      }
      if (!response.ok) {
        const errBody = await response.text()
        throw new Error(`qbo invoice POST returned ${response.status}: ${errBody.slice(0, 500)}`)
      }
      return { unauthorized: false, value: (await response.json()) as { Invoice?: { Id?: string } } }
    },
    deps.refreshDeps,
  )

  const invoiceId = parsed.Invoice?.Id
  if (!invoiceId) {
    throw new Error('qbo invoice POST succeeded but Invoice.Id missing in response')
  }
  await client.query(
    `update damage_charges set qbo_invoice_id = $3, updated_at = now()
     where company_id = $1 and id = $2`,
    [companyId, chargeId, invoiceId],
  )
  return { qbo_invoice_id: invoiceId, skipped: false }
}
