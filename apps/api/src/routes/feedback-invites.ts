import type http from 'node:http'
import type { Pool } from 'pg'
import { z } from 'zod'
import { normalizeCompanyRole } from '@sitelayer/domain'
import { recordAudit } from '../audit.js'
import {
  feedbackInviteSecretMap,
  generateFeedbackInviteToken,
  verifyFeedbackInviteToken,
} from '../feedback-invite-token.js'
import { buildPaginationMeta, parseJsonBody, parsePagination } from '../http-utils.js'
import type { Identity } from '../auth.js'
import {
  appendPortalCaptureEvents,
  discardPortalCaptureSession,
  finalizePortalCaptureSession,
  startPortalCaptureSession,
  uploadPortalCaptureArtifact,
  type PortalCaptureActor,
} from './portal-capture-sessions.js'

const CAPTURE_MODES = ['text', 'audio', 'screen', 'trace', 'state'] as const
type CaptureMode = (typeof CAPTURE_MODES)[number]

export type FeedbackInviteRouteCtx = {
  pool: Pool
  userId: string
  identitySource: Identity['source']
  isAnonymous: boolean
  feedbackInviteSecret: string | null
  portalBaseUrl: string
  sendJson: (status: number, body: unknown) => void
  readBody: () => Promise<Record<string, unknown>>
}

type FeedbackInviteRow = {
  id: string
  company_id: string
  token_id: string
  token_kid: string
  reviewer_ref: string
  source: string
  target_route: string | null
  allowed_capture_modes: CaptureMode[]
  expires_at: string
  revoked_at: string | null
  created_by_user_id: string
  created_at: string
  last_used_at: string | null
  // Public-surface access audit (migration 011). last_used_at is the legacy
  // "touched" timestamp; last_accessed_at mirrors it and access_count is the
  // countable usage signal so the owner can spot a forwarded/leaked invite.
  last_accessed_at: string | null
  access_count: number
  metadata: Record<string, unknown>
}

type FeedbackInvitePublicRow = FeedbackInviteRow & {
  company_slug: string
  company_name: string
}

type FeedbackInviteLookupResult =
  | { ok: true; row: FeedbackInvitePublicRow }
  | { ok: false; status: number; error: string }

