import { describe, expect, it } from 'vitest'
import type pino from 'pino'
import type { Pool } from 'pg'
import { attachMutationTx } from '../mutation-tx.js'
import { handleQboMappingRoutes, type IntegrationMappingRow, type QboMappingRouteCtx } from './qbo-mappings.js'

// ---------------------------------------------------------------------------
// QBO integration_mappings CRUD covers the list / upsert / patch / delete
// surface. The route relies on caller-provided helpers (`listMappings`,
// `upsertMapping`) so we stub those directly instead of emulating SQL.
// PATCH/DELETE go through `versioned-update.ts` which calls into the SQL
// emitted from the route's update callback — those still need an in-memory
// pg double.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  mappings: IntegrationMappingRow[] = []
  syncEvents: Row[] = []
  outbox: Row[] = []
  auditEvents: Row[] = []

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // PATCH update — driven from inside the route handler
    if (/^update integration_mappings/i.test(sql) && /set\s+entity_type\s*=/i.test(sql)) {
      const [, mappingId, entityType, localRef, externalId, label, status, notes, expectedVersion] = params as [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        string | null,
        number | null,
      ]
      const row = this.mappings.find((m) => m.id === mappingId && !m.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && row.version !== expectedVersion) {
        return { rows: [], rowCount: 0 }
      }
      if (entityType !== null) row.entity_type = entityType
      if (localRef !== null) row.local_ref = localRef
      if (externalId !== null) row.external_id = externalId
      if (label !== null) row.label = label
      if (status !== null) row.status = status
      if (notes !== null) row.notes = notes
      row.version += 1
      row.updated_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
    }

    // DELETE — soft-delete via update
    if (/^update integration_mappings/i.test(sql) && /set deleted_at\s*=\s*now\(\)/i.test(sql)) {
      const [, mappingId, expectedVersion] = params as [string, string, number | null]
      const row = this.mappings.find((m) => m.id === mappingId && !m.deleted_at)
      if (!row) return { rows: [], rowCount: 0 }
      if (expectedVersion != null && row.version !== expectedVersion) {
        return { rows: [], rowCount: 0 }
      }
      row.deleted_at = new Date().toISOString()
      row.status = 'deleted'
      row.version += 1
      row.updated_at = new Date().toISOString()
      return { rows: [row], rowCount: 1 }
    }

    // checkVersion lookup (via versioned-update helper)
    if (/select version from integration_mappings/i.test(sql)) {
      const [, mappingId] = params as [string, string]
      const row = this.mappings.find((m) => m.id === mappingId && !m.deleted_at)
      return { rows: row ? [{ version: row.version }] : [], rowCount: row ? 1 : 0 }
    }

    // sync_events / mutation_outbox / audit_events inserts — record only
    if (/^\s*insert into sync_events/i.test(sql)) {
      this.syncEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      this.outbox.push({
        company_id: params[0],
        idempotency_key: params[7],
        mutation_type: params[5],
        entity_type: params[3],
        entity_id: params[4],
      })
      return { rows: [], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      this.auditEvents.push({ params })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeMapping(overrides: Partial<IntegrationMappingRow> & { id: string }): IntegrationMappingRow {
  return {
    provider: 'qbo',
    entity_type: 'customer',
    local_ref: 'local-1',
    external_id: 'ext-1',
    label: null,
    status: 'active',
    notes: null,
    version: 1,
    deleted_at: null,
    created_at: '2026-04-01T00:00:00.000Z',
    updated_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'member' = 'admin',
): {
  ctx: QboMappingRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      company: { id: 'co-1', slug: 'co', name: 'Co', created_at: '', role },
      requireRole: (allowed) => {
        if (allowed.includes(role)) return true
        responses.push({ status: 403, body: { error: 'forbidden' } })
        return false
      },
      readBody: async () => body,
      sendJson: (status, response) => {
        responses.push({ status, body: response })
      },
      checkVersion: async (_table, _where, _params, expectedVersion) => {
        // Mimic the production helper: when expectedVersion is null this
        // is a "did the row exist" check. When a version is supplied and
        // the row exists at a different version, send 409 and return false.
        const mappingId = _params[1] as string
        const row = pool.mappings.find((m) => m.id === mappingId && !m.deleted_at)
        if (!row) return true // proceed to 404
        if (expectedVersion != null && row.version !== expectedVersion) {
          responses.push({ status: 409, body: { error: 'version conflict', current_version: row.version } })
          return false
        }
        return true
      },
      listMappings: async (_companyId, _provider, entityType) => {
        return pool.mappings.filter((m) => !m.deleted_at && (entityType ? m.entity_type === entityType : true))
      },
      upsertMapping: async (_companyId, _provider, values, _executor) => {
        const existing = pool.mappings.find(
          (m) => !m.deleted_at && m.entity_type === values.entity_type && m.local_ref === values.local_ref,
        )
        if (existing) {
          existing.external_id = values.external_id
          existing.label = values.label ?? null
          existing.status = values.status ?? 'active'
          existing.notes = values.notes ?? null
          existing.version += 1
          existing.updated_at = new Date().toISOString()
          return existing
        }
        const row = makeMapping({
          id: `m-${pool.mappings.length + 1}`,
          entity_type: values.entity_type,
          local_ref: values.local_ref,
          external_id: values.external_id,
          label: values.label ?? null,
          status: values.status ?? 'active',
          notes: values.notes ?? null,
        })
        pool.mappings.push(row)
        return row
      },
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleQboMappingRoutes — GET /api/integrations/qbo/mappings', () => {
  it('returns the company mappings, optionally filtered by entity_type', async () => {
    const pool = new FakePool()
    pool.mappings.push(makeMapping({ id: 'm-1', entity_type: 'customer' }))
    pool.mappings.push(makeMapping({ id: 'm-2', entity_type: 'service_item' }))
    const { ctx, responses } = makeCtx(pool)
    await handleQboMappingRoutes(
      { method: 'GET' } as never,
      buildUrl('/api/integrations/qbo/mappings?entity_type=customer'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { mappings: IntegrationMappingRow[] }
    expect(body.mappings).toHaveLength(1)
    expect(body.mappings[0]?.id).toBe('m-1')
  })
})

describe('handleQboMappingRoutes — POST /api/integrations/qbo/mappings', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {}, 'member')
    await handleQboMappingRoutes({ method: 'POST' } as never, buildUrl('/api/integrations/qbo/mappings'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('400s when required fields are missing', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { entity_type: 'customer' })
    await handleQboMappingRoutes({ method: 'POST' } as never, buildUrl('/api/integrations/qbo/mappings'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('creates a new mapping and writes a sync_events + mutation_outbox row keyed by mapping id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      entity_type: 'customer',
      local_ref: 'cust-local-1',
      external_id: 'ext-99',
      label: 'Acme',
    })
    await handleQboMappingRoutes({ method: 'POST' } as never, buildUrl('/api/integrations/qbo/mappings'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(201)
    const created = responses[0]?.body as IntegrationMappingRow
    expect(created.external_id).toBe('ext-99')
    expect(pool.outbox).toHaveLength(1)
    expect(pool.outbox[0]?.idempotency_key).toBe(`integration_mapping:qbo:${created.id}`)
    expect(pool.outbox[0]?.entity_type).toBe('integration_mapping')
  })
})

describe('handleQboMappingRoutes — PATCH /api/integrations/qbo/mappings/:id', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {}, 'member')
    await handleQboMappingRoutes({ method: 'PATCH' } as never, buildUrl('/api/integrations/qbo/mappings/m-1'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('updates the mapping and bumps its version', async () => {
    const pool = new FakePool()
    pool.mappings.push(makeMapping({ id: 'm-1', external_id: 'ext-1' }))
    const { ctx, responses } = makeCtx(pool, { external_id: 'ext-2' })
    await handleQboMappingRoutes({ method: 'PATCH' } as never, buildUrl('/api/integrations/qbo/mappings/m-1'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.mappings[0]?.external_id).toBe('ext-2')
    expect(pool.mappings[0]?.version).toBe(2)
  })

  it('returns 404 for an unknown mapping id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, { external_id: 'ext-2' })
    await handleQboMappingRoutes(
      { method: 'PATCH' } as never,
      buildUrl('/api/integrations/qbo/mappings/m-missing'),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })

  it('returns 409 on version conflict via checkVersion', async () => {
    const pool = new FakePool()
    pool.mappings.push(makeMapping({ id: 'm-1', version: 5 }))
    const { ctx, responses } = makeCtx(pool, { external_id: 'ext-2', expected_version: 1 })
    await handleQboMappingRoutes({ method: 'PATCH' } as never, buildUrl('/api/integrations/qbo/mappings/m-1'), ctx)
    expect(responses[0]?.status).toBe(409)
  })
})

describe('handleQboMappingRoutes — DELETE /api/integrations/qbo/mappings/:id', () => {
  it('soft-deletes the mapping and emits a delete ledger row', async () => {
    const pool = new FakePool()
    pool.mappings.push(makeMapping({ id: 'm-1' }))
    const { ctx, responses } = makeCtx(pool)
    await handleQboMappingRoutes({ method: 'DELETE' } as never, buildUrl('/api/integrations/qbo/mappings/m-1'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.mappings[0]?.deleted_at).not.toBeNull()
    expect(pool.mappings[0]?.status).toBe('deleted')
    expect(pool.outbox.some((row) => row.idempotency_key === 'integration_mapping:qbo:delete:m-1')).toBe(true)
  })
})
