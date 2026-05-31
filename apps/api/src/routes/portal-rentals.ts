import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { getRequestContext } from '@sitelayer/logger'
import { resolveShareSecret, verifyShareToken } from '../estimate-share-token.js'
import { HttpError } from '../http-utils.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import {
  appendPortalCaptureEvents,
  startPortalCaptureSession,
  uploadPortalCaptureArtifact,
} from './portal-capture-sessions.js'

/**
 * Public, unauthenticated routes for the customer rental portal. These run
 * before Clerk identity resolution because the recipient is a customer
 * holding a signed share token — no Bearer JWT exists for them.
 *
 * Surfaces:
 *   GET  /api/portal/rentals/:share_token/catalog  — public read of the company's
 *        active inventory_items (id/code/description/category/unit/rate/replacement
 *        only, no internal fields).
 *   POST /api/portal/rentals/:share_token/reserve  — appends a row to
 *        rental_requests (status='pending') for operator review. No live
 *        confirmation; the operator approves out-of-band.
 *
 * Token verification reuses `verifyShareToken` from estimate-share-token.ts
 * (same HMAC scheme as the sales-loop slice) so a single secret covers both
 * portal surfaces. See estimate-share-token.ts for the full token contract.
 */

export type PortalRentalsRouteCtx = {
  pool: Pool
  sendJson: (status: number, body: unknown) => void
  readBody: () => Promise<Record<string, unknown>>
  storage?: Parameters<typeof uploadPortalCaptureArtifact>[1]['storage']
  maxArtifactBytes?: number
}

type ShareLinkRow = {
  id: string
  company_id: string
  customer_id: string | null
  share_token: string
  expires_at: string | null
}

async function resolveShareLink(
  pool: Pool,
  shareToken: string,
): Promise<{ ok: true; link: ShareLinkRow } | { ok: false; status: number; error: string }> {
  if (!shareToken || shareToken.length < 8) {
    return { ok: false, status: 400, error: 'invalid share token' }
  }
  const secret = resolveShareSecret()
  if (!secret) {
    return { ok: false, status: 503, error: 'share secret not configured' }
  }
  const verify = verifyShareToken(shareToken, secret)
  if (!verify.ok) {
    return { ok: false, status: 401, error: 'share token failed verification' }
  }
  const result = await pool.query<ShareLinkRow>(
    `select id, company_id, customer_id, share_token, expires_at
     from rental_share_links where share_token = $1 limit 1`,
    [shareToken],
  )
  const link = result.rows[0]
  if (!link) {
    return { ok: false, status: 404, error: 'share link not found' }
  }
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 410, error: 'share link expired' }
  }
  return { ok: true, link }
}

