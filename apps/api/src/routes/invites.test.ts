import { describe, expect, it } from 'vitest'
import type { Pool, PoolClient } from 'pg'
import type pino from 'pino'
import { HttpError } from '../http-utils.js'
import { attachMutationTx } from '../mutation-tx.js'
import { acceptInviteTx, handleInviteRoutes, type InviteRouteCtx } from './invites.js'

// ---------------------------------------------------------------------------
// Teammate invite + accept route coverage. create / list / revoke / public-view
// run at ctx.pool (DB-free here). The accept transaction body is exercised
// directly via the extracted acceptInviteTx(client, …) helper, plus the
// route-level anonymous-401 and not-found-404 short-circuits that fire before
// withMutationTx.
// ---------------------------------------------------------------------------

type InviteRow = {
  id: string
  company_id: string
  email: string
  role: string
  token: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  invited_by: string
  accepted_by: string | null
  accepted_at: string | null
  expires_at: string
  created_at: string
}

type MembershipRow = { company_id: string; clerk_user_id: string; role: string }
type CompanyRow = { id: string; slug: string; name: string }

class UniqueViolation extends Error {
  code = '23505'
}

/** Fake pool answering the create/list/revoke/public-view SQL shapes. */
class FakePool {
  companies: CompanyRow[] = []
  memberships: MembershipRow[] = []
  invites: InviteRow[] = []
  notifications: Array<{ kind: string; recipient_email: string | null; payload: Record<string, unknown> }> = []
  audit: Array<{ entityType: string; action: string }> = []
  /** When set, the next invite INSERT throws a 23505 (simulates duplicate pending). */
  failNextInsertWithUnique = false
  private seq = 0

  /** Wire this pool as the mutation-tx module pool so enqueueNotification
   *  (which goes through requirePool()) lands its rows here. */
  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async query(sqlRaw: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = sqlRaw.trim()

    if (/^select role from company_memberships/i.test(sql)) {
      const [companyId, userId] = params as [string, string]
      const m = this.memberships.find((r) => r.company_id === companyId && r.clerk_user_id === userId)
      return { rows: m ? [{ role: m.role }] : [], rowCount: m ? 1 : 0 }
    }

    if (/^select name from companies/i.test(sql)) {
      const [companyId] = params as [string]
      const c = this.companies.find((x) => x.id === companyId)
      return { rows: c ? [{ name: c.name }] : [], rowCount: c ? 1 : 0 }
    }

    if (/^insert into company_invites/i.test(sql)) {
      if (this.failNextInsertWithUnique) {
        this.failNextInsertWithUnique = false
        throw new UniqueViolation('duplicate key')
      }
      const [companyId, email, role, token, invitedBy, days] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
      ]
      const row: InviteRow = {
        id: `invite-${(this.seq += 1)}`,
        company_id: companyId,
        email,
        role,
        token,
        status: 'pending',
        invited_by: invitedBy,
        accepted_by: null,
        accepted_at: null,
        expires_at: new Date(Date.now() + Number(days) * 86_400_000).toISOString(),
        created_at: new Date().toISOString(),
      }
      this.invites.push(row)
      return { rows: [row], rowCount: 1 }
    }

