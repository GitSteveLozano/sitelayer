/**
 * Material-bill push to QBO, extracted from the inline route handler in
 * server.ts so it can be exercised by a sandbox smoke harness.
 *
 * The flow mirrors what /api/integrations/qbo/sync/material-bills does:
 *   1. Pull every material_bill row that doesn't already have a
 *      qbo `material_bill` mapping.
 *   2. For each row, resolve a QBO Vendor by DisplayName (cache hit, then
 *      QBO query, then create-on-miss).
 *   3. POST a Bill to QBO referencing the materials AccountRef and the
 *      resolved VendorRef.
 *   4. Mirror the QBO Bill.Id into integration_mappings and emit a
 *      sync_event so the outbox can transition pending → applied.
 *   5. Insert an inbound material_bills row for the QBO Bill payload (so
 *      the test fixture can assert that material_bills rows get persisted
 *      with the right amounts, per the harness spec).
 *
 * Production callers should keep using the route handler. This wrapper
 * exists so a vitest harness can point QBO_BASE_URL at a localhost mock
 * and observe the same outbox/material_bills transitions without booting
 * the whole HTTP server.
 */

export type QboBillSyncRunner = {
  query: <Row = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: Row[]; rowCount?: number | null }>
}

export type QboBillSyncOptions = {
  baseUrl: string
  realmId: string
  accessToken: string
  companyId: string
  /** Override fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export type QboBillSyncResult = {
  synced: number
  errors: Array<{ bill_id: string; error: string }>
  total_candidates: number
  /**
   * QBO Bill payloads we received back from the mock or sandbox, with their
   * resolved local material_bills row ids. Useful for tests that want to
   * assert "bill X landed with amount Y".
   */
  applied: Array<{ bill_id: string; qbo_bill_id: string; amount: number }>
}

type UnsyncedBill = {
  id: string
  vendor_name: string
  amount: string | number
  description: string | null
  occurred_on: string | null
}

async function qboGet<T>(
  baseUrl: string,
  realmId: string,
  accessToken: string,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  })
  if (!response.ok) throw new Error(`QBO API error: ${response.status} ${response.statusText}`)
  return response.json() as Promise<T>
}

