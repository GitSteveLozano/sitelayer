import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleQboCustomFieldRoutes, type QboCustomFieldRouteCtx } from './qbo-custom-fields.js'

// ---------------------------------------------------------------------------
// QBO custom-field mapping CRUD. The route is a thin SQL surface — three
// HTTP verbs, no workflow events. We assert RBAC, entity-type validation,
// upsert semantics, and the DELETE id-validation path.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

class FakePool {
  fields: Array<{
    id: string
    company_id: string
    entity_type: string
    field_name: string
    qbo_definition_id: string
    qbo_label: string | null
    notes: string | null
    origin: string | null
    created_at: string
    updated_at: string
  }> = []
  private nextId = 1

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

  private dispatch(sqlRaw: string, params: unknown[]): { rows: Row[]; rowCount: number } {
    const sql = sqlRaw.trim()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    if (/^select id, company_id, entity_type/i.test(sql) && /from qbo_custom_field_mappings/i.test(sql)) {
      const [companyId] = params as [string]
      const rows = this.fields.filter((f) => f.company_id === companyId)
      return { rows, rowCount: rows.length }
    }

    if (/^insert into qbo_custom_field_mappings/i.test(sql)) {
      const [companyId, entityType, fieldName, definitionId, label, notes] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string | null,
      ]
      const existing = this.fields.find(
        (f) => f.company_id === companyId && f.entity_type === entityType && f.field_name === fieldName,
      )
      if (existing) {
        existing.qbo_definition_id = definitionId
        existing.qbo_label = label
        existing.notes = notes
        existing.updated_at = new Date().toISOString()
        return { rows: [existing], rowCount: 1 }
      }
      const row = {
        id: `f-${this.nextId++}`,
        company_id: companyId,
        entity_type: entityType,
        field_name: fieldName,
        qbo_definition_id: definitionId,
        qbo_label: label,
        notes,
        origin: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      this.fields.push(row)
      return { rows: [row], rowCount: 1 }
    }

    if (/^delete from qbo_custom_field_mappings/i.test(sql)) {
      const [companyId, id] = params as [string, string]
      const idx = this.fields.findIndex((f) => f.company_id === companyId && f.id === id)
      if (idx === -1) return { rows: [], rowCount: 0 }
      const [removed] = this.fields.splice(idx, 1)
      return { rows: [{ id: removed?.id }], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  body: Record<string, unknown> = {},
  role: 'admin' | 'office' | 'member' = 'admin',
): {
  ctx: QboCustomFieldRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  pool.attach()
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
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
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

describe('handleQboCustomFieldRoutes — GET', () => {
  it('rejects non-admin/office callers with 403', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {}, 'member')
    await handleQboCustomFieldRoutes({ method: 'GET' } as never, buildUrl('/api/qbo/custom-fields'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it('returns the company mappings sorted by entity + field', async () => {
    const pool = new FakePool()
    pool.fields.push({
      id: 'f-1',
      company_id: 'co-1',
      entity_type: 'Estimate',
      field_name: 'sqft',
      qbo_definition_id: '101',
      qbo_label: 'Square Footage',
      notes: null,
      origin: null,
      created_at: '',
      updated_at: '',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleQboCustomFieldRoutes({ method: 'GET' } as never, buildUrl('/api/qbo/custom-fields'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    const body = responses[0]?.body as { mappings: Array<{ id: string }> }
    expect(body.mappings).toHaveLength(1)
    expect(body.mappings[0]?.id).toBe('f-1')
  })
})

describe('handleQboCustomFieldRoutes — PUT', () => {
  it('400s when entity_type is not in the allow-list', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      entity_type: 'NotARealEntity',
      field_name: 'sqft',
      qbo_definition_id: '101',
    })
    await handleQboCustomFieldRoutes({ method: 'PUT' } as never, buildUrl('/api/qbo/custom-fields'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('400s when field_name is empty', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      entity_type: 'Estimate',
      field_name: '',
      qbo_definition_id: '101',
    })
    await handleQboCustomFieldRoutes({ method: 'PUT' } as never, buildUrl('/api/qbo/custom-fields'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('creates a new mapping', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool, {
      entity_type: 'Estimate',
      field_name: 'sqft',
      qbo_definition_id: '101',
      qbo_label: 'Square Footage',
    })
    await handleQboCustomFieldRoutes({ method: 'PUT' } as never, buildUrl('/api/qbo/custom-fields'), ctx)
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.fields).toHaveLength(1)
    expect(pool.fields[0]?.entity_type).toBe('Estimate')
  })

  it('upserts on (company, entity_type, field_name)', async () => {
    const pool = new FakePool()
    pool.fields.push({
      id: 'f-1',
      company_id: 'co-1',
      entity_type: 'Estimate',
      field_name: 'sqft',
      qbo_definition_id: '101',
      qbo_label: 'Old',
      notes: null,
      origin: null,
      created_at: '',
      updated_at: '',
    })
    const { ctx, responses } = makeCtx(pool, {
      entity_type: 'Estimate',
      field_name: 'sqft',
      qbo_definition_id: '202',
      qbo_label: 'New',
    })
    await handleQboCustomFieldRoutes({ method: 'PUT' } as never, buildUrl('/api/qbo/custom-fields'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(pool.fields).toHaveLength(1)
    expect(pool.fields[0]?.qbo_definition_id).toBe('202')
    expect(pool.fields[0]?.qbo_label).toBe('New')
  })
})

describe('handleQboCustomFieldRoutes — DELETE', () => {
  it('400s when the path id is not a uuid', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleQboCustomFieldRoutes({ method: 'DELETE' } as never, buildUrl('/api/qbo/custom-fields/not-a-uuid'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('returns 404 for an unknown id', async () => {
    const pool = new FakePool()
    const { ctx, responses } = makeCtx(pool)
    await handleQboCustomFieldRoutes(
      { method: 'DELETE' } as never,
      buildUrl('/api/qbo/custom-fields/11111111-1111-4111-8111-111111111111'),
      ctx,
    )
    expect(responses[0]?.status).toBe(404)
  })

  it('removes the row and returns ok', async () => {
    const pool = new FakePool()
    pool.fields.push({
      id: '11111111-1111-4111-8111-111111111111',
      company_id: 'co-1',
      entity_type: 'Invoice',
      field_name: 'sqft',
      qbo_definition_id: '101',
      qbo_label: null,
      notes: null,
      origin: null,
      created_at: '',
      updated_at: '',
    })
    const { ctx, responses } = makeCtx(pool)
    await handleQboCustomFieldRoutes(
      { method: 'DELETE' } as never,
      buildUrl('/api/qbo/custom-fields/11111111-1111-4111-8111-111111111111'),
      ctx,
    )
    expect(responses[0]?.status, JSON.stringify(responses[0]?.body)).toBe(200)
    expect(pool.fields).toHaveLength(0)
  })
})
