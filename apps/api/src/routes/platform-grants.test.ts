import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { Identity } from '../auth.js'
import { handlePlatformGrantRoutes, type PlatformGrantRouteDeps } from './platform-grants.js'

// ---------------------------------------------------------------------------
// Platform-grant (app_issue.*) API coverage. The superadmin gate is
// authorizePlatformAdmin on the RAW identity — a verified Clerk session whose
// `sub` is in the env allowlist. A non-Clerk identity short-circuits to 401, so
// app_issue.* caps are unreachable via a company role / header / dev act-as.
// FakePool models the platform_admin_grants rows in memory.
// ---------------------------------------------------------------------------

const clerkAdmin: Identity = { userId: 'admin-sub', source: 'clerk' }
const ENV_IDS = new Set(['admin-sub'])

class FakePool {
  grants: Array<{ clerk_user_id: string; capability: string; created_at: string }> = []
  queries: string[] = []
  async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[]; rowCount?: number }> {
    this.queries.push(text)
    const sql = text.trim()

    // superadmin membership lookup (envIds covers admin-sub, so no DB hit needed,
    // but the gate may still query platform_admins for a non-env sub)
    if (/from platform_admins/i.test(sql)) {
      return { rows: [] }
    }

    if (/select clerk_user_id, capability, created_at\s+from platform_admin_grants\s+order by/i.test(sql)) {
      return { rows: [...this.grants] }
    }

    if (/^insert into platform_admin_grants/i.test(sql)) {
      const [clerkUserId, capability] = values as [string, string]
      const existing = this.grants.find((g) => g.clerk_user_id === clerkUserId && g.capability === capability)
      if (existing) return { rows: [] } // on conflict do nothing
      const row = { clerk_user_id: clerkUserId, capability, created_at: '2026-06-06T00:00:00.000Z' }
      this.grants.push(row)
      return { rows: [row] }
    }

    if (/^select clerk_user_id, capability, created_at from platform_admin_grants\s+where/i.test(sql)) {
      const [clerkUserId, capability] = values as [string, string]
      const row = this.grants.find((g) => g.clerk_user_id === clerkUserId && g.capability === capability)
      return { rows: row ? [row] : [] }
    }

    if (/^delete from platform_admin_grants/i.test(sql)) {
      const [clerkUserId, capability] = values as [string, string]
      const before = this.grants.length
      this.grants = this.grants.filter((g) => !(g.clerk_user_id === clerkUserId && g.capability === capability))
      return { rows: [], rowCount: before - this.grants.length }
    }

    return { rows: [] }
  }
}

function capture() {
  const calls: Array<{ status: number; body: unknown }> = []
  const sendJson = (status: number, body: unknown) => calls.push({ status, body })
  return { calls, sendJson }
}

function req(method: string): IncomingMessage {
  return { method } as IncomingMessage
}

function deps(pool: FakePool, over: Partial<PlatformGrantRouteDeps> = {}): PlatformGrantRouteDeps {
  const { sendJson } = capture()
  return {
    pool: pool as unknown as PlatformGrantRouteDeps['pool'],
    identity: clerkAdmin,
    sendJson,
    envIds: ENV_IDS,
    ...over,
  }
}

const u = (p: string) => new URL(`http://x${p}`)

