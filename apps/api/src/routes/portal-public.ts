import type http from 'node:http'
import type { Pool } from 'pg'

/**
 * Public read-by-token surface for customer_portal_links.
 *
 * Handled BEFORE identity resolution, like estimate-shares + portal-rentals.
 * The token alone authenticates; we never expose company internals beyond
 * what the link's `allows[]` permits (intersected with the company-wide
 * companies.portal_settings).
 *
 * Routes:
 *   GET /api/portal/links/:token            — link metadata + what's allowed
 *   GET /api/portal/links/:token/projects/:projectId/photos
 *   GET /api/portal/links/:token/projects/:projectId/inspections
 *   GET /api/portal/links/:token/projects/:projectId/shipments
 */

export type PublicPortalRouteCtx = {
  pool: Pool
  sendJson: (status: number, body: unknown) => void
}

type LinkRow = {
  id: string
  company_id: string
  customer_id: string | null
  project_id: string | null
  allows: string[] | null
  expires_at: string
  revoked_at: string | null
  recipient_name: string | null
}

type CompanyPortal = {
  show_estimates: boolean
  show_invoices: boolean
  show_photos: boolean
  show_inspections: boolean
}

async function resolveLink(
  pool: Pool,
  token: string,
): Promise<{ link: LinkRow; settings: CompanyPortal; allows: Set<string> } | { error: string; status: number }> {
  const result = await pool.query<LinkRow & CompanyPortal>(
    `select l.id, l.company_id, l.customer_id, l.project_id, l.allows, l.expires_at, l.revoked_at, l.recipient_name,
            (c.portal_settings ->> 'show_estimates')::boolean as show_estimates,
            (c.portal_settings ->> 'show_invoices')::boolean as show_invoices,
            (c.portal_settings ->> 'show_photos')::boolean as show_photos,
            (c.portal_settings ->> 'show_inspections')::boolean as show_inspections
     from customer_portal_links l
     join companies c on c.id = l.company_id
     where l.portal_token = $1 limit 1`,
    [token],
  )
  if (!result.rows[0]) {
    return { error: 'link not found', status: 404 }
  }
  const row = result.rows[0]
  if (row.revoked_at) return { error: 'link revoked', status: 410 }
  if (new Date(row.expires_at).getTime() < Date.now()) return { error: 'link expired', status: 410 }
  const allowList: string[] = Array.isArray(row.allows) ? (row.allows as string[]) : []
  // Empty allow-list defaults to the company-wide portal_settings.
  const allows = new Set<string>()
  if (allowList.length > 0) {
    for (const v of allowList) allows.add(v)
  } else {
    if (row.show_estimates) allows.add('estimates')
    if (row.show_invoices) allows.add('invoices')
    if (row.show_photos) allows.add('photos')
    if (row.show_inspections) allows.add('inspections')
  }
  // Per-link allow can't override an OFF company setting.
  if (!row.show_estimates) allows.delete('estimates')
  if (!row.show_invoices) allows.delete('invoices')
  if (!row.show_photos) allows.delete('photos')
  if (!row.show_inspections) allows.delete('inspections')
  return {
    link: row,
    settings: {
      show_estimates: row.show_estimates,
      show_invoices: row.show_invoices,
      show_photos: row.show_photos,
      show_inspections: row.show_inspections,
    },
    allows,
  }
}

async function bumpViewCount(pool: Pool, linkId: string): Promise<void> {
  await pool
    .query(
      `update customer_portal_links
         set viewed_at = coalesce(viewed_at, now()),
             view_count = view_count + 1,
             updated_at = now()
       where id = $1`,
      [linkId],
    )
    .catch(() => {})
}

