import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { handleCompanyRoutes, type CompanyRouteCtx } from './companies.js'

// Route-level coverage for the per-company QBO overtime mapping
// (PATCH /api/companies/:id/settings). The endpoint backs the
// `ot_service_item_code` column added in migration 070 — see
// docker/postgres/init/070_labor_ot_service_item_code.sql.
//
// The fake pool below answers the four query shapes the route runs:
//   1. role lookup on company_memberships
//   2. service_items existence check (validates the code before write)
//   3. companies SELECT for the GET endpoint + the PATCH "before" snapshot
//   4. companies UPDATE for the PATCH
//   5. audit_events INSERT (recordAudit, fires through entityType='company')
//
// Other shapes throw so a regression in the route surfaces as a
// noisy test failure rather than a silent no-op.

type CompanyRow = {
  id: string
  ot_service_item_code: string | null
  modules?: Record<string, boolean>
  slug?: string
  name?: string
}
type ServiceItemRow = { company_id: string; code: string }
type MembershipRow = { company_id: string; clerk_user_id: string; role: string }
type UsageLogRow = {
  company_id: string
  operation: string
  cost_usd: number
  /** Optional override; defaults to "now" so the rollup filter
   *  (`created_at >= date_trunc('month', now())`) includes it. */
  created_at?: Date
}

class FakePool {
  companies: CompanyRow[] = []
  serviceItems: ServiceItemRow[] = []
  memberships: MembershipRow[] = []
  audit: Array<{ entityType: string; action: string; before: unknown; after: unknown }> = []
  usageLog: UsageLogRow[] = []

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim()

    // GET /api/me/memberships — multi-company switcher feed.
    // Distinguished from the generic `select role from company_memberships`
    // shape below by the `join companies c` clause.
    if (
      /^select c\.id as company_id, c\.slug as company_slug, c\.name as company_name, cm\.role/i.test(trimmed) &&
      /from company_memberships cm/i.test(trimmed) &&
      /join companies c/i.test(trimmed)
    ) {
      const [userId] = params as [string]
      const rows = this.memberships
        .filter((m) => m.clerk_user_id === userId)
        .map((m) => {
          const c = this.companies.find((x) => x.id === m.company_id)
          return {
            company_id: m.company_id,
            company_slug: c?.slug ?? '',
            company_name: c?.name ?? '',
            role: m.role,
          }
        })
        .sort((a, b) => a.company_name.localeCompare(b.company_name))
      return { rows, rowCount: rows.length }
    }

    if (/^select role from company_memberships/i.test(trimmed)) {
      const [companyId, userId] = params as [string, string]
      const m = this.memberships.find((r) => r.company_id === companyId && r.clerk_user_id === userId)
      return { rows: m ? [{ role: m.role }] : [], rowCount: m ? 1 : 0 }
    }

    if (/^select code from service_items/i.test(trimmed)) {
      const [companyId, code] = params as [string, string]
      const r = this.serviceItems.find((x) => x.company_id === companyId && x.code === code)
      return { rows: r ? [{ code: r.code }] : [], rowCount: r ? 1 : 0 }
    }

    // GET /api/companies/:id/usage rollup — group by operation over the
    // calendar month. Mirrors the route's SQL: count + sum filtered to
    // month-to-date. Returns numeric totals as strings to match pg's
    // numeric round-trip, so the route's Number() coercion is exercised.
    if (
      /^select operation,/i.test(trimmed) &&
      /count\(\*\) as count/i.test(trimmed) &&
      /from company_usage_log/i.test(trimmed)
    ) {
      const [companyId] = params as [string]
      const now = new Date()
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      const grouped = new Map<string, { count: number; total: number }>()
      for (const row of this.usageLog) {
        if (row.company_id !== companyId) continue
        const ts = row.created_at ?? new Date()
        if (ts < monthStart) continue
        const acc = grouped.get(row.operation) ?? { count: 0, total: 0 }
        acc.count += 1
        acc.total += Number(row.cost_usd)
        grouped.set(row.operation, acc)
      }
      const rows = [...grouped.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([operation, v]) => ({
          operation,
          count: v.count,
          total_usd: v.total.toString(),
        }))
      return { rows, rowCount: rows.length }
    }

