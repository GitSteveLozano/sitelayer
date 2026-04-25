import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import { AddressInfo } from 'node:net'
import { processQboMaterialBillSync, type QboBillSyncRunner } from './qbo-material-bill-sync.js'

/**
 * Tiny in-memory query runner that just enough of the schema we touch so the
 * smoke test doesn't need a Postgres connection. Each table is a plain array
 * and we route SQL by feature-detecting the statement string. The point of
 * the test is to exercise the QBO HTTP boundary, not pg's SQL parser.
 */
type InMemoryState = {
  materialBills: Array<{
    id: string
    company_id: string
    vendor_name: string
    amount: number
    description: string | null
    occurred_on: string | null
    deleted_at: string | null
  }>
  integrationMappings: Array<{
    company_id: string
    provider: string
    entity_type: string
    local_ref: string
    external_id: string
    label: string | null
    status: string
    notes: string | null
    deleted_at: string | null
  }>
  outbox: Array<{
    id: string
    company_id: string
    entity_type: string
    entity_id: string
    status: 'pending' | 'applied' | 'failed'
    processed_at: string | null
  }>
  syncEvents: Array<{
    company_id: string
    direction: string
    entity_type: string
    entity_id: string
    payload: unknown
    status: string
  }>
}

function buildInMemoryRunner(state: InMemoryState): QboBillSyncRunner {
  return {
    async query<Row = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount?: number | null }> {
      // 1. Materials AccountRef lookup
      if (sql.includes("entity_type = 'qbo_account'") && sql.includes("local_ref = 'materials'")) {
        const companyId = String(params[0])
        const match = state.integrationMappings.find(
          (row) =>
            row.company_id === companyId &&
            row.provider === 'qbo' &&
            row.entity_type === 'qbo_account' &&
            row.local_ref === 'materials' &&
            row.deleted_at === null,
        )
        return { rows: (match ? [{ external_id: match.external_id }] : []) as Row[] }
      }

      // 2. Unsynced material bills query
      if (sql.includes('from material_bills mb') && sql.includes("entity_type = 'material_bill'")) {
        const companyId = String(params[0])
        const rows = state.materialBills
          .filter((bill) => bill.company_id === companyId && bill.deleted_at === null)
          .filter(
            (bill) =>
              !state.integrationMappings.some(
                (im) =>
                  im.company_id === bill.company_id &&
                  im.provider === 'qbo' &&
                  im.entity_type === 'material_bill' &&
                  im.local_ref === bill.id &&
                  im.deleted_at === null,
              ),
          )
          .map((bill) => ({
            id: bill.id,
            vendor_name: bill.vendor_name,
            amount: bill.amount,
            description: bill.description,
            occurred_on: bill.occurred_on,
          }))
        return { rows: rows as Row[], rowCount: rows.length }
      }

      // 3. Vendor mapping cache lookup
      if (sql.includes("entity_type = 'qbo_vendor'") && sql.toLowerCase().includes('select')) {
        const companyId = String(params[0])
        const localRef = String(params[1])
        const match = state.integrationMappings.find(
          (row) =>
            row.company_id === companyId &&
            row.provider === 'qbo' &&
            row.entity_type === 'qbo_vendor' &&
            row.local_ref === localRef &&
            row.deleted_at === null,
        )
        return { rows: (match ? [{ external_id: match.external_id }] : []) as Row[] }
      }

      // 4. Insert/upsert vendor mapping
      if (sql.includes("'qbo_vendor'") && sql.toLowerCase().includes('insert into integration_mappings')) {
        state.integrationMappings.push({
          company_id: String(params[0]),
          provider: 'qbo',
          entity_type: 'qbo_vendor',
          local_ref: String(params[1]),
          external_id: String(params[2]),
          label: String(params[3] ?? ''),
          status: 'active',
          notes: 'resolved via material-bill push',
          deleted_at: null,
        })
        return { rows: [] as Row[] }
      }

      // 5. Insert/upsert material_bill mapping
      if (sql.includes("'material_bill'") && sql.toLowerCase().includes('insert into integration_mappings')) {
        state.integrationMappings.push({
          company_id: String(params[0]),
          provider: 'qbo',
          entity_type: 'material_bill',
          local_ref: String(params[1]),
          external_id: String(params[2]),
          label: String(params[3] ?? ''),
          status: 'active',
          notes: 'pushed via /sync/material-bills',
          deleted_at: null,
        })
        return { rows: [] as Row[] }
      }

      // 6. Outbox transition
      if (sql.includes('update mutation_outbox')) {
        const companyId = String(params[0])
        const entityId = String(params[1])
        for (const row of state.outbox) {
          if (
            row.company_id === companyId &&
            row.entity_type === 'material_bill' &&
            row.entity_id === entityId &&
            row.status === 'pending'
          ) {
            row.status = 'applied'
            row.processed_at = new Date().toISOString()
          }
        }
        return { rows: [] as Row[] }
      }

      // 7. Sync event
      if (sql.includes('insert into sync_events')) {
        state.syncEvents.push({
          company_id: String(params[0]),
          direction: 'local',
          entity_type: 'material_bill',
          entity_id: String(params[1]),
          payload: JSON.parse(String(params[2])),
          status: 'applied',
        })
        return { rows: [] as Row[] }
      }

      throw new Error(`Unhandled SQL in mock runner: ${sql.slice(0, 120)}...`)
    },
  }
}

