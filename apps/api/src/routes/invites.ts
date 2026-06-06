import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { normalizeCompanyRole } from '@sitelayer/domain'
import type { AppTier } from '../tier.js'
import type { Identity } from '../auth.js'
import { recordAudit } from '../audit.js'
import { HttpError, parseJsonBody, parsePagination } from '../http-utils.js'
import { observeAudit } from '../metrics.js'
import { enqueueNotification, withMutationTx } from '../mutation-tx.js'
import {
  EMAIL_PATTERN,
  INVITE_EXPIRES_DEFAULT_DAYS,
  buildInviteUrl,
  generateInviteToken,
  inviteAcceptBaseUrl,
  normalizeEmail,
  type InviteStatus,
  type PublicInviteView,
} from '../invites.js'

export type InviteRouteCtx = {
  pool: Pool
  /** Act-as-aware identity (getCurrentUserId). */
  userId: string
  /** How the raw identity was resolved (before the dev act-as override). */
  identitySource: Identity['source']
  /**
   * True when this request carries no real authenticated identity — i.e. the
   * anonymous default user with no Clerk JWT and no dev `x-sitelayer-act-as`
   * override. Accept rejects this. server.ts computes it so the act-as path
   * (source stays 'default' but getCurrentUserId returns a concrete dev id)
   * is correctly treated as authenticated.
   */
  isAnonymous: boolean
  tier: AppTier
  sendJson: (status: number, body: unknown) => void
  readBody: () => Promise<Record<string, unknown>>
}

/** Postgres unique_violation SQLSTATE — fires on the one-pending-per-email index. */
const PG_UNIQUE_VIOLATION = '23505'
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  )
}

const CreateInviteSchema = z
  .object({
    email: z
      .string()
      .trim()
      .min(1)
      .max(320)
      .refine((v) => EMAIL_PATTERN.test(v), 'invalid email'),
    role: z.enum(['admin', 'foreman', 'office', 'member', 'bookkeeper']).optional(),
    expires_in_days: z.number().int().min(1).max(90).optional(),
  })
  .strict()

type InviteRow = {
  id: string
  company_id: string
  email: string
  role: string
  status: InviteStatus
  invited_by: string
  accepted_by: string | null
  accepted_at: string | null
  expires_at: string
  created_at: string
}

type MembershipRow = {
  id: string
  company_id: string
  clerk_user_id: string
  role: string
  created_at: string
}

/** Shared executor interface satisfied by Pool and PoolClient. */
type QueryExecutor = Pick<Pool | PoolClient, 'query'>

/** Admin gate: copies the exact pattern in companies.ts. Returns true if blocked. */
async function blockIfNotAdmin(ctx: InviteRouteCtx, companyId: string): Promise<boolean> {
  const adminCheck = await ctx.pool.query<{ role: string }>(
    'select role from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1',
    [companyId, ctx.userId],
  )
  if (!adminCheck.rows[0] || normalizeCompanyRole(adminCheck.rows[0].role) !== 'admin') {
    ctx.sendJson(403, { error: 'admin role required' })
    return true
  }
  return false
}

/** Strip the token (and other internal fields) off an invite row for client responses. */
function publicInviteShape(row: InviteRow) {
  return {
    id: row.id,
    company_id: row.company_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invited_by: row.invited_by,
    accepted_by: row.accepted_by,
    accepted_at: row.accepted_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
  }
}

/**
 * The acceptance transaction body, extracted as a pure-ish helper so it can be
 * unit-tested against a fake client without `attachMutationTx`. Binds the
 * invited role to the *authenticated* clerk_user_id (the email→member
 * conversion) and marks the invite accepted. Throws HttpError for every
 * non-pending terminal state. The caller runs this inside
 * `withMutationTx(invite.company_id, ...)` so the RLS GUC is set.
 *
 * Returns the membership + company plus an `alreadyAccepted` flag so the route
 * can pick 201 (first accept) vs 200 (idempotent re-accept).
 */