    // resend lookup: select … from company_invites where company_id=$1 and lower(email)=$2 and status='pending'
    if (/from company_invites where company_id = \$1 and lower\(email\)/i.test(sql)) {
      const [companyId, email] = params as [string, string]
      const row = this.invites.find(
        (i) => i.company_id === companyId && i.email.toLowerCase() === email && i.status === 'pending',
      )
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    // list: select … from company_invites where company_id=$1 order by created_at desc limit $2 offset $3
    if (/from company_invites where company_id = \$1 order by created_at desc/i.test(sql)) {
      const [companyId] = params as [string]
      const rows = this.invites
        .filter((i) => i.company_id === companyId)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      return { rows, rowCount: rows.length }
    }

    // revoke
    if (/^update company_invites set status = 'revoked'/i.test(sql)) {
      const [inviteId, companyId] = params as [string, string]
      const row = this.invites.find((i) => i.id === inviteId && i.company_id === companyId && i.status === 'pending')
      if (!row) return { rows: [], rowCount: 0 }
      row.status = 'revoked'
      return { rows: [row], rowCount: 1 }
    }

    // public token view (join companies)
    if (/from company_invites ci join companies c/i.test(sql)) {
      const [token] = params as [string]
      const row = this.invites.find((i) => i.token === token)
      if (!row) return { rows: [], rowCount: 0 }
      const c = this.companies.find((x) => x.id === row.company_id)
      return { rows: [{ ...row, company_name: c?.name ?? '' }], rowCount: 1 }
    }

    // lazy-expiry update
    if (/^update company_invites set status = 'expired'/i.test(sql)) {
      const [inviteId] = params as [string]
      const row = this.invites.find((i) => i.id === inviteId && i.status === 'pending')
      if (row) row.status = 'expired'
      return { rows: [], rowCount: row ? 1 : 0 }
    }

    // accept short-circuit company lookup
    if (/^select company_id from company_invites where token/i.test(sql)) {
      const [token] = params as [string]
      const row = this.invites.find((i) => i.token === token)
      return { rows: row ? [{ company_id: row.company_id }] : [], rowCount: row ? 1 : 0 }
    }

    if (/^insert into notifications/i.test(sql)) {
      this.notifications.push({
        kind: params[3] as string,
        recipient_email: (params[2] as string | null) ?? null,
        payload: JSON.parse((params[7] as string) ?? '{}'),
      })
      return { rows: [{ id: `notif-${(this.seq += 1)}` }], rowCount: 1 }
    }

    if (/^insert into audit_events/i.test(sql)) {
      this.audit.push({ entityType: params[3] as string, action: params[5] as string })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`FakePool: unhandled SQL: ${sql.slice(0, 80)}`)
  }
}

type Captured = { status: number; body: unknown }
function makeCtx(
  pool: FakePool,
  opts: {
    userId?: string
    identitySource?: InviteRouteCtx['identitySource']
    isAnonymous?: boolean
    body?: Record<string, unknown>
  } = {},
): { ctx: InviteRouteCtx; captured: Captured[] } {
  const captured: Captured[] = []
  const identitySource = opts.identitySource ?? 'header'
  const ctx: InviteRouteCtx = {
    pool: pool as unknown as Pool,
    userId: opts.userId ?? 'e2e-admin',
    identitySource,
    // Default: anonymous iff the source is the default identity, unless the
    // caller overrides (e.g. dev act-as = source 'default' but authenticated).
    isAnonymous: opts.isAnonymous ?? identitySource === 'default',
    tier: 'local',
    sendJson: (status, body) => captured.push({ status, body }),
    readBody: async () => opts.body ?? {},
  }
  return { ctx, captured }
}

function req(method: string) {
  return { method } as Parameters<typeof handleInviteRoutes>[0]
}

const ADMIN_POOL = () => {
  const pool = new FakePool()
  pool.companies.push({ id: 'co-1', slug: 'acme', name: 'Acme' })
  pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'e2e-admin', role: 'admin' })
  // enqueueNotification resolves the module pool via requirePool(); point it
  // at this fake so the create path's notification insert lands here.
  pool.attach()
  return pool
}