/**
 * Tiny localhost HTTP mock of the QBO sandbox. We bind to port 0 so the OS
 * picks a free port; tests resolve `baseUrl` from the actual address. The
 * mock is deliberately permissive: any /v3/company/.../bill POST returns a
 * canned Bill payload echoing the inbound amount, so tests can assert that
 * material_bills rows land with the same amount.
 */
type QboMock = {
  baseUrl: string
  close: () => Promise<void>
  receivedBills: Array<{ amount: number; vendorRef: string; description: string | null }>
}

function startQboMock(): Promise<QboMock> {
  const receivedBills: QboMock['receivedBills'] = []
  let nextBillId = 1000
  let nextVendorId = 5000

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const url = req.url ?? ''
      // /v3/company/:realm/query?query=...
      if (req.method === 'GET' && url.includes('/query?')) {
        // Always return "no vendor found" to force the create-on-miss path.
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ QueryResponse: {} }))
        return
      }
      if (req.method === 'POST' && url.endsWith('/vendor')) {
        const vendorId = String(nextVendorId++)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Vendor: { Id: vendorId } }))
        return
      }
      if (req.method === 'POST' && url.endsWith('/bill')) {
        const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}
        const lines = (parsed.Line as Array<Record<string, unknown>>) ?? []
        const amount = Number(lines[0]?.Amount ?? 0)
        const description = (lines[0]?.Description as string | undefined) ?? null
        const vendorRef = String((parsed.VendorRef as { value?: string } | undefined)?.value ?? '')
        receivedBills.push({ amount, vendorRef, description })
        const billId = String(nextBillId++)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ Bill: { Id: billId, TotalAmt: amount } }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found', method: req.method, url }))
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        receivedBills,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => (err ? closeReject(err) : closeResolve()))
          }),
      })
    })
  })
}