export async function handlePortalRentalRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: PortalRentalsRouteCtx,
): Promise<boolean> {
  // GET /api/portal/rentals/:share_token/catalog
  const catalogMatch = url.pathname.match(/^\/api\/portal\/rentals\/([^/]+)\/catalog$/)
  if (req.method === 'GET' && catalogMatch) {
    const shareToken = decodeURIComponent(catalogMatch[1]!)
    const resolution = await resolveShareLink(ctx.pool, shareToken)
    if (!resolution.ok) {
      ctx.sendJson(resolution.status, { error: resolution.error })
      return true
    }
    const items = await withCompanyClient(resolution.link.company_id, (c) =>
      c.query<{
        id: string
        code: string
        description: string
        category: string
        unit: string
        default_rental_rate: string
        replacement_value: string | null
      }>(
        `
      select id, code, description, category, unit, default_rental_rate, replacement_value
      from inventory_items
      where company_id = $1 and deleted_at is null and active = true
      order by category, code
      `,
        [resolution.link.company_id],
      ),
    )
    ctx.sendJson(200, {
      company_id: resolution.link.company_id,
      customer_id: resolution.link.customer_id,
      items: items.rows,
    })
    return true
  }

  // POST /api/portal/rentals/:share_token/reserve
  const reserveMatch = url.pathname.match(/^\/api\/portal\/rentals\/([^/]+)\/reserve$/)
  if (req.method === 'POST' && reserveMatch) {
    const shareToken = decodeURIComponent(reserveMatch[1]!)
    const resolution = await resolveShareLink(ctx.pool, shareToken)
    if (!resolution.ok) {
      ctx.sendJson(resolution.status, { error: resolution.error })
      return true
    }
    const body = await ctx.readBody()
    const items = Array.isArray(body.items) ? body.items : []
    if (items.length === 0) {
      ctx.sendJson(400, { error: 'items array is required and must be non-empty' })
      return true
    }
    // Light validation — operator review is the source of truth for cleaning
    // up partial / typo'd entries before they convert into a real rental.
    const sanitizedItems = items.map((item) => {
      const obj = (item ?? {}) as Record<string, unknown>
      return {
        inventory_item_id: typeof obj.inventory_item_id === 'string' ? obj.inventory_item_id : null,
        qty: Number(obj.qty ?? 1),
        start: typeof obj.start === 'string' ? obj.start : null,
        end: typeof obj.end === 'string' ? obj.end : null,
        delivery: typeof obj.delivery === 'string' ? obj.delivery : 'pickup',
      }
    })
    const requestedStart = typeof body.requested_start === 'string' ? body.requested_start : null
    const requestedEnd = typeof body.requested_end === 'string' ? body.requested_end : null
    const contactName = typeof body.contact_name === 'string' ? body.contact_name : null
    const contactEmail = typeof body.contact_email === 'string' ? body.contact_email : null
    const contactPhone = typeof body.contact_phone === 'string' ? body.contact_phone : null
    const notes = typeof body.notes === 'string' ? body.notes : null

    const inserted = await withMutationTx(async (client: PoolClient) => {
      const result = await client.query<{ id: string; created_at: string; status: string }>(
        `
        insert into rental_requests (
          company_id, share_link_id, customer_id, items,
          requested_start, requested_end, contact_name, contact_email, contact_phone, notes
        )
        values ($1, $2, $3, $4::jsonb, $5::date, $6::date, $7, $8, $9, $10)
        returning id, created_at, status
        `,
        [
          resolution.link.company_id,
          resolution.link.id,
          resolution.link.customer_id,
          JSON.stringify(sanitizedItems),
          requestedStart,
          requestedEnd,
          contactName,
          contactEmail,
          contactPhone,
          notes,
        ],
      )
      // Surface the request through mutation_outbox so operators see it in the
      // standard sync feed. We don't go through recordMutationLedger because
      // there is no authenticated company context on this path; a direct
      // insert keeps the audit trail without requiring a fake actor.
      const row = result.rows[0]
      if (!row) throw new HttpError(500, 'rental request insert returned no row')
    await client.query(
        `
        insert into mutation_outbox (
          company_id, device_id, actor_user_id, entity_type, entity_id, mutation_type, payload,
          idempotency_key, status, capture_session_id
        )
        values ($1, 'portal', null, 'rental_request', $2, 'create', $3::jsonb, $4, 'pending', $5::uuid)
        on conflict (company_id, idempotency_key) do nothing
        `,
        [
          resolution.link.company_id,
          row.id,
          JSON.stringify({
            id: row.id,
            customer_id: resolution.link.customer_id,
            items: sanitizedItems,
            requested_start: requestedStart,
            requested_end: requestedEnd,
            contact: { name: contactName, email: contactEmail, phone: contactPhone },
            notes,
            source: 'portal',
          }),
          `rental_request:create:${row.id}`,
          getRequestContext()?.captureSessionId ?? null,
        ],
      )
      return row
    })
    ctx.sendJson(201, { id: inserted.id, status: inserted.status, created_at: inserted.created_at })
    return true
  }

  // POST /api/portal/rentals/:share_token/capture-sessions
  const captureStartMatch = url.pathname.match(/^\/api\/portal\/rentals\/([^/]+)\/capture-sessions$/)
  if (req.method === 'POST' && captureStartMatch) {
    const shareToken = decodeURIComponent(captureStartMatch[1]!)
    const resolution = await resolveShareLink(ctx.pool, shareToken)
    if (!resolution.ok) {
      ctx.sendJson(resolution.status, { error: resolution.error })
      return true
    }
    await startPortalCaptureSession(ctx, {
      companyId: resolution.link.company_id,
      actorRef: resolution.link.id,
      authority: 'signed_rental_share_token',
      surface: 'rental_portal',
      metadata: {
        rental_share_link_id: resolution.link.id,
        customer_id: resolution.link.customer_id,
      },
      consentScope: {
        rental_share_link_id: resolution.link.id,
        customer_id: resolution.link.customer_id,
      },
    })
    return true
  }

  // POST /api/portal/rentals/:share_token/capture-sessions/:id/events
  const captureEventsMatch = url.pathname.match(/^\/api\/portal\/rentals\/([^/]+)\/capture-sessions\/([^/]+)\/events$/)
  if (req.method === 'POST' && captureEventsMatch) {
    const shareToken = decodeURIComponent(captureEventsMatch[1]!)
    const captureSessionId = decodeURIComponent(captureEventsMatch[2]!)
    const resolution = await resolveShareLink(ctx.pool, shareToken)
    if (!resolution.ok) {
      ctx.sendJson(resolution.status, { error: resolution.error })
      return true
    }
    await appendPortalCaptureEvents(
      ctx,
      {
        companyId: resolution.link.company_id,
        actorRef: resolution.link.id,
        authority: 'signed_rental_share_token',
        surface: 'rental_portal',
        metadata: {
          rental_share_link_id: resolution.link.id,
          customer_id: resolution.link.customer_id,
        },
        consentScope: {
          rental_share_link_id: resolution.link.id,
          customer_id: resolution.link.customer_id,
        },
      },
      captureSessionId,
    )
    return true
  }

  // POST /api/portal/rentals/:share_token/capture-sessions/:id/artifacts/upload
  const captureUploadMatch = url.pathname.match(
    /^\/api\/portal\/rentals\/([^/]+)\/capture-sessions\/([^/]+)\/artifacts\/upload$/,
  )
  if (req.method === 'POST' && captureUploadMatch) {
    const shareToken = decodeURIComponent(captureUploadMatch[1]!)
    const captureSessionId = decodeURIComponent(captureUploadMatch[2]!)
    const resolution = await resolveShareLink(ctx.pool, shareToken)
    if (!resolution.ok) {
      ctx.sendJson(resolution.status, { error: resolution.error })
      return true
    }
    await uploadPortalCaptureArtifact(
      req,
      ctx,
      {
        companyId: resolution.link.company_id,
        actorRef: resolution.link.id,
        authority: 'signed_rental_share_token',
        surface: 'rental_portal',
        metadata: {
          rental_share_link_id: resolution.link.id,
          customer_id: resolution.link.customer_id,
        },
        consentScope: {
          rental_share_link_id: resolution.link.id,
          customer_id: resolution.link.customer_id,
        },
      },
      captureSessionId,
    )
    return true
  }

  return false
}
