import { describe, expect, it } from 'vitest'
import { Webhook } from 'svix'
import type { Pool } from 'pg'
import { handlePublicRoutes, type PublicRouteCtx } from './public.js'

// ---------------------------------------------------------------------------
// Clerk webhook → clerk_users mirror. Covers the full path: real Svix
// signature verification (using the same fixed test secret as
// clerk-webhook.test.ts), the user.created/updated upsert SQL, the
// user.deleted soft-delete, the bad-signature rejection, and the
// expand/backfill/contract tolerance (table absent → 204, not 500).
//
// Uses the FakePool style from rental-billing-state.test.ts: a tiny in-memory
// dispatcher that records the writes the handler emits.
// ---------------------------------------------------------------------------

// Svix-style test secret (do NOT reuse outside tests). Matches the precedent
// in clerk-webhook.test.ts.
const TEST_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'

type ClerkUserRow = {
  clerk_user_id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  image_url: string | null
  clerk_created_at: string | null
  clerk_updated_at: string | null
  deleted_at: string | null
}

class FakePool {
  rows = new Map<string, ClerkUserRow>()
  /** When true, every clerk_users query throws 42P01 (table absent). */
  tableMissing = false
  queries: string[] = []

  async query(sqlRaw: string, params: unknown[] = []) {
    return this.dispatch(sqlRaw, params)
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim()
    this.queries.push(sql)

    if (/clerk_users/i.test(sql)) {
      if (this.tableMissing) {
        const err = new Error('relation "clerk_users" does not exist') as Error & { code: string }
        err.code = '42P01'
        throw err
      }
      if (/^insert into clerk_users/i.test(sql)) {
        const [clerkUserId, email, firstName, lastName, imageUrl, clerkCreatedAt, clerkUpdatedAt] = params as [
          string,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
          string | null,
        ]
        const existing = this.rows.get(clerkUserId)
        this.rows.set(clerkUserId, {
          clerk_user_id: clerkUserId,
          email,
          first_name: firstName,
          last_name: lastName,
          image_url: imageUrl,
          clerk_created_at: clerkCreatedAt ?? existing?.clerk_created_at ?? null,
          clerk_updated_at: clerkUpdatedAt,
          deleted_at: null,
        })
        return { rows: [], rowCount: 1 }
      }
      if (/^update clerk_users/i.test(sql)) {
        const [clerkUserId] = params as [string]
        const row = this.rows.get(clerkUserId)
        if (row && !row.deleted_at) {
          row.deleted_at = new Date().toISOString()
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
    }

    throw new Error(`unexpected SQL in fake pool: ${sql.slice(0, 200)}`)
  }
}

function signedHeaders(body: string): Record<string, string> {
  const wh = new Webhook(TEST_SECRET)
  const id = `msg_${Math.random().toString(16).slice(2)}`
  const timestamp = new Date()
  return {
    'svix-id': id,
    'svix-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
    'svix-signature': wh.sign(id, timestamp, body),
  }
}

type Harness = {
  ctx: PublicRouteCtx
  responses: Array<{ status: number; body: unknown }>
  rawStatus: { code: number | null }
  res: import('node:http').ServerResponse
}

function makeCtx(pool: FakePool, rawBody: string): Harness {
  const responses: Array<{ status: number; body: unknown }> = []
  const rawStatus = { code: null as number | null }
  const ctx: PublicRouteCtx = {
    pool: pool as unknown as Pool,
    tier: 'local',
    buildSha: 'test',
    startedAt: new Date().toISOString(),
    metricsToken: null,
    clerkWebhookSecret: TEST_SECRET,
    qboWebhookVerifier: null,
    pgHealthProbeTimeoutMs: 1000,
    features: { flags: [], ribbon: null },
    getCorsOrigin: () => '*',
    sendJson: (status, body) => {
      responses.push({ status, body })
    },
    readRawBody: async () => rawBody,
  }
  // The handler calls res.writeHead(status) / res.end() for the 204 path.
  const res = {
    writeHead: (status: number) => {
      rawStatus.code = status
      return res
    },
    end: () => undefined,
    setHeader: () => undefined,
  } as unknown as import('node:http').ServerResponse
  return { ctx, responses, rawStatus, res }
}

function postReq(headers: Record<string, string>): import('node:http').IncomingMessage {
  return { method: 'POST', headers } as unknown as import('node:http').IncomingMessage
}

const URL_CLERK = new URL('http://localhost/api/webhooks/clerk')

describe('handlePublicRoutes — POST /api/webhooks/clerk → clerk_users mirror', () => {
  it('upserts the mirror row on user.created and returns 204', async () => {
    const pool = new FakePool()
    const body = JSON.stringify({
      type: 'user.created',
      object: 'event',
      data: {
        id: 'user_abc',
        primary_email_address_id: 'idem_1',
        email_addresses: [
          { id: 'idem_0', email_address: 'secondary@example.com' },
          { id: 'idem_1', email_address: 'primary@example.com' },
        ],
        first_name: 'Ada',
        last_name: 'Lovelace',
        image_url: 'https://img.clerk.com/ada.png',
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
      },
    })
    const headers = signedHeaders(body)
    const { ctx, responses, rawStatus, res } = makeCtx(pool, body)

    const handled = await handlePublicRoutes(postReq(headers), URL_CLERK, res, ctx)

    expect(handled).toBe(true)
    expect(responses).toHaveLength(0) // no sendJson error path
    expect(rawStatus.code).toBe(204)
    const row = pool.rows.get('user_abc')
    expect(row).toBeDefined()
    // primary_email_address_id resolves the chosen email (not the first).
    expect(row?.email).toBe('primary@example.com')
    expect(row?.first_name).toBe('Ada')
    expect(row?.last_name).toBe('Lovelace')
    expect(row?.image_url).toBe('https://img.clerk.com/ada.png')
    // Clerk epoch-ms timestamps converted to ISO.
    expect(row?.clerk_created_at).toBe(new Date(1_700_000_000_000).toISOString())
    expect(row?.deleted_at).toBeNull()
  })

  it('user.updated upserts onto the existing row (idempotent on clerk_user_id)', async () => {
    const pool = new FakePool()
    pool.rows.set('user_abc', {
      clerk_user_id: 'user_abc',
      email: 'old@example.com',
      first_name: 'Old',
      last_name: 'Name',
      image_url: null,
      clerk_created_at: new Date(1_700_000_000_000).toISOString(),
      clerk_updated_at: null,
      deleted_at: null,
    })
    const body = JSON.stringify({
      type: 'user.updated',
      data: {
        id: 'user_abc',
        email_addresses: [{ id: 'e1', email_address: 'new@example.com' }],
        primary_email_address_id: 'e1',
        first_name: 'New',
        last_name: 'Name',
      },
    })
    const headers = signedHeaders(body)
    const { res, ctx, rawStatus } = makeCtx(pool, body)

    await handlePublicRoutes(postReq(headers), URL_CLERK, res, ctx)

    expect(rawStatus.code).toBe(204)
    expect(pool.rows.size).toBe(1)
    expect(pool.rows.get('user_abc')?.email).toBe('new@example.com')
    expect(pool.rows.get('user_abc')?.first_name).toBe('New')
  })

  it('soft-deletes the mirror row on user.deleted (sets deleted_at)', async () => {
    const pool = new FakePool()
    pool.rows.set('user_abc', {
      clerk_user_id: 'user_abc',
      email: 'a@example.com',
      first_name: 'A',
      last_name: 'B',
      image_url: null,
      clerk_created_at: null,
      clerk_updated_at: null,
      deleted_at: null,
    })
    const body = JSON.stringify({ type: 'user.deleted', data: { id: 'user_abc' } })
    const headers = signedHeaders(body)
    const { res, ctx, rawStatus } = makeCtx(pool, body)

    await handlePublicRoutes(postReq(headers), URL_CLERK, res, ctx)

    expect(rawStatus.code).toBe(204)
    // Row is preserved (not removed) and marked deleted.
    expect(pool.rows.has('user_abc')).toBe(true)
    expect(pool.rows.get('user_abc')?.deleted_at).not.toBeNull()
  })

  it('rejects an invalid signature with 401 and never touches the mirror', async () => {
    const pool = new FakePool()
    const body = JSON.stringify({ type: 'user.created', data: { id: 'user_x' } })
    const headers = signedHeaders(body)
    // Tamper with the body after signing.
    const tampered = body.replace('user_x', 'user_evil')
    const { res, ctx, responses } = makeCtx(pool, tampered)

    await handlePublicRoutes(postReq(headers), URL_CLERK, res, ctx)

    expect(responses[0]?.status).toBe(401)
    expect(pool.queries.some((q) => /clerk_users/i.test(q))).toBe(false)
    expect(pool.rows.size).toBe(0)
  })

  it('tolerates the migration not yet being applied (table absent → 204, no throw)', async () => {
    const pool = new FakePool()
    pool.tableMissing = true
    const body = JSON.stringify({
      type: 'user.created',
      data: { id: 'user_abc', email_addresses: [{ id: 'e', email_address: 'a@b.com' }], primary_email_address_id: 'e' },
    })
    const headers = signedHeaders(body)
    const { res, ctx, rawStatus, responses } = makeCtx(pool, body)

    // Must not throw even though the clerk_users insert hits 42P01.
    await expect(handlePublicRoutes(postReq(headers), URL_CLERK, res, ctx)).resolves.toBe(true)
    expect(rawStatus.code).toBe(204)
    expect(responses).toHaveLength(0)
  })

  it('returns 503 when the webhook secret is not configured', async () => {
    const pool = new FakePool()
    const body = JSON.stringify({ type: 'user.created', data: { id: 'user_x' } })
    const headers = signedHeaders(body)
    const { ctx, responses, res } = makeCtx(pool, body)
    ctx.clerkWebhookSecret = null

    await handlePublicRoutes(postReq(headers), URL_CLERK, res, ctx)

    expect(responses[0]?.status).toBe(503)
  })
})