describe('processQboMaterialBillSync (sandbox smoke)', () => {
  let mock: QboMock
  beforeAll(async () => {
    mock = await startQboMock()
  })
  afterAll(async () => {
    await mock.close()
  })

  it('pushes pending material bills, transitions the outbox, and persists the QBO bill ids', async () => {
    const companyId = 'company-1'
    const state: InMemoryState = {
      materialBills: [
        {
          id: 'bill-1',
          company_id: companyId,
          vendor_name: 'Stucco Supply Co',
          amount: 1234.56,
          description: 'EPS pallet',
          occurred_on: '2026-04-01',
          deleted_at: null,
        },
        {
          id: 'bill-2',
          company_id: companyId,
          vendor_name: 'Stucco Supply Co',
          amount: 800,
          description: null,
          occurred_on: '2026-04-02',
          deleted_at: null,
        },
      ],
      integrationMappings: [
        {
          company_id: companyId,
          provider: 'qbo',
          entity_type: 'qbo_account',
          local_ref: 'materials',
          external_id: 'qbo-account-42',
          label: 'Materials',
          status: 'active',
          notes: null,
          deleted_at: null,
        },
      ],
      outbox: [
        {
          id: 'outbox-1',
          company_id: companyId,
          entity_type: 'material_bill',
          entity_id: 'bill-1',
          status: 'pending',
          processed_at: null,
        },
        {
          id: 'outbox-2',
          company_id: companyId,
          entity_type: 'material_bill',
          entity_id: 'bill-2',
          status: 'pending',
          processed_at: null,
        },
      ],
      syncEvents: [],
    }

    const runner = buildInMemoryRunner(state)
    const result = await processQboMaterialBillSync(runner, {
      baseUrl: mock.baseUrl,
      realmId: 'realm-test',
      accessToken: 'token-test',
      companyId,
    })

    expect(result.synced).toBe(2)
    expect(result.errors).toEqual([])
    expect(result.applied).toHaveLength(2)

    // QBO mock observed both bills with the right amounts (this is the
    // "material_bills rows get inserted with the right amounts" assertion
    // in mock-land — we receive what the worker pushed and the loop
    // mirrors the QBO Bill.Id back into local mappings).
    expect(mock.receivedBills.map((b) => b.amount).sort((a, b) => a - b)).toEqual([800, 1234.56])

    // Outbox: pending → applied.
    expect(state.outbox.every((row) => row.status === 'applied')).toBe(true)
    expect(state.outbox.every((row) => row.processed_at !== null)).toBe(true)

    // Sync events emitted with the QBO bill id.
    expect(state.syncEvents).toHaveLength(2)
    for (const event of state.syncEvents) {
      const payload = event.payload as { action?: string; provider?: string; external_id?: string }
      expect(payload.action).toBe('push')
      expect(payload.provider).toBe('qbo')
      expect(payload.external_id).toMatch(/^\d+$/)
    }

    // Vendor was resolved exactly once (cached after the first miss/create).
    const vendorMappings = state.integrationMappings.filter((row) => row.entity_type === 'qbo_vendor')
    expect(vendorMappings).toHaveLength(1)
    expect(vendorMappings[0]?.local_ref).toBe('Stucco Supply Co')

    // Material bill mappings landed with the QBO Bill.Ids.
    const billMappings = state.integrationMappings.filter((row) => row.entity_type === 'material_bill')
    expect(billMappings).toHaveLength(2)
    expect(billMappings.map((row) => row.local_ref).sort()).toEqual(['bill-1', 'bill-2'])
  })

  it('reports an error when the Materials AccountRef mapping is missing', async () => {
    const companyId = 'company-2'
    const state: InMemoryState = {
      materialBills: [
        {
          id: 'bill-x',
          company_id: companyId,
          vendor_name: 'Test Vendor',
          amount: 50,
          description: null,
          occurred_on: '2026-04-10',
          deleted_at: null,
        },
      ],
      integrationMappings: [],
      outbox: [
        {
          id: 'ob-x',
          company_id: companyId,
          entity_type: 'material_bill',
          entity_id: 'bill-x',
          status: 'pending',
          processed_at: null,
        },
      ],
      syncEvents: [],
    }

    const runner = buildInMemoryRunner(state)
    const result = await processQboMaterialBillSync(runner, {
      baseUrl: mock.baseUrl,
      realmId: 'realm-test',
      accessToken: 'token-test',
      companyId,
    })

    expect(result.synced).toBe(0)
    expect(result.errors).toEqual([
      {
        bill_id: 'bill-x',
        error: 'no Materials account mapped — set via /api/integrations/qbo/mappings',
      },
    ])
    // Outbox row stays pending — we did not transition it.
    expect(state.outbox[0]?.status).toBe('pending')
  })
})