describe('handlePlatformGrantRoutes — namespace + gate', () => {
  it('ignores non-platform-grant paths (returns false, no response)', async () => {
    const { calls, sendJson } = capture()
    const handled = await handlePlatformGrantRoutes(
      req('GET'),
      u('/api/admin/companies'),
      deps(new FakePool(), { sendJson }),
    )
    expect(handled).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('non-Clerk identity → 401 (app_issue.* unreachable via header / act-as)', async () => {
    const { calls, sendJson } = capture()
    await handlePlatformGrantRoutes(
      req('GET'),
      u('/api/admin/platform-grants'),
      deps(new FakePool(), { sendJson, identity: { userId: 'x', source: 'header' } }),
    )
    expect(calls[0]?.status).toBe(401)
  })

  it('Clerk but not a superadmin → 403', async () => {
    const { calls, sendJson } = capture()
    await handlePlatformGrantRoutes(
      req('GET'),
      u('/api/admin/platform-grants'),
      deps(new FakePool(), { sendJson, envIds: new Set() }),
    )
    expect(calls[0]?.status).toBe(403)
  })
})

describe('platform grants CRUD', () => {
  it('GET → empty list + the app_issue.* catalog', async () => {
    const pool = new FakePool()
    const { calls, sendJson } = capture()
    await handlePlatformGrantRoutes(req('GET'), u('/api/admin/platform-grants'), deps(pool, { sendJson }))
    expect(calls[0]?.status).toBe(200)
    const body = calls[0]?.body as { grants: unknown[]; catalog: string[] }
    expect(body.grants).toEqual([])
    expect(body.catalog).toEqual(['app_issue.capture', 'app_issue.view', 'app_issue.triage'])
  })

  it('POST grants an app_issue.* capability to a person', async () => {
    const pool = new FakePool()
    const { calls, sendJson } = capture()
    await handlePlatformGrantRoutes(
      req('POST'),
      u('/api/admin/platform-grants'),
      deps(pool, { sendJson, readBody: async () => ({ clerk_user_id: 'user_42', capability: 'app_issue.view' }) }),
    )
    expect(calls[0]?.status).toBe(201)
    const body = calls[0]?.body as { grant: { clerk_user_id: string; capability: string } }
    expect(body.grant.clerk_user_id).toBe('user_42')
    expect(body.grant.capability).toBe('app_issue.view')
    expect(pool.grants).toHaveLength(1)
  })

  it('POST is idempotent — re-granting returns the existing row, no duplicate', async () => {
    const pool = new FakePool()
    const body = { clerk_user_id: 'user_42', capability: 'app_issue.view' }
    await handlePlatformGrantRoutes(
      req('POST'),
      u('/api/admin/platform-grants'),
      deps(pool, { readBody: async () => body }),
    )
    const { calls, sendJson } = capture()
    await handlePlatformGrantRoutes(
      req('POST'),
      u('/api/admin/platform-grants'),
      deps(pool, { sendJson, readBody: async () => body }),
    )
    expect(calls[0]?.status).toBe(201)
    expect((calls[0]?.body as { grant: { capability: string } }).grant.capability).toBe('app_issue.view')
    expect(pool.grants).toHaveLength(1)
  })

  it('POST a field_request.* capability → 400 (company cap cannot bleed onto the platform)', async () => {
    const pool = new FakePool()
    const { calls, sendJson } = capture()
    await handlePlatformGrantRoutes(
      req('POST'),
      u('/api/admin/platform-grants'),
      deps(pool, {
        sendJson,
        readBody: async () => ({ clerk_user_id: 'user_42', capability: 'field_request.triage' }),
      }),
    )
    expect(calls[0]?.status).toBe(400)
    expect(pool.grants).toHaveLength(0)
  })

  it('DELETE revokes a grant', async () => {
    const pool = new FakePool()
    pool.grants.push({ clerk_user_id: 'user_42', capability: 'app_issue.view', created_at: 't' })
    const { calls, sendJson } = capture()
    await handlePlatformGrantRoutes(
      req('DELETE'),
      u('/api/admin/platform-grants/user_42/app_issue.view'),
      deps(pool, { sendJson }),
    )
    expect(calls[0]?.status).toBe(200)
    expect((calls[0]?.body as { deleted: boolean }).deleted).toBe(true)
    expect(pool.grants).toHaveLength(0)
  })

  it('DELETE a non-app_issue capability → 400', async () => {
    const pool = new FakePool()
    const { calls, sendJson } = capture()
    await handlePlatformGrantRoutes(
      req('DELETE'),
      u('/api/admin/platform-grants/user_42/field_request.triage'),
      deps(pool, { sendJson }),
    )
    expect(calls[0]?.status).toBe(400)
  })
})