export async function acceptInviteTx(
  client: QueryExecutor,
  args: { token: string; acceptingUserId: string },
): Promise<{
  membership: MembershipRow
  company: { id: string; slug: string; name: string }
  alreadyAccepted: boolean
}> {
  const lookup = await client.query<InviteRow>(
    `select id, company_id, email, role, status, invited_by, accepted_by, accepted_at, expires_at, created_at
       from company_invites where token = $1 for update`,
    [args.token],
  )
  const invite = lookup.rows[0]
  if (!invite) throw new HttpError(404, 'invite not found')

  const nowExpired = new Date(invite.expires_at).getTime() < Date.now()

  if (invite.status === 'accepted') {
    if (invite.accepted_by === args.acceptingUserId) {
      // Idempotent re-accept by the same user — re-select the membership + company.
      const membership = await selectMembership(client, invite.company_id, args.acceptingUserId)
      const company = await selectCompany(client, invite.company_id)
      if (!membership || !company) throw new HttpError(500, 'accepted invite has no membership')
      return { membership, company, alreadyAccepted: true }
    }
    throw new HttpError(409, 'invite already accepted by another user')
  }
  if (invite.status === 'revoked') throw new HttpError(409, 'invite revoked')
  if (invite.status === 'expired' || nowExpired) {
    if (invite.status !== 'expired') {
      await client.query(`update company_invites set status = 'expired' where id = $1`, [invite.id])
    }
    throw new HttpError(410, 'invite expired')
  }

  // status === 'pending' and not expired → bind the membership.
  const upsert = await client.query<MembershipRow>(
    `insert into company_memberships (company_id, clerk_user_id, role)
     values ($1, $2, $3)
     on conflict (company_id, clerk_user_id) do update set role = excluded.role
     returning id, company_id, clerk_user_id, role, created_at`,
    [invite.company_id, args.acceptingUserId, invite.role],
  )
  const membership = upsert.rows[0]
  if (!membership) throw new HttpError(500, 'company membership upsert returned no row')

  await client.query(
    `update company_invites set status = 'accepted', accepted_by = $1, accepted_at = now() where id = $2`,
    [args.acceptingUserId, invite.id],
  )

  const company = await selectCompany(client, invite.company_id)
  if (!company) throw new HttpError(500, 'invite company not found')

  await recordAudit(client, {
    companyId: invite.company_id,
    actorUserId: args.acceptingUserId,
    entityType: 'company_membership',
    entityId: membership.id,
    action: 'accept_invite',
    after: membership,
  })
  await recordAudit(client, {
    companyId: invite.company_id,
    actorUserId: args.acceptingUserId,
    entityType: 'company_invite',
    entityId: invite.id,
    action: 'accept',
    after: { id: invite.id, accepted_by: args.acceptingUserId },
  })

  return { membership, company, alreadyAccepted: false }
}

async function selectMembership(
  client: QueryExecutor,
  companyId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const result = await client.query<MembershipRow>(
    `select id, company_id, clerk_user_id, role, created_at
       from company_memberships where company_id = $1 and clerk_user_id = $2 limit 1`,
    [companyId, userId],
  )
  return result.rows[0] ?? null
}

async function selectCompany(
  client: QueryExecutor,
  companyId: string,
): Promise<{ id: string; slug: string; name: string } | null> {
  const result = await client.query<{ id: string; slug: string; name: string }>(
    'select id, slug, name from companies where id = $1 limit 1',
    [companyId],
  )
  return result.rows[0] ?? null
}