describe('POST /api/companies/:id/invites — create', () => {
  it('admin creates an invite → 201, notification with recipient_email + kind, audit, NO token in body', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, { body: { email: 'Jane@Acme.com', role: 'foreman' } })
    const handled = await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites'), ctx)
    expect(handled).toBe(true)
    expect(captured[0]?.status).toBe(201)
    const body = captured[0]?.body as { invite: Record<string, unknown> }
    expect(body.invite.email).toBe('jane@acme.com')
    expect(body.invite.role).toBe('foreman')
    expect(body.invite).not.toHaveProperty('token')
    expect(pool.notifications[0]?.kind).toBe('company_invite')
    expect(pool.notifications[0]?.recipient_email).toBe('jane@acme.com')
    expect(pool.notifications[0]?.payload).not.toHaveProperty('token')
    expect(pool.audit.some((a) => a.entityType === 'company_invite' && a.action === 'create')).toBe(true)
    expect(pool.invites).toHaveLength(1)
  })

  it('non-admin → 403, no row', async () => {
    const pool = ADMIN_POOL()
    pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'e2e-member', role: 'member' })
    const { ctx, captured } = makeCtx(pool, { userId: 'e2e-member', body: { email: 'a@b.co' } })
    await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites'), ctx)
    expect(captured[0]?.status).toBe(403)
    expect(pool.invites).toHaveLength(0)
  })

  it('invalid email → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, { body: { email: 'not-an-email' } })
    await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites'), ctx)
    expect(captured[0]?.status).toBe(400)
  })

  it('bad role → 400', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, { body: { email: 'a@b.co', role: 'owner' } })
    await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites'), ctx)
    expect(captured[0]?.status).toBe(400)
  })

  it('expires_in_days out of range (0 / 91) → 400', async () => {
    for (const days of [0, 91]) {
      const pool = ADMIN_POOL()
      const { ctx, captured } = makeCtx(pool, { body: { email: 'a@b.co', expires_in_days: days } })
      await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites'), ctx)
      expect(captured[0]?.status).toBe(400)
    }
  })

  it('custom expires_in_days reflected in expires_at', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, { body: { email: 'a@b.co', expires_in_days: 3 } })
    await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites'), ctx)
    const body = captured[0]?.body as { invite: { expires_at: string } }
    const deltaDays = (new Date(body.invite.expires_at).getTime() - Date.now()) / 86_400_000
    expect(deltaDays).toBeGreaterThan(2.5)
    expect(deltaDays).toBeLessThan(3.5)
  })

  it('duplicate pending (23505) → 200 already_pending, re-enqueues, no second row', async () => {
    const pool = ADMIN_POOL()
    // Seed an existing pending invite for the email.
    pool.invites.push({
      id: 'invite-existing',
      company_id: 'co-1',
      email: 'dup@acme.com',
      role: 'member',
      token: 'existing-token',
      status: 'pending',
      invited_by: 'e2e-admin',
      accepted_by: null,
      accepted_at: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
    })
    pool.failNextInsertWithUnique = true
    const { ctx, captured } = makeCtx(pool, { body: { email: 'dup@acme.com' } })
    await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites'), ctx)
    expect(captured[0]?.status).toBe(200)
    expect((captured[0]?.body as { already_pending: boolean }).already_pending).toBe(true)
    expect(pool.invites).toHaveLength(1)
    expect(pool.notifications).toHaveLength(1)
  })
})

describe('GET /api/companies/:id/invites — list', () => {
  it('admin → invites desc, token absent', async () => {
    const pool = ADMIN_POOL()
    pool.invites.push(
      {
        id: 'i1',
        company_id: 'co-1',
        email: 'a@b.co',
        role: 'member',
        token: 'tok1',
        status: 'pending',
        invited_by: 'e2e-admin',
        accepted_by: null,
        accepted_at: null,
        expires_at: new Date().toISOString(),
        created_at: '2026-01-01T00:00:00Z',
      },
      {
        id: 'i2',
        company_id: 'co-1',
        email: 'c@d.co',
        role: 'foreman',
        token: 'tok2',
        status: 'accepted',
        invited_by: 'e2e-admin',
        accepted_by: 'u9',
        accepted_at: new Date().toISOString(),
        expires_at: new Date().toISOString(),
        created_at: '2026-02-01T00:00:00Z',
      },
    )
    const { ctx, captured } = makeCtx(pool)
    await handleInviteRoutes(req('GET'), new URL('http://x/api/companies/co-1/invites'), ctx)
    const body = captured[0]?.body as { invites: Array<Record<string, unknown>> }
    expect(body.invites[0]?.id).toBe('i2') // newest first
    expect(body.invites[0]).not.toHaveProperty('token')
  })

  it('non-admin → 403', async () => {
    const pool = ADMIN_POOL()
    pool.memberships.push({ company_id: 'co-1', clerk_user_id: 'nope', role: 'member' })
    const { ctx, captured } = makeCtx(pool, { userId: 'nope' })
    await handleInviteRoutes(req('GET'), new URL('http://x/api/companies/co-1/invites'), ctx)
    expect(captured[0]?.status).toBe(403)
  })
})

