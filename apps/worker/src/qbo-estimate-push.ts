import type { EstimatePushFn } from '@sitelayer/queue'

// QBO REST integration for estimate-push (project estimate → QBO Estimate).
// Twin of qbo-invoice-push.ts; same connection lookup, same mapping
// conventions, same idempotency contract:
//
//   - processEstimatePush already checks estimate_pushes.qbo_estimate_id
//     BEFORE invoking this fn. If the id is set we never hit QBO, so this
//     fn is allowed to throw on any failure; the handler converts the throw
//     into POST_FAILED and the outbox row retries on the next worker tick.
//
// Env knobs:
//   QBO_BASE_URL    sandbox or production base
//                   (default https://sandbox-quickbooks.api.intuit.com)
//
// Mapping requirements (live mode):
//   - integration_connections row exists for (company_id, provider='qbo'),
//     status='connected', with access_token + provider_account_id (realm id)
//   - integration_mappings row exists for the customer
//     (entity_type='customer', local_ref=<estimate_push.customer_id>)
//   - integration_mappings row exists for every line's service_item_code
//     (entity_type='service_item', local_ref=<line.service_item_code>);
//     QBO Estimate Line[] requires SalesItemLineDetail.ItemRef

type QboConnectionRow = {
  id: string
  provider_account_id: string | null
  access_token: string | null
  status: string
}

type QboEstimateLinePayload = {
  Amount: number
  DetailType: 'SalesItemLineDetail'
  Description?: string
  SalesItemLineDetail: {
    ItemRef: { value: string }
    Qty?: number
    UnitPrice?: number
  }
}

type QboEstimateCreateResponse = {
  Estimate?: { Id?: string; DocNumber?: string }
}

type PushPayloadLine = {
  description?: string | null
  service_item_code?: string | null
  quantity?: string | number | null
  unit_price?: string | number | null
  amount?: string | number | null
}

type PushPayload = {
  estimate_push_id?: string
  project_id?: string | null
  customer_id?: string | null
  subtotal?: string | number | null
  lines?: PushPayloadLine[]
}

function n(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : 0
}

export function createQboEstimatePush(): EstimatePushFn {
  const baseUrl = process.env.QBO_BASE_URL ?? 'https://sandbox-quickbooks.api.intuit.com'

  return async ({ client, companyId, pushId, payload }) => {
    const push = payload as PushPayload

    const conn = await client.query<QboConnectionRow>(
      `select id, provider_account_id, access_token, status
       from integration_connections
       where company_id = $1 and provider = 'qbo' and deleted_at is null
       limit 1`,
      [companyId],
    )
    const connection = conn.rows[0]
    if (!connection?.access_token || !connection.provider_account_id) {
      throw new Error('qbo connection missing access_token or realm id')
    }
    if (connection.status !== 'connected') {
      throw new Error(`qbo connection status is ${connection.status}, refusing to push`)
    }

    if (!push.customer_id) {
      throw new Error('estimate push has no customer_id; cannot push QBO estimate')
    }
    const customerMap = await client.query<{ external_id: string }>(
      `select external_id from integration_mappings
       where company_id = $1 and provider = 'qbo' and entity_type = 'customer'
         and local_ref = $2 and deleted_at is null
       limit 1`,
      [companyId, push.customer_id],
    )
    const qboCustomerId = customerMap.rows[0]?.external_id
    if (!qboCustomerId) {
      throw new Error(`no QBO customer mapping for sitelayer customer ${push.customer_id}`)
    }

    const lines = push.lines ?? []
    if (!lines.length) {
      throw new Error('estimate push has no lines; cannot push empty QBO estimate')
    }

    const linePayload: QboEstimateLinePayload[] = []
    for (const line of lines) {
      if (!line.service_item_code) {
        throw new Error(
          'one or more estimate lines have no service_item_code; map them via /api/integrations/qbo/mappings before retrying',
        )
      }
      const itemMap = await client.query<{ external_id: string }>(
        `select external_id from integration_mappings
         where company_id = $1 and provider = 'qbo' and entity_type = 'service_item'
           and local_ref = $2 and deleted_at is null
         limit 1`,
        [companyId, line.service_item_code],
      )
      const itemExternalId = itemMap.rows[0]?.external_id
      if (!itemExternalId) {
        throw new Error(
          `no QBO service_item mapping for code ${line.service_item_code}; map it via /api/integrations/qbo/mappings before retrying`,
        )
      }
      const detail: QboEstimateLinePayload['SalesItemLineDetail'] = {
        ItemRef: { value: itemExternalId },
      }
      if (line.quantity !== undefined && line.quantity !== null) detail.Qty = n(line.quantity)
      if (line.unit_price !== undefined && line.unit_price !== null) detail.UnitPrice = n(line.unit_price)
      linePayload.push({
        Amount: n(line.amount),
        DetailType: 'SalesItemLineDetail',
        ...(line.description ? { Description: line.description } : {}),
        SalesItemLineDetail: detail,
      })
    }

    const estimatePayload = {
      DocNumber: `EST-${pushId.slice(0, 8)}`,
      CustomerRef: { value: qboCustomerId },
      PrivateNote: `Sitelayer estimate push ${pushId}`,
      Line: linePayload,
    }

    const url = `${baseUrl}/v3/company/${connection.provider_account_id}/estimate`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${connection.access_token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(estimatePayload),
    })
    if (!response.ok) {
      const errBody = await response.text()
      throw new Error(`qbo estimate POST returned ${response.status}: ${errBody.slice(0, 500)}`)
    }
    const parsed = (await response.json()) as QboEstimateCreateResponse
    const estimateId = parsed.Estimate?.Id
    if (!estimateId) {
      throw new Error('qbo estimate POST succeeded but Estimate.Id missing in response')
    }
    return { qbo_estimate_id: estimateId }
  }
}