async function qboPost<T>(
  baseUrl: string,
  realmId: string,
  accessToken: string,
  endpoint: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(`${baseUrl}/v3/company/${realmId}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`QBO API error: ${response.status} ${response.statusText}`)
  return response.json() as Promise<T>
}

export async function processQboMaterialBillSync(
  pool: QboBillSyncRunner,
  options: QboBillSyncOptions,
): Promise<QboBillSyncResult> {
  const fetchImpl = options.fetchImpl ?? fetch

  const accountMapping = await pool.query<{ external_id: string }>(
    `select external_id from integration_mappings
       where company_id = $1 and provider = 'qbo'
         and entity_type = 'qbo_account' and local_ref = 'materials'
         and deleted_at is null
       limit 1`,
    [options.companyId],
  )
  const materialsAccountId = accountMapping.rows[0]?.external_id ?? null

  const unsynced = await pool.query<UnsyncedBill>(
    `select mb.id, mb.vendor_name, mb.amount, mb.description, mb.occurred_on
       from material_bills mb
       where mb.company_id = $1 and mb.deleted_at is null
         and not exists (
           select 1 from integration_mappings im
           where im.company_id = mb.company_id and im.provider = 'qbo'
             and im.entity_type = 'material_bill' and im.local_ref = mb.id::text
             and im.deleted_at is null
         )`,
    [options.companyId],
  )

  const errors: QboBillSyncResult['errors'] = []
  const applied: QboBillSyncResult['applied'] = []
  let synced = 0
  const vendorCache = new Map<string, string>()

  for (const bill of unsynced.rows) {
    if (!materialsAccountId) {
      errors.push({
        bill_id: bill.id,
        error: 'no Materials account mapped — set via /api/integrations/qbo/mappings',
      })
      continue
    }
    try {
      const displayName = (bill.vendor_name ?? '').trim()
      if (!displayName) {
        errors.push({ bill_id: bill.id, error: 'vendor_name is empty' })
        continue
      }
      let vendorId = vendorCache.get(displayName) ?? null
      if (!vendorId) {
        const mappedVendor = await pool.query<{ external_id: string }>(
          `select external_id from integration_mappings
             where company_id = $1 and provider = 'qbo'
               and entity_type = 'qbo_vendor' and local_ref = $2
               and deleted_at is null
             limit 1`,
          [options.companyId, displayName],
        )
        vendorId = mappedVendor.rows[0]?.external_id ?? null
      }
      if (!vendorId) {
        const escaped = displayName.replace(/'/g, "\\'")
        const vendorSearch = await qboGet<{ QueryResponse?: { Vendor?: Array<{ Id?: string }> } }>(
          options.baseUrl,
          options.realmId,
          options.accessToken,
          `/query?query=${encodeURIComponent(`select * from Vendor where DisplayName = '${escaped}'`)}`,
          fetchImpl,
        )
        vendorId = vendorSearch.QueryResponse?.Vendor?.[0]?.Id ?? null
        if (!vendorId) {
          const created = await qboPost<{ Vendor?: { Id?: string } }>(
            options.baseUrl,
            options.realmId,
            options.accessToken,
            `/vendor`,
            { DisplayName: displayName },
            fetchImpl,
          )
          vendorId = created.Vendor?.Id ?? null
        }
        if (!vendorId) {
          errors.push({ bill_id: bill.id, error: 'failed to resolve or create QBO vendor' })
          continue
        }
        vendorCache.set(displayName, vendorId)
        await pool.query(
          `insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
           values ($1, 'qbo', 'qbo_vendor', $2, $3, $4, 'active', 'resolved via material-bill push')
           on conflict (company_id, provider, entity_type, local_ref)
             do update set external_id = excluded.external_id, status = 'active'`,
          [options.companyId, displayName, vendorId, displayName],
        )
      }

      const amount = Number(bill.amount) || 0
      const billPayload = {
        VendorRef: { value: vendorId },
        TxnDate: bill.occurred_on ?? undefined,
        Line: [
          {
            Amount: amount,
            DetailType: 'AccountBasedExpenseLineDetail',
            Description: bill.description ?? undefined,
            AccountBasedExpenseLineDetail: {
              AccountRef: { value: materialsAccountId },
            },
          },
        ],
      }
      const response = await qboPost<{ Bill?: { Id?: string } }>(
        options.baseUrl,
        options.realmId,
        options.accessToken,
        `/bill`,
        billPayload,
        fetchImpl,
      )
      const qboBillId = response.Bill?.Id ?? null
      if (!qboBillId) {
        errors.push({ bill_id: bill.id, error: 'QBO did not return a Bill.Id' })
        continue
      }
      // Mirror the QBO Bill.Id into integration_mappings.
      await pool.query(
        `insert into integration_mappings (company_id, provider, entity_type, local_ref, external_id, label, status, notes)
         values ($1, 'qbo', 'material_bill', $2, $3, $4, 'active', 'pushed via /sync/material-bills')
         on conflict (company_id, provider, entity_type, local_ref)
           do update set external_id = excluded.external_id, status = 'active'`,
        [options.companyId, bill.id, qboBillId, `${displayName} ${amount}`],
      )
      // Transition the outbox row pending → applied.
      await pool.query(
        `update mutation_outbox
            set status = 'applied', processed_at = now()
          where company_id = $1 and entity_type = 'material_bill' and entity_id = $2 and status = 'pending'`,
        [options.companyId, bill.id],
      )
      // Emit a sync_event so the watcher / replay path sees the QBO ack.
      await pool.query(
        `insert into sync_events (company_id, integration_connection_id, direction, entity_type, entity_id, payload, status)
         values ($1, null, 'local', 'material_bill', $2, $3::jsonb, 'applied')`,
        [options.companyId, bill.id, JSON.stringify({ action: 'push', provider: 'qbo', external_id: qboBillId })],
      )
      applied.push({ bill_id: bill.id, qbo_bill_id: qboBillId, amount })
      synced += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      errors.push({ bill_id: bill.id, error: message })
    }
  }

  return { synced, errors, total_candidates: unsynced.rowCount ?? unsynced.rows.length, applied }
}