describe('POST /api/companies/:id/invites/:inviteId/revoke', () => {
  it('pending → 200 revoked + audit', async () => {
    const pool = ADMIN_POOL()
    pool.invites.push({
      id: 'i1',
      company_id: 'co-1',
      email: 'a@b.co',
      role: 'member',
      token: 'tok1',
      status: 'pending',
      invited_by: 'e2e-admin',
      accepted_by: null,
      accepted_at: null,
      expires_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    const { ctx, captured } = makeCtx(pool)
    await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites/i1/revoke'), ctx)
    expect(captured[0]?.status).toBe(200)
    expect((captured[0]?.body as { invite: { status: string } }).invite.status).toBe('revoked')
    expect(pool.audit.some((a) => a.entityType === 'company_invite' && a.action === 'revoke')).toBe(true)
  })

  it('missing / already-accepted → 404', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool)
    await handleInviteRoutes(req('POST'), new URL('http://x/api/companies/co-1/invites/nope/revoke'), ctx)
    expect(captured[0]?.status).toBe(404)
  })
})

describe('GET /api/invites/:token — public view', () => {
  it('pending → PublicInviteView (no token/invited_by)', async () => {
    const pool = ADMIN_POOL()
    pool.invites.push({
      id: 'i1',
      company_id: 'co-1',
      email: 'a@b.co',
      role: 'member',
      token: 'tok1',
      status: 'pending',
      invited_by: 'e2e-admin',
      accepted_by: null,
      accepted_at: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
    })
    // Public view needs no membership: use a non-member identity.
    const { ctx, captured } = makeCtx(pool, { userId: 'anon', identitySource: 'default' })
    await handleInviteRoutes(req('GET'), new URL('http://x/api/invites/tok1'), ctx)
    const body = captured[0]?.body as { invite: Record<string, unknown> }
    expect(body.invite.company_name).toBe('Acme')
    expect(body.invite.status).toBe('pending')
    expect(body.invite).not.toHaveProperty('token')
    expect(body.invite).not.toHaveProperty('invited_by')
  })

  it('expired-by-time → status flips to expired', async () => {
    const pool = ADMIN_POOL()
    pool.invites.push({
      id: 'i1',
      company_id: 'co-1',
      email: 'a@b.co',
      role: 'member',
      token: 'tok1',
      status: 'pending',
      invited_by: 'e2e-admin',
      accepted_by: null,
      accepted_at: null,
      expires_at: new Date(Date.now() - 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
    })
    const { ctx, captured } = makeCtx(pool, { identitySource: 'default' })
    await handleInviteRoutes(req('GET'), new URL('http://x/api/invites/tok1'), ctx)
    expect((captured[0]?.body as { invite: { status: string } }).invite.status).toBe('expired')
    expect(pool.invites[0]?.status).toBe('expired')
  })

  it('unknown token → 404', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, { identitySource: 'default' })
    await handleInviteRoutes(req('GET'), new URL('http://x/api/invites/nope'), ctx)
    expect(captured[0]?.status).toBe(404)
  })
})

