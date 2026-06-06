import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import type { LedgerExecutor } from './mutation-tx.js'

// `backfillMapping` calls `recordMutationLedger`, which transitively touches
// the live pg Pool registered via `attachMutationTx`. We don't want a real
// Postgres for these tests — mock the ledger writer instead and just assert
// that it received the expected anchor.
vi.mock('./mutation-tx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mutation-tx.js')>()
  return {
    ...actual,
    recordMutationLedger: vi.fn(),
  }
})

import {
  backfillCustomerMapping,
  backfillDivisionMapping,
  backfillProjectMapping,
  backfillServiceItemMapping,
  listIntegrationMappings,
  upsertIntegrationMapping,
  type IntegrationMappingRow,
} from './qbo-integration-mapping.js'
import * as mutationTx from './mutation-tx.js'

/**
 * Tiny in-memory shim for the subset of `pg.Pool` / `LedgerExecutor.query`
 * the integration-mapping helpers touch. Each `query` call is feature-detected
 * by SQL substring and routed to the appropriate fixture mutation/return.
 */
type InMemoryRow = IntegrationMappingRow & { company_id: string }
type InMemoryState = { rows: InMemoryRow[]; nextId: number }

function buildPool(state: InMemoryState): Pool & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('select id, provider, entity_type, local_ref, external_id, label, status, notes')) {
      const companyId = String(params[0])
      const provider = String(params[1])
      const entityType = params[2] != null ? String(params[2]) : null
      const rows = state.rows
        .filter((r) => r.company_id === companyId && r.provider === provider && r.deleted_at === null)
        .filter((r) => (entityType ? r.entity_type === entityType : true))
        .sort((a, b) => {
          if (a.entity_type !== b.entity_type) return a.entity_type < b.entity_type ? -1 : 1
          return a.created_at < b.created_at ? -1 : 1
        })
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('insert into integration_mappings')) {
      const [companyId, provider, entityType, localRef, externalId, label, status, notes] = params as [
        string,
        string,
        string,
        string,
        string,
        string | null,
        string | null,
        string | null,
      ]
      const existing = state.rows.find(
        (r) =>
          r.company_id === companyId &&
          r.provider === provider &&
          r.entity_type === entityType &&
          r.local_ref === localRef,
      )
      if (existing) {
        existing.external_id = externalId
        if (label != null) existing.label = label
        if (status != null) existing.status = status
        if (notes != null) existing.notes = notes
        existing.version += 1
        existing.deleted_at = null
        existing.updated_at = new Date().toISOString()
        return { rows: [existing], rowCount: 1 }
      }
      const nowIso = new Date().toISOString()
      const row: InMemoryRow = {
        id: `im-${state.nextId++}`,
        company_id: companyId,
        provider,
        entity_type: entityType,
        local_ref: localRef,
        external_id: externalId,
        label,
        status: status ?? 'active',
        notes,
        version: 1,
        deleted_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      }
      state.rows.push(row)
      return { rows: [row], rowCount: 1 }
    }
    throw new Error(`Unhandled SQL: ${sql.slice(0, 80)}`)
  })
  // Cast through unknown — we only consume `query`.
  return { query } as unknown as Pool & { query: ReturnType<typeof vi.fn> }
}

describe('listIntegrationMappings', () => {
  it('filters by company + provider and returns active rows only', async () => {
    const state: InMemoryState = { rows: [], nextId: 1 }
    const pool = buildPool(state)

    await upsertIntegrationMapping(pool, 'co-1', 'qbo', {
      entity_type: 'customer',
      local_ref: 'cust-1',
      external_id: 'qbo-100',
    })
    await upsertIntegrationMapping(pool, 'co-1', 'qbo', {
      entity_type: 'service_item',
      local_ref: 'svc-1',
      external_id: 'qbo-200',
    })

    const all = await listIntegrationMappings(pool, 'co-1', 'qbo')
    expect(all.map((r) => r.entity_type).sort()).toEqual(['customer', 'service_item'])
  })

  it('filters by entity_type when provided', async () => {
    const state: InMemoryState = { rows: [], nextId: 1 }
    const pool = buildPool(state)

    await upsertIntegrationMapping(pool, 'co-1', 'qbo', {
      entity_type: 'customer',
      local_ref: 'cust-1',
      external_id: 'qbo-100',
    })
    await upsertIntegrationMapping(pool, 'co-1', 'qbo', {
      entity_type: 'service_item',
      local_ref: 'svc-1',
      external_id: 'qbo-200',
    })

    const onlyCustomers = await listIntegrationMappings(pool, 'co-1', 'qbo', 'customer')
    expect(onlyCustomers).toHaveLength(1)
    expect(onlyCustomers[0]?.entity_type).toBe('customer')
  })
})