export async function handlePublicPortalRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: PublicPortalRouteCtx,
): Promise<boolean> {
  const linkMatch = url.pathname.match(/^\/api\/portal\/links\/([^/]+)$/)
  if (req.method === 'GET' && linkMatch) {
    const token = linkMatch[1]!
    const resolved = await resolveLink(ctx.pool, token)
    if ('error' in resolved) {
      ctx.sendJson(resolved.status, { error: resolved.error })
      return true
    }
    await bumpViewCount(ctx.pool, resolved.link.id)
    ctx.sendJson(200, {
      recipient_name: resolved.link.recipient_name,
      project_id: resolved.link.project_id,
      customer_id: resolved.link.customer_id,
      expires_at: resolved.link.expires_at,
      allows: [...resolved.allows],
    })
    return true
  }

  const photosMatch = url.pathname.match(/^\/api\/portal\/links\/([^/]+)\/projects\/([^/]+)\/photos$/)
  if (req.method === 'GET' && photosMatch) {
    const [, token, projectId] = photosMatch
    const resolved = await resolveLink(ctx.pool, token!)
    if ('error' in resolved) {
      ctx.sendJson(resolved.status, { error: resolved.error })
      return true
    }
    if (!resolved.allows.has('photos')) {
      ctx.sendJson(403, { error: 'photos not allowed on this portal link' })
      return true
    }
    // Per-link can be either customer-scoped (any of that customer's projects)
    // or project-scoped. If the link is project-scoped, projectId must match.
    if (resolved.link.project_id && resolved.link.project_id !== projectId) {
      ctx.sendJson(403, { error: 'project not allowed' })
      return true
    }
    const photos = await ctx.pool.query(
      `select dlp.id, dlp.storage_key, dlp.captured_at, dlp.scope_step_label
       from daily_log_photos dlp
       join daily_logs dl on dl.company_id = dlp.company_id and dl.id = dlp.daily_log_id
       where dlp.company_id = $1 and dl.project_id = $2
         and dl.status in ('submitted', 'approved')
       order by dlp.captured_at desc, dlp.created_at desc
       limit 200`,
      [resolved.link.company_id, projectId],
    )
    ctx.sendJson(200, { photos: photos.rows })
    return true
  }

  const inspectionsMatch = url.pathname.match(/^\/api\/portal\/links\/([^/]+)\/projects\/([^/]+)\/inspections$/)
  if (req.method === 'GET' && inspectionsMatch) {
    const [, token, projectId] = inspectionsMatch
    const resolved = await resolveLink(ctx.pool, token!)
    if ('error' in resolved) {
      ctx.sendJson(resolved.status, { error: resolved.error })
      return true
    }
    if (!resolved.allows.has('inspections')) {
      ctx.sendJson(403, { error: 'inspections not allowed on this portal link' })
      return true
    }
    if (resolved.link.project_id && resolved.link.project_id !== projectId) {
      ctx.sendJson(403, { error: 'project not allowed' })
      return true
    }
    const inspections = await ctx.pool.query(
      `select i.id, i.tag_id, t.label as tag_label, i.status, i.signed_at,
              to_char(i.next_due_on, 'YYYY-MM-DD') as next_due_on,
              i.inspector_name, i.defects
       from scaffold_inspections i
       join scaffold_tags t on t.company_id = i.company_id and t.id = i.tag_id
       where i.company_id = $1 and i.project_id = $2
       order by i.signed_at desc limit 100`,
      [resolved.link.company_id, projectId],
    )
    ctx.sendJson(200, { inspections: inspections.rows })
    return true
  }

  const shipmentsMatch = url.pathname.match(/^\/api\/portal\/links\/([^/]+)\/projects\/([^/]+)\/shipments$/)
  if (req.method === 'GET' && shipmentsMatch) {
    const [, token, projectId] = shipmentsMatch
    const resolved = await resolveLink(ctx.pool, token!)
    if ('error' in resolved) {
      ctx.sendJson(resolved.status, { error: resolved.error })
      return true
    }
    if (resolved.link.project_id && resolved.link.project_id !== projectId) {
      ctx.sendJson(403, { error: 'project not allowed' })
      return true
    }
    const shipments = await ctx.pool.query(
      `select id, direction, status,
              to_char(scheduled_for, 'YYYY-MM-DD') as scheduled_for,
              shipped_at, delivered_at, ticket_number
       from shipments
       where company_id = $1 and project_id = $2 and deleted_at is null
       order by coalesce(scheduled_for, created_at::date) desc limit 50`,
      [resolved.link.company_id, projectId],
    )
    ctx.sendJson(200, { shipments: shipments.rows })
    return true
  }

  return false
}