    if (/^select ot_service_item_code from companies/i.test(trimmed)) {
      const [id] = params as [string]
      const c = this.companies.find((x) => x.id === id)
      return {
        rows: c ? [{ ot_service_item_code: c.ot_service_item_code }] : [],
        rowCount: c ? 1 : 0,
      }
    }

    if (/^update companies set ot_service_item_code/i.test(trimmed)) {
      const [id, code] = params as [string, string | null]
      const c = this.companies.find((x) => x.id === id)
      if (!c) return { rows: [], rowCount: 0 }
      c.ot_service_item_code = code
      return { rows: [{ ot_service_item_code: c.ot_service_item_code }], rowCount: 1 }
    }

    if (/^\s*insert into audit_events/i.test(trimmed)) {
      const [, , , entityType, , action, beforeJson, afterJson] = params as [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string | null,
        string | null,
      ]
      this.audit.push({
        entityType,
        action,
        before: beforeJson ? JSON.parse(beforeJson) : null,
        after: afterJson ? JSON.parse(afterJson) : null,
      })
      return { rows: [], rowCount: 0 }
    }

    throw new Error(`unexpected SQL: ${trimmed.slice(0, 200)}`)
  }
}

function makeCtx(
  pool: FakePool,
  userId = 'user_admin',
  body: Record<string, unknown> = {},
): {
  ctx: CompanyRouteCtx
  responses: Array<{ status: number; body: unknown }>
} {
  const responses: Array<{ status: number; body: unknown }> = []
  return {
    responses,
    ctx: {
      pool: pool as unknown as Pool,
      userId,
      sendJson: (status, b) => {
        responses.push({ status, body: b })
      },
      readBody: async () => body,
    },
  }
}

function buildUrl(path: string): URL {
  return new URL(`http://localhost${path}`)
}

function seedAdmin(pool: FakePool, companyId = 'co-1', userId = 'user_admin', code: string | null = null) {
  pool.companies.push({ id: companyId, ot_service_item_code: code })
  pool.memberships.push({ company_id: companyId, clerk_user_id: userId, role: 'admin' })
}

describe('PATCH /api/companies/:id/settings — ot_service_item_code', () => {
  it('accepts a valid service_items.code and persists it', async () => {
    const pool = new FakePool()
    seedAdmin(pool)
    pool.serviceItems.push({ company_id: 'co-1', code: 'LBR-OT' })
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: 'LBR-OT' })

    const handled = await handleCompanyRoutes(
      { method: 'PATCH' } as never,
      buildUrl('/api/companies/co-1/settings'),
      ctx,
    )
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({ ot_service_item_code: 'LBR-OT' })
    expect(pool.companies[0]?.ot_service_item_code).toBe('LBR-OT')
    expect(pool.audit[0]?.entityType).toBe('company')
    expect(pool.audit[0]?.action).toBe('update_settings')
  })

  it('accepts null to clear the OT mapping', async () => {
    const pool = new FakePool()
    seedAdmin(pool, 'co-1', 'user_admin', 'LBR-OT')
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: null })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({ ot_service_item_code: null })
    expect(pool.companies[0]?.ot_service_item_code).toBeNull()
  })

  it('normalizes empty string to null', async () => {
    const pool = new FakePool()
    seedAdmin(pool, 'co-1', 'user_admin', 'LBR-OT')
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: '' })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(pool.companies[0]?.ot_service_item_code).toBeNull()
  })

  it('rejects an unknown service_items.code with 400', async () => {
    const pool = new FakePool()
    seedAdmin(pool)
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: 'NOPE' })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(400)
    expect(pool.companies[0]?.ot_service_item_code).toBeNull()
  })

  it('rejects non-string non-null values with 400', async () => {
    const pool = new FakePool()
    seedAdmin(pool)
    const { ctx, responses } = makeCtx(pool, 'user_admin', { ot_service_item_code: 42 })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('requires the ot_service_item_code key in the body (400 when omitted)', async () => {
    const pool = new FakePool()
    seedAdmin(pool)
    const { ctx, responses } = makeCtx(pool, 'user_admin', {})

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(400)
  })

  it('rejects non-admin members with 403', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', ot_service_item_code: null })
    pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'user_member', role: 'member' })
    pool.serviceItems.push({ company_id: 'co-1', code: 'LBR-OT' })
    const { ctx, responses } = makeCtx(pool, 'user_member', { ot_service_item_code: 'LBR-OT' })

    await handleCompanyRoutes({ method: 'PATCH' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(403)
    expect(pool.companies[0]?.ot_service_item_code).toBeNull()
  })
})