describe('upsertIntegrationMapping', () => {
  it('inserts a new row, then updates and bumps version on conflict', async () => {
    const state: InMemoryState = { rows: [], nextId: 1 }
    const pool = buildPool(state)

    const first = await upsertIntegrationMapping(pool, 'co-1', 'qbo', {
      entity_type: 'customer',
      local_ref: 'cust-1',
      external_id: 'qbo-100',
      label: 'Acme',
      notes: 'first import',
    })
    expect(first.version).toBe(1)
    expect(first.external_id).toBe('qbo-100')
    expect(first.label).toBe('Acme')

    const second = await upsertIntegrationMapping(pool, 'co-1', 'qbo', {
      entity_type: 'customer',
      local_ref: 'cust-1',
      external_id: 'qbo-101',
      label: 'Acme Renamed',
    })
    expect(second.id).toBe(first.id)
    expect(second.version).toBe(2)
    expect(second.external_id).toBe('qbo-101')
    expect(second.label).toBe('Acme Renamed')
  })
})

describe('backfill helpers', () => {
  let state: InMemoryState
  let pool: Pool & { query: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    state = { rows: [], nextId: 1 }
    pool = buildPool(state)
    vi.mocked(mutationTx.recordMutationLedger).mockClear()
  })

  afterEach(() => {
    vi.mocked(mutationTx.recordMutationLedger).mockClear()
  })

  it('backfillCustomerMapping returns null when external_id is missing (skip condition)', async () => {
    const result = await backfillCustomerMapping(pool, 'co-1', {
      id: 'cust-1',
      external_id: null,
      name: 'Acme',
    })
    expect(result).toBeNull()
    expect(state.rows).toHaveLength(0)
    expect(mutationTx.recordMutationLedger).not.toHaveBeenCalled()
  })

  it('backfillCustomerMapping records customer entity_type and label from name', async () => {
    const executor = pool as unknown as LedgerExecutor
    const result = await backfillCustomerMapping(
      pool,
      'co-1',
      { id: 'cust-1', external_id: 'qbo-100', name: 'Acme Construction' },
      executor,
    )
    expect(result).not.toBeNull()
    expect(result?.entity_type).toBe('customer')
    expect(result?.local_ref).toBe('cust-1')
    expect(result?.external_id).toBe('qbo-100')
    expect(result?.label).toBe('Acme Construction')
    expect(result?.notes).toBe('backfilled from customer external_id')
    expect(mutationTx.recordMutationLedger).toHaveBeenCalledTimes(1)
    const ledgerCall = vi.mocked(mutationTx.recordMutationLedger).mock.calls[0]!
    expect(ledgerCall[1]).toMatchObject({
      companyId: 'co-1',
      entityType: 'integration_mapping',
      entityId: result?.id,
      action: 'upsert',
      idempotencyKey: `integration_mapping:qbo:${result?.id}`,
    })
  })

  it('backfillServiceItemMapping resolves external_id from the qbo- prefix on the code', async () => {
    const result = await backfillServiceItemMapping(pool, 'co-1', {
      code: 'qbo-555',
      name: 'Drywall',
    })
    expect(result).not.toBeNull()
    expect(result?.entity_type).toBe('service_item')
    expect(result?.local_ref).toBe('qbo-555')
    expect(result?.external_id).toBe('555')
    expect(result?.label).toBe('Drywall')
    expect(result?.notes).toBe('backfilled from qbo-prefixed service_item')
  })

  it('backfillServiceItemMapping returns null when neither externalId nor qbo- prefix resolves', async () => {
    const result = await backfillServiceItemMapping(pool, 'co-1', {
      code: 'custom-item',
      name: 'Custom',
    })
    expect(result).toBeNull()
    expect(state.rows).toHaveLength(0)
  })

  it('backfillServiceItemMapping uses the qbo-import note when source=qbo', async () => {
    const result = await backfillServiceItemMapping(
      pool,
      'co-1',
      { code: 'svc-1', name: 'Concrete', source: 'qbo' },
      'qbo-77',
    )
    expect(result?.notes).toBe('backfilled from qbo service_item import')
    expect(result?.external_id).toBe('qbo-77')
  })

  it('backfillDivisionMapping uses division entity_type and class-sync notes', async () => {
    const result = await backfillDivisionMapping(pool, 'co-1', { code: 'STUCCO', name: 'Stucco' }, 'qbo-class-9')
    expect(result?.entity_type).toBe('division')
    expect(result?.local_ref).toBe('STUCCO')
    expect(result?.external_id).toBe('qbo-class-9')
    expect(result?.label).toBe('Stucco')
    expect(result?.notes).toBe('backfilled from qbo class sync')
  })

  it('backfillProjectMapping uses project entity_type and estimate-push notes', async () => {
    const result = await backfillProjectMapping(pool, 'co-1', { id: 'proj-1', name: '123 Main St' }, 'qbo-customer-22')
    expect(result?.entity_type).toBe('project')
    expect(result?.local_ref).toBe('proj-1')
    expect(result?.external_id).toBe('qbo-customer-22')
    expect(result?.label).toBe('123 Main St')
    expect(result?.notes).toBe('backfilled from qbo estimate push')
  })
})