const CreateFeedbackInviteSchema = z
  .object({
    reviewer_ref: z.string().trim().min(1).max(120).optional(),
    source: z.string().trim().min(1).max(80).optional(),
    target_route: z.string().trim().min(1).max(500).optional(),
    allowed_capture_modes: z.array(z.enum(CAPTURE_MODES)).min(1).max(CAPTURE_MODES.length).optional(),
    expires_in_days: z.number().int().min(1).max(90).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

const ResolveFeedbackInviteSchema = z
  .object({
    token: z.string().trim().min(1).max(512),
  })
  .strict()

async function blockIfNotAdmin(ctx: FeedbackInviteRouteCtx, companyId: string): Promise<boolean> {
  if (ctx.isAnonymous) {
    ctx.sendJson(401, { error: 'authentication required' })
    return true
  }
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

function adminShape(row: FeedbackInviteRow) {
  return {
    id: row.id,
    company_id: row.company_id,
    reviewer_ref: row.reviewer_ref,
    source: row.source,
    target_route: row.target_route,
    allowed_capture_modes: row.allowed_capture_modes,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    last_accessed_at: row.last_accessed_at,
    access_count: row.access_count,
    metadata: row.metadata,
  }
}

function publicShape(row: FeedbackInvitePublicRow) {
  return {
    id: row.id,
    company_slug: row.company_slug,
    company_name: row.company_name,
    reviewer_ref: row.reviewer_ref,
    source: row.source,
    target_route: row.target_route,
    allowed_capture_modes: row.allowed_capture_modes,
    expires_at: row.expires_at,
  }
}

function buildFeedbackInviteUrl(baseUrl: string, token: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const url = new URL('/feedback', base)
  url.searchParams.set('token', token)
  return url.toString()
}

function tokenFromBodyOrHeader(req: http.IncomingMessage, body: Record<string, unknown>): string | null {
  const fromBody = typeof body.token === 'string' ? body.token.trim() : ''
  if (fromBody) return fromBody
  const header = req.headers['x-sitelayer-feedback-invite']
  if (typeof header === 'string' && header.trim()) return header.trim()
  return null
}

function secretUnavailable(ctx: FeedbackInviteRouteCtx): boolean {
  if (ctx.feedbackInviteSecret?.trim()) return false
  ctx.sendJson(503, { error: 'feedback invite signing is not configured' })
  return true
}

async function loadFeedbackInviteByToken(
  pool: Pool,
  secret: string,
  token: string,
): Promise<FeedbackInviteLookupResult> {
  const verify = verifyFeedbackInviteToken(token, feedbackInviteSecretMap(secret, 'default'))
  if (!verify.ok) return { ok: false, status: 401, error: 'invalid feedback invite token' }
  const result = await pool.query<FeedbackInvitePublicRow>(
    `select fi.id, fi.company_id, fi.token_id, fi.token_kid, fi.reviewer_ref, fi.source, fi.target_route,
            fi.allowed_capture_modes, fi.expires_at, fi.revoked_at, fi.created_by_user_id, fi.created_at,
            fi.last_used_at, fi.last_accessed_at, fi.access_count, fi.metadata,
            c.slug as company_slug, c.name as company_name
       from feedback_invites fi
       join companies c on c.id = fi.company_id
      where fi.token_id = $1 and fi.token_kid = $2
      limit 1`,
    [verify.id, verify.kid],
  )
  const invite = result.rows[0]
  if (!invite) return { ok: false, status: 404, error: 'feedback invite not found' }
  if (invite.revoked_at) return { ok: false, status: 410, error: 'feedback invite revoked' }
  const expiresMs = new Date(invite.expires_at).getTime()
  if (Number.isFinite(expiresMs) && expiresMs <= Date.now()) {
    return { ok: false, status: 410, error: 'feedback invite expired' }
  }
  return { ok: true, row: invite }
}

function actorForFeedbackInvite(invite: FeedbackInvitePublicRow): PortalCaptureActor {
  return {
    companyId: invite.company_id,
    actorRef: invite.id,
    authority: 'signed_feedback_invite_token',
    surface: 'feedback_invite',
    metadata: {
      feedback_invite_id: invite.id,
      reviewer_ref: invite.reviewer_ref,
      source: invite.source,
      target_route: invite.target_route,
      allowed_capture_modes: invite.allowed_capture_modes,
    },
    consentScope: {
      feedback_invite_id: invite.id,
      reviewer_ref: invite.reviewer_ref,
      source: invite.source,
      target_route: invite.target_route,
      allowed_capture_modes: invite.allowed_capture_modes,
    },
  }
}

async function resolveFeedbackCaptureActor(
  req: http.IncomingMessage,
  ctx: FeedbackInviteRouteCtx,
  body: Record<string, unknown>,
): Promise<{ ok: true; actor: PortalCaptureActor; body: Record<string, unknown> } | { ok: false }> {
  if (secretUnavailable(ctx)) return { ok: false }
  const token = tokenFromBodyOrHeader(req, body)
  if (!token) {
    ctx.sendJson(401, { error: 'feedback invite token is required' })
    return { ok: false }
  }
  const lookup = await loadFeedbackInviteByToken(ctx.pool, ctx.feedbackInviteSecret!, token)
  if (!lookup.ok) {
    ctx.sendJson(lookup.status, { error: lookup.error })
    return { ok: false }
  }
  // Access audit (migration 011): bump count + timestamps on every successful
  // public capture-actor resolution. company_id-scoped so the RLS route lint is
  // satisfied (this is the pre-GUC portal surface) and the write stays tenant-safe.
  await ctx.pool.query(
    `update feedback_invites
        set last_used_at = now(), last_accessed_at = now(), access_count = access_count + 1
      where company_id = $1 and id = $2`,
    [lookup.row.company_id, lookup.row.id],
  )
  const { token: _token, ...captureBody } = body
  void _token
  return { ok: true, actor: actorForFeedbackInvite(lookup.row), body: captureBody }
}

export async function handleFeedbackInviteRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: FeedbackInviteRouteCtx,
): Promise<boolean> {
  const { pool, sendJson, readBody } = ctx

  // ---- POST /api/portal/feedback-invites/resolve — public token bootstrap ---
  if (req.method === 'POST' && url.pathname === '/api/portal/feedback-invites/resolve') {
    if (secretUnavailable(ctx)) return true
    const parsed = parseJsonBody(ResolveFeedbackInviteSchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }
    const lookup = await loadFeedbackInviteByToken(pool, ctx.feedbackInviteSecret!, parsed.value.token)
    if (!lookup.ok) {
      sendJson(lookup.status, { error: lookup.error })
      return true
    }
    // Access audit (migration 011) — see resolveFeedbackCaptureActor.
    await pool.query(
      `update feedback_invites
          set last_used_at = now(), last_accessed_at = now(), access_count = access_count + 1
        where company_id = $1 and id = $2`,
      [lookup.row.company_id, lookup.row.id],
    )
    sendJson(200, { invite: publicShape(lookup.row) })
    return true
  }

  // ---- Feedback-invite capture routes — public, token in body/header --------
  if (url.pathname === '/api/portal/feedback-invites/capture-sessions' && req.method === 'POST') {
    const body = await readBody()
    const resolved = await resolveFeedbackCaptureActor(req, ctx, body)
    if (!resolved.ok) return true
    await startPortalCaptureSession({ ...ctx, readBody: async () => resolved.body }, resolved.actor)
    return true
  }

  const captureEventsMatch = url.pathname.match(/^\/api\/portal\/feedback-invites\/capture-sessions\/([^/]+)\/events$/)
  if (captureEventsMatch && req.method === 'POST') {
    const body = await readBody()
    const resolved = await resolveFeedbackCaptureActor(req, ctx, body)
    if (!resolved.ok) return true
    await appendPortalCaptureEvents(
      { ...ctx, readBody: async () => resolved.body },
      resolved.actor,
      captureEventsMatch[1],
    )
    return true
  }

  const captureUploadMatch = url.pathname.match(
    /^\/api\/portal\/feedback-invites\/capture-sessions\/([^/]+)\/artifacts\/upload$/,
  )
  if (captureUploadMatch && req.method === 'POST') {
    const resolved = await resolveFeedbackCaptureActor(req, ctx, {})
    if (!resolved.ok) return true
    await uploadPortalCaptureArtifact(req, ctx, resolved.actor, captureUploadMatch[1]!)
    return true
  }

  const captureFinalizeMatch = url.pathname.match(
    /^\/api\/portal\/feedback-invites\/capture-sessions\/([^/]+)\/finalize$/,
  )
  if (captureFinalizeMatch && req.method === 'POST') {
    const body = await readBody()
    const resolved = await resolveFeedbackCaptureActor(req, ctx, body)
    if (!resolved.ok) return true
    await finalizePortalCaptureSession(
      { ...ctx, readBody: async () => resolved.body },
      resolved.actor,
      captureFinalizeMatch[1]!,
    )
    return true
  }

  const captureDiscardMatch = url.pathname.match(
    /^\/api\/portal\/feedback-invites\/capture-sessions\/([^/]+)\/discard$/,
  )
  if (captureDiscardMatch && req.method === 'POST') {
    const body = await readBody()
    const resolved = await resolveFeedbackCaptureActor(req, ctx, body)
    if (!resolved.ok) return true
    await discardPortalCaptureSession(
      { ...ctx, readBody: async () => resolved.body },
      resolved.actor,
      captureDiscardMatch[1]!,
    )
    return true
  }

  const collectionMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/feedback-invites$/)

  // ---- POST /api/companies/:id/feedback-invites — admin create -------------
  if (req.method === 'POST' && collectionMatch) {
    if (secretUnavailable(ctx)) return true
    const companyId = collectionMatch[1]!
    if (await blockIfNotAdmin(ctx, companyId)) return true

    const parsed = parseJsonBody(CreateFeedbackInviteSchema, await readBody())
    if (!parsed.ok) {
      sendJson(400, { error: parsed.error })
      return true
    }
    const company = await pool.query<{ id: string; slug: string; name: string }>(
      'select id, slug, name from companies where id = $1 limit 1',
      [companyId],
    )
    if (!company.rows[0]) {
      sendJson(404, { error: 'company not found' })
      return true
    }

    const signed = generateFeedbackInviteToken(ctx.feedbackInviteSecret!, 'default')
    const expiresDays = parsed.value.expires_in_days ?? 14
    const insert = await pool.query<FeedbackInviteRow>(
      `insert into feedback_invites (
         company_id, token_id, token_kid, reviewer_ref, source, target_route, allowed_capture_modes,
         expires_at, created_by_user_id, metadata
       )
       values ($1, $2, $3, $4, $5, $6, $7, now() + ($8 || ' days')::interval, $9, $10::jsonb)
       returning id, company_id, token_id, token_kid, reviewer_ref, source, target_route, allowed_capture_modes,
                 expires_at, revoked_at, created_by_user_id, created_at, last_used_at,
                 last_accessed_at, access_count, metadata`,
      [
        companyId,
        signed.id,
        signed.kid,
        parsed.value.reviewer_ref ?? 'collaborator',
        parsed.value.source ?? 'manual',
        parsed.value.target_route ?? null,
        parsed.value.allowed_capture_modes ?? ['text', 'state'],
        String(expiresDays),
        ctx.userId,
        JSON.stringify(parsed.value.metadata ?? {}),
      ],
    )
    const row = insert.rows[0]
    if (!row) throw new Error('feedback invite insert returned no row')

    await recordAudit(pool, {
      companyId,
      actorUserId: ctx.userId,
      entityType: 'feedback_invite',
      entityId: row.id,
      action: 'create',
      after: adminShape(row),
    })

    sendJson(201, {
      invite: adminShape(row),
      token: signed.token,
      invite_url: buildFeedbackInviteUrl(ctx.portalBaseUrl, signed.token),
    })
    return true
  }

  // ---- GET /api/companies/:id/feedback-invites — admin list ----------------
  if (req.method === 'GET' && collectionMatch) {
    const companyId = collectionMatch[1]!
    if (await blockIfNotAdmin(ctx, companyId)) return true
    const pagination = parsePagination(url.searchParams)
    if (!pagination.ok) {
      sendJson(400, { error: pagination.error })
      return true
    }
    const { limit, offset } = pagination.value
    const result = await pool.query<FeedbackInviteRow>(
      `select id, company_id, token_id, token_kid, reviewer_ref, source, target_route, allowed_capture_modes,
              expires_at, revoked_at, created_by_user_id, created_at, last_used_at,
              last_accessed_at, access_count, metadata
         from feedback_invites
        where company_id = $1
        order by created_at desc
        limit $2 offset $3`,
      [companyId, limit, offset],
    )
    sendJson(200, {
      invites: result.rows.map(adminShape),
      pagination: buildPaginationMeta({ limit, offset }, result.rows.length),
    })
    return true
  }

  // ---- POST /api/companies/:id/feedback-invites/:inviteId/revoke -----------
  const revokeMatch = url.pathname.match(/^\/api\/companies\/([^/]+)\/feedback-invites\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    const companyId = revokeMatch[1]!
    const inviteId = revokeMatch[2]!
    if (await blockIfNotAdmin(ctx, companyId)) return true
    const result = await pool.query<FeedbackInviteRow>(
      `update feedback_invites
          set revoked_at = coalesce(revoked_at, now())
        where company_id = $1 and id = $2
        returning id, company_id, token_id, token_kid, reviewer_ref, source, target_route, allowed_capture_modes,
                  expires_at, revoked_at, created_by_user_id, created_at, last_used_at,
                  last_accessed_at, access_count, metadata`,
      [companyId, inviteId],
    )
    const row = result.rows[0]
    if (!row) {
      sendJson(404, { error: 'feedback invite not found' })
      return true
    }
    await recordAudit(pool, {
      companyId,
      actorUserId: ctx.userId,
      entityType: 'feedback_invite',
      entityId: row.id,
      action: 'revoke',
      after: { id: row.id, revoked_at: row.revoked_at },
    })
    sendJson(200, { invite: adminShape(row) })
    return true
  }

  return false
}
