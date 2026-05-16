import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'

/**
 * QR scaffold tags + inspections. Tags are project-scoped, identified by
 * an opaque qr_token (URL-safe) that the mobile scan resolves. Inspections
 * are append-only; the latest inspection summary is mirrored on the tag
 * row so the site-map render is one query.
 */
export type ScaffoldTagRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const TAG_COLUMNS = `
  id, company_id, project_id, qr_token, label, structure_type,
  to_char(erected_on, 'YYYY-MM-DD') as erected_on,
  to_char(dismantled_on, 'YYYY-MM-DD') as dismantled_on,
  height_m, load_class, last_inspection_id, last_inspection_status,
  last_inspection_at, status, lat, lng, notes, version,
  deleted_at, created_at, updated_at
`
const INSPECTION_COLUMNS = `
  id, company_id, tag_id, project_id, inspector_user_id, inspector_name,
  status, checklist, photo_refs, defects, remediation, signed_at,
  to_char(next_due_on, 'YYYY-MM-DD') as next_due_on, notes, created_at
`

function s(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const text = String(value).trim()
  return text ? text : null
}

function n(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function makeToken(): string {
  // 32-char url-safe random token (24 bytes base64url-trimmed).
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 0)
}

export async function handleScaffoldTagRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ScaffoldTagRouteCtx,
): Promise<boolean> {
  // List tags for a project (site map + inspection queue).
  const projectTagsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/scaffold-tags$/)
  if (req.method === 'GET' && projectTagsMatch) {
    const projectId = projectTagsMatch[1]!
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${TAG_COLUMNS} from scaffold_tags
       where company_id = $1 and project_id = $2 and deleted_at is null
       order by created_at desc`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { tags: result.rows })
    return true
  }
  // Create a new tag (admin/office/foreman).
  if (req.method === 'POST' && projectTagsMatch) {
    if (!ctx.requireRole(['admin', 'office', 'foreman'])) return true
    const projectId = projectTagsMatch[1]!
    const body = await ctx.readBody()
    const label = s(body.label)
    if (!label) {
      ctx.sendJson(400, { error: 'label is required' })
      return true
    }
    const qrToken = s(body.qr_token) ?? makeToken()
    const result = await withMutationTx(ctx.company.id, (c) =>
      c.query(
        `insert into scaffold_tags (
        company_id, project_id, qr_token, label, structure_type,
        erected_on, height_m, load_class, lat, lng, notes
      ) values ($1, $2, $3, $4, coalesce($5, 'scaffold'), $6, $7, $8, $9, $10, $11)
      returning ${TAG_COLUMNS}`,
        [
          ctx.company.id,
          projectId,
          qrToken,
          label,
          s(body.structure_type),
          s(body.erected_on),
          n(body.height_m),
          s(body.load_class),
          n(body.lat),
          n(body.lng),
          s(body.notes),
        ],
      ),
    )
    ctx.sendJson(201, result.rows[0])
    return true
  }

  // Resolve a tag by qr_token (public-ish — still company-scoped through ctx).
  const tagByTokenMatch = url.pathname.match(/^\/api\/scaffold-tags\/by-token\/([^/]+)$/)
  if (req.method === 'GET' && tagByTokenMatch) {
    const token = tagByTokenMatch[1]!
    const tag = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${TAG_COLUMNS} from scaffold_tags
       where company_id = $1 and qr_token = $2 and deleted_at is null`,
        [ctx.company.id, token],
      ),
    )
    if (!tag.rows[0]) {
      ctx.sendJson(404, { error: 'tag not found' })
      return true
    }
    const inspections = await withCompanyClient(ctx.company.id, (c) =>
      c.query(
        `select ${INSPECTION_COLUMNS} from scaffold_inspections
       where company_id = $1 and tag_id = $2 order by signed_at desc limit 10`,
        [ctx.company.id, tag.rows[0].id],
      ),
    )
    ctx.sendJson(200, { tag: tag.rows[0], inspections: inspections.rows })
    return true
  }

  // Append a new inspection record + mirror summary onto the tag.
  const tagInspectMatch = url.pathname.match(/^\/api\/scaffold-tags\/([^/]+)\/inspections$/)
  if (req.method === 'POST' && tagInspectMatch) {
    if (!ctx.requireRole(['admin', 'office', 'foreman'])) return true
    const tagId = tagInspectMatch[1]!
    const body = await ctx.readBody()
    const status = s(body.status)
    if (!status || !['pass', 'fail', 'tagged_out'].includes(status)) {
      ctx.sendJson(400, { error: 'status must be pass|fail|tagged_out' })
      return true
    }
    const result = await withMutationTx(async (client: PoolClient) => {
      const tag = await client.query<{ project_id: string }>(
        'select project_id from scaffold_tags where company_id = $1 and id = $2 and deleted_at is null',
        [ctx.company.id, tagId],
      )
      if (!tag.rows[0]) {
        return { error: 'tag not found' as const, code: 404 }
      }
      const inspection = await client.query(
        `insert into scaffold_inspections (
          company_id, tag_id, project_id, inspector_user_id, inspector_name,
          status, checklist, photo_refs, defects, remediation, next_due_on, notes
        ) values ($1, $2, $3, $4, $5, $6, coalesce($7, '[]'::jsonb), coalesce($8, '[]'::jsonb), $9, $10, $11, $12)
        returning ${INSPECTION_COLUMNS}`,
        [
          ctx.company.id,
          tagId,
          tag.rows[0].project_id,
          ctx.currentUserId,
          s(body.inspector_name),
          status,
          body.checklist ?? null,
          body.photo_refs ?? null,
          s(body.defects),
          s(body.remediation),
          s(body.next_due_on),
          s(body.notes),
        ],
      )
      const inspectionRow = inspection.rows[0]!
      // Mirror onto the tag.
      await client.query(
        `update scaffold_tags
           set last_inspection_id = $3,
               last_inspection_status = $4,
               last_inspection_at = now(),
               status = case
                 when $4 = 'tagged_out' then 'tagged_out'
                 when $4 = 'pass' and status = 'tagged_out' then 'active'
                 else status
               end,
               version = version + 1, updated_at = now()
         where company_id = $1 and id = $2`,
        [ctx.company.id, tagId, inspectionRow.id, status],
      )
      return { inspection: inspectionRow }
    })
    if ('error' in result) {
      ctx.sendJson(result.code ?? 400, { error: result.error })
      return true
    }
    ctx.sendJson(201, result.inspection)
    return true
  }

  return false
}