describe('POST /api/invites/:token/accept — route short-circuits', () => {
  it('anonymous default identity → 401, no writes', async () => {
    const pool = ADMIN_POOL()
    pool.invites.push({
      id: 'i1',
      company_id: 'co-1',
      email: 'a@b.co',
      role: 'member',
      token: 'tok1',
      status: 'pending',
      invited_by: 'e2e-admin',
      accepted_by: null,
      accepted_at: null,
      expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_at: new Date().toISOString(),
    })
    const { ctx, captured } = makeCtx(pool, { userId: 'demo-user', identitySource: 'default' })
    await handleInviteRoutes(req('POST'), new URL('http://x/api/invites/tok1/accept'), ctx)
    expect(captured[0]?.status).toBe(401)
    expect(pool.memberships.find((m) => m.clerk_user_id === 'demo-user')).toBeUndefined()
  })

  it('unknown token → 404 before withMutationTx', async () => {
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, { userId: 'e2e-member', identitySource: 'header' })
    await handleInviteRoutes(req('POST'), new URL('http://x/api/invites/nope/accept'), ctx)
    expect(captured[0]?.status).toBe(404)
  })

  it('dev act-as (source default, isAnonymous=false) is NOT rejected at the gate', async () => {
    // The act-as path: identitySource stays 'default' but a concrete dev id is
    // resolved, so isAnonymous=false. The gate must pass; an unknown token then
    // yields 404 (NOT 401), proving the request was treated as authenticated.
    const pool = ADMIN_POOL()
    const { ctx, captured } = makeCtx(pool, {
      userId: 'e2e-member',
      identitySource: 'default',
      isAnonymous: false,
    })
    await handleInviteRoutes(req('POST'), new URL('http://x/api/invites/nope/accept'), ctx)
    expect(captured[0]?.status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// acceptInviteTx — the transaction body, run against a fake client.
// ---------------------------------------------------------------------------

class FakeClient {
  invites: InviteRow[] = []
  memberships: MembershipRow[] = []
  companies: CompanyRow[] = []
  audit: Array<{ entityType: string; action: string }> = []

  async query(sqlRaw: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = sqlRaw.trim()

    if (/from company_invites where token = \$1 for update/i.test(sql)) {
      const [token] = params as [string]
      const row = this.invites.find((i) => i.token === token)
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
    }

    if (/^insert into company_memberships/i.test(sql)) {
      const [companyId, userId, role] = params as [string, string, string]
      let m = this.memberships.find((x) => x.company_id === companyId && x.clerk_user_id === userId)
      if (m) {
        m.role = role
      } else {
        m = { company_id: companyId, clerk_user_id: userId, role }
        this.memberships.push(m)
      }
      return {
        rows: [{ id: `mem-${companyId}-${userId}`, ...m, created_at: '2026-01-01T00:00:00Z' }],
        rowCount: 1,
      }
    }

    if (/^update company_invites set status = 'accepted'/i.test(sql)) {
      const [acceptedBy, inviteId] = params as [string, string]
      const row = this.invites.find((i) => i.id === inviteId)
      if (row) {
        row.status = 'accepted'
        row.accepted_by = acceptedBy
        row.accepted_at = new Date().toISOString()
      }
      return { rows: [], rowCount: 1 }
    }

    if (/^update company_invites set status = 'expired'/i.test(sql)) {
      const [inviteId] = params as [string]
      const row = this.invites.find((i) => i.id === inviteId)
      if (row) row.status = 'expired'
      return { rows: [], rowCount: 1 }
    }

    if (/select id, company_id, clerk_user_id, role, created_at\s+from company_memberships/i.test(sql)) {
      const [companyId, userId] = params as [string, string]
      const m = this.memberships.find((x) => x.company_id === companyId && x.clerk_user_id === userId)
      return {
        rows: m ? [{ id: `mem-${companyId}-${userId}`, ...m, created_at: '2026-01-01T00:00:00Z' }] : [],
        rowCount: m ? 1 : 0,
      }
    }

    if (/^select id, slug, name from companies/i.test(sql)) {
      const [companyId] = params as [string]
      const c = this.companies.find((x) => x.id === companyId)
      return { rows: c ? [c] : [], rowCount: c ? 1 : 0 }
    }

    if (/^insert into audit_events/i.test(sql)) {
      this.audit.push({ entityType: params[3] as string, action: params[5] as string })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`FakeClient: unhandled SQL: ${sql.slice(0, 80)}`)
  }
}

/** Run acceptInviteTx against a FakeClient, casting to the pg PoolClient shape. */
function runAccept(client: FakeClient, args: { token: string; acceptingUserId: string }) {
  return acceptInviteTx(client as unknown as PoolClient, args)
}

function seedClient(status: InviteRow['status'], opts: { acceptedBy?: string; expiresMs?: number } = {}): FakeClient {
  const client = new FakeClient()
  client.companies.push({ id: 'co-1', slug: 'acme', name: 'Acme' })
  client.invites.push({
    id: 'i1',
    company_id: 'co-1',
    email: 'a@b.co',
    role: 'foreman',
    token: 'tok1',
    status,
    invited_by: 'e2e-admin',
    accepted_by: opts.acceptedBy ?? null,
    accepted_at: opts.acceptedBy ? new Date().toISOString() : null,
    expires_at: new Date(Date.now() + (opts.expiresMs ?? 86_400_000)).toISOString(),
    created_at: new Date().toISOString(),
  })
  return client
}

describe('acceptInviteTx', () => {
  it('pending → binds membership with invited role to accepting user, marks accepted, audits', async () => {
    const client = seedClient('pending')
    const result = await runAccept(client, { token: 'tok1', acceptingUserId: 'clerk-bob' })
    expect(result.alreadyAccepted).toBe(false)
    expect(result.membership.clerk_user_id).toBe('clerk-bob')
    expect(result.membership.role).toBe('foreman')
    expect(result.company).toEqual({ id: 'co-1', slug: 'acme', name: 'Acme' })
    expect(client.invites[0]?.status).toBe('accepted')
    expect(client.invites[0]?.accepted_by).toBe('clerk-bob')
    expect(client.audit.some((a) => a.entityType === 'company_membership' && a.action === 'accept_invite')).toBe(true)
    expect(client.audit.some((a) => a.entityType === 'company_invite' && a.action === 'accept')).toBe(true)
  })

  it('idempotent re-accept by same user → already_accepted, no second membership', async () => {
    const client = seedClient('accepted', { acceptedBy: 'clerk-bob' })
    client.memberships.push({ company_id: 'co-1', clerk_user_id: 'clerk-bob', role: 'foreman' })
    const result = await runAccept(client, { token: 'tok1', acceptingUserId: 'clerk-bob' })
    expect(result.alreadyAccepted).toBe(true)
    expect(result.membership.clerk_user_id).toBe('clerk-bob')
    expect(client.memberships).toHaveLength(1)
  })

  it('accepted by a different user → 409', async () => {
    const client = seedClient('accepted', { acceptedBy: 'clerk-alice' })
    await expect(runAccept(client, { token: 'tok1', acceptingUserId: 'clerk-bob' })).rejects.toMatchObject({
      status: 409,
    } satisfies Partial<HttpError>)
  })

  it('revoked → 409', async () => {
    const client = seedClient('revoked')
    await expect(runAccept(client, { token: 'tok1', acceptingUserId: 'clerk-bob' })).rejects.toMatchObject({
      status: 409,
    })
  })

  it('expired (by status) → 410', async () => {
    const client = seedClient('expired')
    await expect(runAccept(client, { token: 'tok1', acceptingUserId: 'clerk-bob' })).rejects.toMatchObject({
      status: 410,
    })
  })

  it('pending but past expiry → marks expired + 410', async () => {
    const client = seedClient('pending', { expiresMs: -86_400_000 })
    await expect(runAccept(client, { token: 'tok1', acceptingUserId: 'clerk-bob' })).rejects.toMatchObject({
      status: 410,
    })
    expect(client.invites[0]?.status).toBe('expired')
  })

  it('unknown token → 404', async () => {
    const client = seedClient('pending')
    await expect(runAccept(client, { token: 'nope', acceptingUserId: 'clerk-bob' })).rejects.toMatchObject({
      status: 404,
    })
  })
})