// Separate FakePool dedicated to the POST /api/companies path. It needs
// `connect()` (the create-company route runs in an explicit transaction
// for slug-uniqueness + membership + seeds) plus a handful of SQL shapes
// that the settings tests above don't exercise.
class CreateCompanyFakePool {
  companies: Array<{ id: string; slug: string; name: string; created_at: string }> = []
  memberships: Array<{ id: string; company_id: string; clerk_user_id: string; role: string }> = []
  audit: Array<{ entityType: string; action: string }> = []
  outbox: Array<{
    company_id: string
    entity_type: string
    entity_id: string
    mutation_type: string
    payload: Record<string, unknown>
    idempotency_key: string
    actor_user_id: string | null
  }> = []
  nextId = 1

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  private dispatch(sqlRaw: string, params: unknown[]): { rows: unknown[]; rowCount: number } {
    const sql = sqlRaw.trim()
    if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
      return { rows: [], rowCount: 0 }
    }
    if (/^select id from companies where slug = \$1/i.test(sql)) {
      const [slug] = params as [string]
      const found = this.companies.find((c) => c.slug === slug)
      return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 }
    }
    if (/^insert into companies/i.test(sql)) {
      const [slug, name] = params as [string, string]
      const row = {
        id: `co-${this.nextId++}`,
        slug,
        name,
        created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      }
      this.companies.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (/^insert into company_memberships/i.test(sql)) {
      const [companyId, userId, role] = params as [string, string, string]
      const row = { id: `m-${this.nextId++}`, company_id: companyId, clerk_user_id: userId, role }
      this.memberships.push(row)
      return { rows: [row], rowCount: 1 }
    }
    if (/^\s*insert into audit_events/i.test(sql)) {
      const entityType = (params[3] as string) ?? 'unknown'
      const action = (params[5] as string) ?? 'unknown'
      this.audit.push({ entityType, action })
      return { rows: [], rowCount: 0 }
    }
    // Permit the recordMutationOutbox welcome-email enqueue + any
    // seed-defaults inserts that ride through on the happy path. We
    // explicitly set seed_defaults: false in the tests below to keep
    // the SQL surface small, but the welcome-email outbox row is
    // emitted unconditionally so the fake pool has to absorb it.
    if (/^\s*insert into mutation_outbox/i.test(sql)) {
      // recordMutationOutbox positional args: (companyId, deviceId,
      // actorUserId, entityType, entityId, mutationType, payloadJson,
      // idempotencyKey, sentryTrace, baggage, requestId).
      const [companyId, , actorUserId, entityType, entityId, mutationType, payloadJson, idempotencyKey] = params as [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string,
        string,
      ]
      let parsedPayload: Record<string, unknown>
      try {
        parsedPayload = JSON.parse(payloadJson) as Record<string, unknown>
      } catch {
        parsedPayload = {}
      }
      this.outbox.push({
        company_id: companyId,
        entity_type: entityType,
        entity_id: entityId,
        mutation_type: mutationType,
        payload: parsedPayload,
        idempotency_key: idempotencyKey,
        actor_user_id: actorUserId,
      })
      return { rows: [], rowCount: 0 }
    }
    if (/^insert into/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected SQL in CreateCompanyFakePool: ${sql.slice(0, 200)}`)
  }
}

describe('POST /api/companies — slug collision', () => {
  it('returns 409 with a suggested_slug when the requested slug is taken', async () => {
    const pool = new CreateCompanyFakePool()
    pool.companies.push({
      id: 'co-existing',
      slug: 'acme-builders',
      name: 'Existing ACME',
      created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    })
    const { ctx, responses } = makeCtx(pool as unknown as FakePool, 'user_admin', {
      slug: 'acme-builders',
      name: 'New ACME',
      seed_defaults: false,
    })

    const handled = await handleCompanyRoutes({ method: 'POST' } as never, buildUrl('/api/companies'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(409)
    expect(responses[0]?.body).toEqual({ error: 'slug already taken', suggested_slug: 'acme-builders-2' })
  })

  it('walks past taken suffixes to find the first free candidate', async () => {
    const pool = new CreateCompanyFakePool()
    for (const slug of ['acme', 'acme-2', 'acme-3', 'acme-4']) {
      pool.companies.push({
        id: `co-${slug}`,
        slug,
        name: slug,
        created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      })
    }
    const { ctx, responses } = makeCtx(pool as unknown as FakePool, 'user_admin', {
      slug: 'acme',
      name: 'ACME',
      seed_defaults: false,
    })

    await handleCompanyRoutes({ method: 'POST' } as never, buildUrl('/api/companies'), ctx)
    expect(responses[0]?.status).toBe(409)
    expect((responses[0]?.body as { suggested_slug?: string }).suggested_slug).toBe('acme-5')
  })

  it('falls back to the generic 409 (no suggested_slug) when -2..-10 are all taken', async () => {
    const pool = new CreateCompanyFakePool()
    pool.companies.push({
      id: 'co-acme',
      slug: 'acme',
      name: 'ACME',
      created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    })
    for (let i = 2; i <= 10; i += 1) {
      pool.companies.push({
        id: `co-acme-${i}`,
        slug: `acme-${i}`,
        name: `ACME ${i}`,
        created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      })
    }
    const { ctx, responses } = makeCtx(pool as unknown as FakePool, 'user_admin', {
      slug: 'acme',
      name: 'ACME',
      seed_defaults: false,
    })

    await handleCompanyRoutes({ method: 'POST' } as never, buildUrl('/api/companies'), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(responses[0]?.body).toEqual({ error: 'slug already in use' })
  })

  it('creates the company on the happy path (no collision)', async () => {
    const pool = new CreateCompanyFakePool()
    const { ctx, responses } = makeCtx(pool as unknown as FakePool, 'user_admin', {
      slug: 'fresh-co',
      name: 'Fresh Co',
      seed_defaults: false,
    })

    await handleCompanyRoutes({ method: 'POST' } as never, buildUrl('/api/companies'), ctx)
    expect(responses[0]?.status).toBe(201)
    const body = responses[0]?.body as { company: { slug: string }; role: string }
    expect(body.company.slug).toBe('fresh-co')
    expect(body.role).toBe('admin')
  })
})

describe('POST /api/companies — welcome_email outbox enqueue', () => {
  it('enqueues exactly one welcome_email mutation_outbox row with the expected idempotency key', async () => {
    const pool = new CreateCompanyFakePool()
    const { ctx, responses } = makeCtx(pool as unknown as FakePool, 'user_owner', {
      slug: 'welcome-co',
      name: 'Welcome Co',
      seed_defaults: false,
    })

    await handleCompanyRoutes({ method: 'POST' } as never, buildUrl('/api/companies'), ctx)
    expect(responses[0]?.status).toBe(201)

    const welcomeRows = pool.outbox.filter((row) => row.mutation_type === 'welcome_email')
    expect(welcomeRows).toHaveLength(1)
    const row = welcomeRows[0]!
    expect(row.entity_type).toBe('company')
    expect(row.entity_id).toBe(pool.companies[0]!.id)
    expect(row.company_id).toBe(pool.companies[0]!.id)
    expect(row.actor_user_id).toBe('user_owner')
    expect(row.idempotency_key).toBe(`welcome_email:user_owner:${pool.companies[0]!.id}`)
    expect(row.payload).toEqual({
      user_id: 'user_owner',
      company_id: pool.companies[0]!.id,
      company_name: 'Welcome Co',
    })
    // PII hygiene: the row must not carry the user's email verbatim.
    expect(JSON.stringify(row.payload)).not.toMatch(/@/)
  })

  it('does not emit a welcome_email row when the slug collides (no company was created)', async () => {
    const pool = new CreateCompanyFakePool()
    pool.companies.push({
      id: 'co-existing',
      slug: 'acme-builders',
      name: 'Existing ACME',
      created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    })
    const { ctx, responses } = makeCtx(pool as unknown as FakePool, 'user_owner', {
      slug: 'acme-builders',
      name: 'New ACME',
      seed_defaults: false,
    })

    await handleCompanyRoutes({ method: 'POST' } as never, buildUrl('/api/companies'), ctx)
    expect(responses[0]?.status).toBe(409)
    expect(pool.outbox.filter((row) => row.mutation_type === 'welcome_email')).toHaveLength(0)
  })
})

describe('GET /api/companies/:id/settings', () => {
  it('returns the current ot_service_item_code for any member', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', ot_service_item_code: 'LBR-OT' })
    pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'user_member', role: 'member' })
    const { ctx, responses } = makeCtx(pool, 'user_member')

    const handled = await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({ ot_service_item_code: 'LBR-OT' })
  })

  it('returns 403 for non-members', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', ot_service_item_code: null })
    const { ctx, responses } = makeCtx(pool, 'user_stranger')

    await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/companies/co-1/settings'), ctx)
    expect(responses[0]?.status).toBe(403)
  })
})

describe('GET /api/companies/:id/usage', () => {
  it('groups month-to-date cost rows by operation and reports the total', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', ot_service_item_code: null })
    pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'user_member', role: 'member' })
    pool.usageLog.push(
      { company_id: 'co-1', operation: 'qbo_api_call', cost_usd: 0.05 },
      { company_id: 'co-1', operation: 'qbo_api_call', cost_usd: 0.05 },
      { company_id: 'co-1', operation: 'blueprint_vision_page', cost_usd: 1.25 },
    )

    const { ctx, responses } = makeCtx(pool, 'user_member')
    const handled = await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/companies/co-1/usage'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as {
      month_to_date: {
        total_usd: number
        by_operation: Array<{ operation: string; count: number; total_usd: number }>
      }
    }
    expect(body.month_to_date.by_operation).toEqual([
      { operation: 'blueprint_vision_page', count: 1, total_usd: 1.25 },
      { operation: 'qbo_api_call', count: 2, total_usd: 0.1 },
    ])
    // Total math: 0.05 + 0.05 + 1.25 = 1.35. Use toBeCloseTo because pg
    // numeric round-trips as a string and Number() parses it inexactly.
    expect(body.month_to_date.total_usd).toBeCloseTo(1.35, 6)
  })

  it('returns zeros (empty by_operation, total 0) when the company has no logged usage', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-empty', ot_service_item_code: null })
    pool.memberships.push({ company_id: 'co-empty', clerk_user_id: 'user_member', role: 'member' })

    const { ctx, responses } = makeCtx(pool, 'user_member')
    await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/companies/co-empty/usage'), ctx)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({
      month_to_date: { total_usd: 0, by_operation: [] },
    })
  })

  it('rejects non-members with 403 and never returns usage data', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-1', ot_service_item_code: null })
    pool.usageLog.push({ company_id: 'co-1', operation: 'qbo_api_call', cost_usd: 0.05 })

    const { ctx, responses } = makeCtx(pool, 'user_stranger')
    await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/companies/co-1/usage'), ctx)
    expect(responses[0]?.status).toBe(403)
  })

  it("scopes rows to the requested company (a different tenant's spend never leaks)", async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-a', ot_service_item_code: null }, { id: 'co-b', ot_service_item_code: null })
    pool.memberships.push({ company_id: 'co-a', clerk_user_id: 'user_a', role: 'admin' })
    pool.usageLog.push(
      { company_id: 'co-a', operation: 'qbo_api_call', cost_usd: 0.05 },
      { company_id: 'co-b', operation: 'qbo_api_call', cost_usd: 9.99 },
    )

    const { ctx, responses } = makeCtx(pool, 'user_a')
    await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/companies/co-a/usage'), ctx)
    expect(responses[0]?.status).toBe(200)
    const body = responses[0]?.body as {
      month_to_date: { total_usd: number; by_operation: Array<{ operation: string; total_usd: number }> }
    }
    expect(body.month_to_date.by_operation).toEqual([{ operation: 'qbo_api_call', count: 1, total_usd: 0.05 }])
    expect(body.month_to_date.total_usd).toBeCloseTo(0.05, 6)
  })
})

describe('GET /api/me/memberships', () => {
  it('returns the memberships for the authenticated user, sorted by company name', async () => {
    const pool = new FakePool()
    // Insert in non-alphabetical order to verify the route asks the
    // database to sort by company name. The handler's contract is
    // "alphabetical for stable UX in the switcher dropdown".
    pool.companies.push({ id: 'co-globex', slug: 'globex', name: 'Globex Inc', ot_service_item_code: null })
    pool.companies.push({ id: 'co-acme', slug: 'acme-co', name: 'Acme Co', ot_service_item_code: null })
    pool.memberships.push({ company_id: 'co-globex', clerk_user_id: 'user_multi', role: 'foreman' })
    pool.memberships.push({ company_id: 'co-acme', clerk_user_id: 'user_multi', role: 'admin' })
    // Decoy: another user's memberships must not leak into this user's
    // response. This is the row that proves the pool-level read respects
    // the WHERE clerk_user_id filter even though it runs without the
    // company GUC set (migration 066's IS NULL fallback policy).
    pool.companies.push({ id: 'co-other', slug: 'other-co', name: 'Other Co', ot_service_item_code: null })
    pool.memberships.push({ company_id: 'co-other', clerk_user_id: 'user_someone_else', role: 'admin' })

    const { ctx, responses } = makeCtx(pool, 'user_multi')

    const handled = await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/me/memberships'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({
      memberships: [
        { company_id: 'co-acme', company_slug: 'acme-co', company_name: 'Acme Co', role: 'admin' },
        { company_id: 'co-globex', company_slug: 'globex', company_name: 'Globex Inc', role: 'foreman' },
      ],
    })
  })

  it('returns an empty list when the user has no memberships', async () => {
    const pool = new FakePool()
    pool.companies.push({ id: 'co-acme', slug: 'acme-co', name: 'Acme Co', ot_service_item_code: null })
    // Note: no memberships for `user_orphan`.

    const { ctx, responses } = makeCtx(pool, 'user_orphan')

    const handled = await handleCompanyRoutes({ method: 'GET' } as never, buildUrl('/api/me/memberships'), ctx)
    expect(handled).toBe(true)
    expect(responses[0]?.status).toBe(200)
    expect(responses[0]?.body).toEqual({ memberships: [] })
  })
})
