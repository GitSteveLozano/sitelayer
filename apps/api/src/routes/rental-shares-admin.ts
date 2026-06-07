import type http from 'node:http'
import type { Pool } from 'pg'
import { recordAudit } from '../audit.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'

/**
 * Owner-side admin surface for rental share links (LANE A — portal-link
 * revocation + access audit).
 *
 * The public rental portal (`routes/portal-rentals.ts`) reads
 * `rental_share_links` by HMAC-signed share token to expose a company's rental
 * catalog and accept reservations. Until migration 011 there was NO way for the
 * owner to kill a leaked/forwarded link and no access trail. This module adds:
 *
 *   GET  /api/rental-share-links
 *     → company-scoped list of the company's rental share links with their
 *       usage audit (access_count / last_accessed_at / revoked_at) so the owner
 *       can spot a forwarded link. Admin/office only (it exposes customer_id +
 *       usage across the company). The share_token itself is NOT returned.
 *
 *   POST /api/rental-share-links/:id/revoke
 *     → admin/office; set revoked_at so the public gate (resolveShareLink)
 *       rejects (HTTP 410) BEFORE exposing the catalog or accepting a reserve.
 *       Idempotent: re-revoking a revoked link 404s ("not found or already
 *       revoked"), matching the customer-portal-links revoke shape.
 *
 * Mirrors the auth + company-scoping of routes/customer-portal-links.ts and the
 * REVOKE shape of routes/estimate-shares-admin.ts.
 */

export type RentalShareAdminRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

type RentalShareAdminRow = {
  id: string
  company_id: string
  customer_id: string | null
  expires_at: string | null
  revoked_at: string | null
  last_accessed_at: string | null
  access_count: number
  created_at: string
}

// Deliberately excludes share_token — the owner already has the link; the admin
// surface never re-lists the raw token (same posture as the estimate/feedback
// admin shapes).
const ADMIN_COLUMNS = `
  id, company_id, customer_id, expires_at, revoked_at,
  last_accessed_at, access_count, created_at
`

function shape(row: RentalShareAdminRow) {
  const now = Date.now()
  const expired = row.expires_at != null && new Date(row.expires_at).getTime() <= now
  const status = row.revoked_at ? 'revoked' : expired ? 'expired' : 'active'
  return {
    id: row.id,
    customer_id: row.customer_id,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    last_accessed_at: row.last_accessed_at,
    access_count: row.access_count,
    created_at: row.created_at,
    status,
  }
}

export async function handleRentalShareAdminRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: RentalShareAdminRouteCtx,
): Promise<boolean> {
  // GET /api/rental-share-links — company-scoped usage list
  if (req.method === 'GET' && url.pathname === '/api/rental-share-links') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const customerId = url.searchParams.get('customer_id')
    const params: unknown[] = [ctx.company.id]
    let where = 'company_id = $1'
    if (customerId) {
      params.push(customerId)
      where += ` and customer_id = $${params.length}`
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<RentalShareAdminRow>(
        `select ${ADMIN_COLUMNS} from rental_share_links where ${where} order by created_at desc limit 200`,
        params,
      ),
    )
    ctx.sendJson(200, { links: result.rows.map(shape) })
    return true
  }

  // POST /api/rental-share-links/:id/revoke — kill a leaked/forwarded link
  const revokeMatch = url.pathname.match(/^\/api\/rental-share-links\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = revokeMatch[1]!
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query<RentalShareAdminRow>(
        `update rental_share_links
            set revoked_at = now()
          where company_id = $1 and id = $2 and revoked_at is null
          returning ${ADMIN_COLUMNS}`,
        [ctx.company.id, id],
      ),
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'rental share link not found or already revoked' })
      return true
    }
    await recordAudit(ctx.pool, {
      companyId: ctx.company.id,
      actorUserId: ctx.currentUserId,
      entityType: 'rental_share_link',
      entityId: row.id,
      action: 'revoke',
      after: { id: row.id, revoked_at: row.revoked_at },
    })
    ctx.sendJson(200, shape(row))
    return true
  }

  return false
}