export async function handleInviteRoutes(req: http.IncomingMessage, url: URL, ctx: InviteRouteCtx): Promise<boolean> {
  const { pool, userId, sendJson, readBody } = ctx

  // ---- POST /api/companies/:id/invites — admin-only, create -----------------
  const companyInvitesMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/invites$/)
  if (req.method === 'POST' && companyInvitesMatch) {
    const companyId = companyInvitesMatch[1]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const parsed = parseJsonBody(CreateInviteSchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }
    const email = normalizeEmail(parsed.value.email)
    const role = parsed.value.role ?? 'member'
    const expiresDays = parsed.value.expires_in_days ?? INVITE_EXPIRES_DEFAULT_DAYS

    const companyRow = await pool.query<{ name: string }>('select name from companies where id = $1 limit 1', [
      companyId,
    ])
    const companyName = companyRow.rows[0]?.name ?? 'your company'

    let invite: InviteRow
    let alreadyPending = false
    let token = generateInviteToken()
    try {
      const inserted = await pool.query<InviteRow>(
        `insert into company_invites (company_id, email, role, token, status, invited_by, expires_at)
         values ($1, $2, $3, $4, 'pending', $5, now() + ($6 || ' days')::interval)
         returning id, company_id, email, role, status, invited_by, accepted_by, accepted_at, expires_at, created_at`,
        [companyId, email, role, token, userId, String(expiresDays)],
      )
      const row = inserted.rows[0]
      if (!row) throw new HttpError(500, 'company invite insert returned no row')
      invite = row
    } catch (err) {
      if (!isUniqueViolation(err)) throw err
      // A pending invite already exists for this (company, email): re-send the
      // email but don't create a second row or 500 on the unique index.
      const existing = await pool.query<InviteRow & { token: string }>(
        `select id, company_id, email, role, status, invited_by, accepted_by, accepted_at, expires_at, created_at, token
           from company_invites where company_id = $1 and lower(email) = $2 and status = 'pending' limit 1`,
        [companyId, email],
      )
      const row = existing.rows[0]
      if (!row) throw err
      invite = row
      token = row.token
      alreadyPending = true
    }

    // Notification carries the accept link in the body, NOT the payload.
    const acceptUrl = buildInviteUrl(inviteAcceptBaseUrl(), token)
    await enqueueNotification({
      companyId,
      recipientEmail: email,
      kind: 'company_invite',
      subject: `You've been invited to ${companyName} on Sitelayer`,
      text: [
        `You've been invited to join ${companyName} on Sitelayer as ${role}.`,
        `Accept your invitation: ${acceptUrl}`,
      ].join('\n\n'),
      html: [
        `<p>You've been invited to join <strong>${companyName}</strong> on Sitelayer as <strong>${role}</strong>.</p>`,
        `<p><a href="${acceptUrl}">Accept your invitation</a> to get started.</p>`,
      ].join('\n'),
      payload: { invite_id: invite.id, company_id: companyId, role },
    })

    if (!alreadyPending) {
      await recordAudit(pool, {
        companyId,
        actorUserId: userId,
        entityType: 'company_invite',
        entityId: invite.id,
        action: 'create',
        after: {
          id: invite.id,
          email: invite.email,
          role: invite.role,
          status: invite.status,
          expires_at: invite.expires_at,
        },
      })
      observeAudit('company_invite', 'create')
    }

    if (alreadyPending) {
      sendJson(200, { invite: publicInviteShape(invite), already_pending: true })
    } else {
      sendJson(201, { invite: publicInviteShape(invite) })
    }
    return true
  }

  // ---- GET /api/companies/:id/invites — admin-only, list --------------------
  if (req.method === 'GET' && companyInvitesMatch) {
    const companyId = companyInvitesMatch[1]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const pagination = parsePagination(url.searchParams)
    if (!pagination.ok) {
      sendJson(400, { error: pagination.error })
      return true
    }
    const { limit, offset } = pagination.value
    const result = await pool.query<InviteRow>(
      `select id, company_id, email, role, status, invited_by, accepted_by, accepted_at, expires_at, created_at
         from company_invites where company_id = $1 order by created_at desc limit $2 offset $3`,
      [companyId, limit, offset],
    )
    sendJson(200, { invites: result.rows.map(publicInviteShape) })
    return true
  }

  // ---- POST /api/companies/:id/invites/:inviteId/revoke — admin-only --------
  const revokeMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/invites\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    const companyId = revokeMatch[1]!
    const inviteId = revokeMatch[2]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const updated = await pool.query<InviteRow>(
      `update company_invites set status = 'revoked'
         where id = $1 and company_id = $2 and status = 'pending'
       returning id, company_id, email, role, status, invited_by, accepted_by, accepted_at, expires_at, created_at`,
      [inviteId, companyId],
    )
    const invite = updated.rows[0]
    if (!invite) {
      sendJson(404, { error: 'pending invite not found' })
      return true
    }
    await recordAudit(pool, {
      companyId,
      actorUserId: userId,
      entityType: 'company_invite',
      entityId: invite.id,
      action: 'revoke',
      after: { id: invite.id, status: invite.status },
    })
    observeAudit('company_invite', 'revoke')
    sendJson(200, { invite: publicInviteShape(invite) })
    return true
  }

  // ---- POST /api/memberships/:id/first-run-complete — self, idempotent -----
  // After a freshly-accepted teammate walks their role-specific first-run
  // priming (worker/foreman/estimator-first-run.tsx) we persist a per-membership
  // flag so the priming isn't shown again on the next login. The flag is
  // owner-scoped: a member can only complete first-run for their OWN membership
  // row (`clerk_user_id = caller`), never another user's. Idempotent — the first
  // completion latches `first_run_completed_at`; a re-POST coalesces to the
  // existing timestamp so a double-tap / replayed nav doesn't move it forward.
  const firstRunMatch = url.pathname.match(/^\/api\/memberships\/([^/]+)\/first-run-complete$/)
  if (req.method === 'POST' && firstRunMatch) {
    const membershipId = firstRunMatch[1]!
    if (ctx.isAnonymous) {
      sendJson(401, { error: 'authentication required' })
      return true
    }
    const updated = await pool.query<MembershipRow & { first_run_completed_at: string | null }>(
      `update company_memberships
          set first_run_completed_at = coalesce(first_run_completed_at, now())
        where id = $1 and clerk_user_id = $2
       returning id, company_id, clerk_user_id, role, created_at, first_run_completed_at`,
      [membershipId, userId],
    )
    const membership = updated.rows[0]
    if (!membership) {
      sendJson(404, { error: 'membership not found' })
      return true
    }
    sendJson(200, { membership })
    return true
  }

  // ---- GET /api/invites/:token — PUBLIC view (no auth) ----------------------
  const tokenViewMatch = url.pathname.match(/^\/api\/invites\/([^/]+)$/)
  if (req.method === 'GET' && tokenViewMatch) {
    const token = decodeURIComponent(tokenViewMatch[1]!)
    const result = await pool.query<InviteRow & { company_name: string }>(
      `select ci.id, ci.company_id, ci.email, ci.role, ci.status, ci.invited_by, ci.accepted_by, ci.accepted_at,
              ci.expires_at, ci.created_at, c.name as company_name
         from company_invites ci join companies c on c.id = ci.company_id
        where ci.token = $1 limit 1`,
      [token],
    )
    const row = result.rows[0]
    if (!row) {
      sendJson(404, { error: 'invite not found' })
      return true
    }
    let status: InviteStatus = row.status
    // Lazy expiry: a pending invite past its expiry flips to 'expired'.
    if (status === 'pending' && new Date(row.expires_at).getTime() < Date.now()) {
      await pool.query(`update company_invites set status = 'expired' where id = $1 and status = 'pending'`, [row.id])
      status = 'expired'
    }
    const view: PublicInviteView = {
      company_name: row.company_name,
      email: row.email,
      role: row.role,
      status,
      expires_at: row.expires_at,
    }
    sendJson(200, { invite: view })
    return true
  }

  // ---- POST /api/invites/:token/accept — authenticated, no company yet ------
  const acceptMatch = url.pathname.match(/^\/api\/invites\/([^/]+)\/accept$/)
  if (req.method === 'POST' && acceptMatch) {
    const token = decodeURIComponent(acceptMatch[1]!)
    // The anonymous default identity (no Clerk JWT, no act-as) cannot accept.
    // In dev the act-as header yields a concrete userId (isAnonymous=false)
    // even though identitySource stays 'default'.
    if (ctx.isAnonymous) {
      sendJson(401, { error: 'authentication required to accept invite' })
      return true
    }
    const acceptingUserId = userId

    // Resolve the invite's company first (at the pool, RLS-permissive when the
    // GUC is unset) so withMutationTx can bind app.company_id for the writes.
    const companyLookup = await pool.query<{ company_id: string }>(
      'select company_id from company_invites where token = $1 limit 1',
      [token],
    )
    const companyId = companyLookup.rows[0]?.company_id
    if (!companyId) {
      sendJson(404, { error: 'invite not found' })
      return true
    }

    try {
      const result = await withMutationTx(companyId, (client) => acceptInviteTx(client, { token, acceptingUserId }))
      if (!result.alreadyAccepted) {
        observeAudit('company_membership', 'accept_invite')
        observeAudit('company_invite', 'accept')
      }
      sendJson(result.alreadyAccepted ? 200 : 201, {
        membership: result.membership,
        company: result.company,
        ...(result.alreadyAccepted ? { already_accepted: true } : {}),
      })
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(err.status, { error: err.message })
        return true
      }
      throw err
    }
    return true
  }

  return false
}
