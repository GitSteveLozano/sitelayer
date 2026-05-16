import type http from 'node:http'
import type { Pool } from 'pg'
import { randomBytes } from 'node:crypto'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

/**
 * Admin-side customer portal links — issue, revoke, and inspect.
 * The matching public read endpoints (token → snapshot) belong in
 * routes/public.ts so they bypass company auth; this module is purely
 * the operator-side admin surface.
 */
export type CustomerPortalRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const COLUMNS = `
  id, company_id, customer_id, project_id, portal_token, recipient_email,
  recipient_name, allows, expires_at, revoked_at, viewed_at, view_count,
  origin, created_at, updated_at
`

function s(v: unknown): string | null {
  if (v == null) return null
  const t = String(v).trim()
  return t ? t : null
}

function mintToken(): string {
  return randomBytes(24).toString('base64url')
}

const ALLOWED_KINDS = new Set(['estimates', 'invoices', 'photos', 'inspections', 'shipments', 'schedules'])

export async function handleCustomerPortalRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: CustomerPortalRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/customer-portal-links') {
    const customerId = url.searchParams.get('customer_id')
    const projectId = url.searchParams.get('project_id')
    const params: unknown[] = [ctx.company.id]
    let where = 'company_id = $1'
    if (customerId) {
      params.push(customerId)
      where += ` and customer_id = $${params.length}`
    }
    if (projectId) {
      params.push(projectId)
      where += ` and project_id = $${params.length}`
    }
    const result = await ctx.pool.query(
      `select ${COLUMNS} from customer_portal_links where ${where} order by created_at desc limit 200`,
      params,
    )
    ctx.sendJson(200, { links: result.rows })
    return true
  }
  if (req.method === 'POST' && url.pathname === '/api/customer-portal-links') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const customerId = s(body.customer_id)
    const projectId = s(body.project_id)
    if (!customerId && !projectId) {
      ctx.sendJson(400, { error: 'customer_id or project_id is required' })
      return true
    }
    const rawAllows = Array.isArray(body.allows) ? (body.allows as unknown[]) : []
    const allows = rawAllows.map((v) => String(v)).filter((v) => ALLOWED_KINDS.has(v))
    const result = await ctx.pool.query(
      `insert into customer_portal_links (
        company_id, customer_id, project_id, portal_token, recipient_email,
        recipient_name, allows, expires_at
      ) values ($1, $2, $3, $4, $5, $6, $7::jsonb, coalesce($8::timestamptz, now() + interval '180 days'))
      returning ${COLUMNS}`,
      [
        ctx.company.id,
        customerId,
        projectId,
        mintToken(),
        s(body.recipient_email),
        s(body.recipient_name),
        JSON.stringify(allows),
        s(body.expires_at),
      ],
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }
  const revokeMatch = url.pathname.match(/^\/api\/customer-portal-links\/([^/]+)\/revoke$/)
  if (req.method === 'POST' && revokeMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = revokeMatch[1]!
    const result = await ctx.pool.query(
      `update customer_portal_links
         set revoked_at = now(), updated_at = now()
       where company_id = $1 and id = $2 and revoked_at is null
       returning ${COLUMNS}`,
      [ctx.company.id, id],
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'link not found or already revoked' })
      return true
    }
    ctx.sendJson(200, result.rows[0])
    return true
  }

  return false
}
