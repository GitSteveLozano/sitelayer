import type http from 'node:http'
import type { Pool } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { withCompanyClient } from '../mutation-tx.js'
import { isValidUuid } from '../http-utils.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

export type BlueprintDiffRouteCtx = {
  pool: Pool
  company: ActiveCompany
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  sendJson: (status: number, body: unknown) => void
}

/** Shape of one `blueprint_page_diffs` row as returned to the client. */
interface DiffRow {
  id: string
  new_page_id: string
  prior_page_id: string | null
  new_page_number: number
  prior_page_number: number | null
  change_kind: 'added' | 'removed' | 'modified'
  bbox_x: string
  bbox_y: string
  bbox_w: string
  bbox_h: string
  confidence: string
  affected_measurement_ids: string[]
  notes: string | null
  created_at: string
}

/**
 * GET /api/blueprints/:id/diffs — serve the stored plan-revision diffs.
 *
 * The `blueprint_page_diffs` table (migration 037) records bounding boxes of
 * regions that changed between plan revisions, plus an
 * `affected_measurement_ids` snapshot of the takeoff measurements whose
 * centroid falls inside each changed region. The schema + a client-side
 * raster diff have shipped since Phase 3E, but until now **no API route
 * served those rows** and `affected_measurement_ids` was never consumed
 * (docs/TAKEOFF_DEEP_DIVE_2026-06-01.md, H3). This route is the read side:
 * it returns whatever diffs have been persisted for the requested document's
 * pages so the takeoff surface can render an "N measurements affected" badge.
 *
 * `:id` is a blueprint **document** id — matching the existing
 * `/api/blueprints/:docId/pages` route style — and the handler joins
 * diffs → pages → document so a diff is scoped to the newer revision's
 * document. Company scope is enforced by `withCompanyClient` (RLS) plus an
 * explicit `company_id = $1` predicate.
 *
 * When no rows have been populated the route returns an empty `diffs` array
 * and an `affected_measurement_ids: []` rollup — the badge then hides. Diff
 * population (an image-diff worker / live vision that writes these rows) is
 * the follow-up slice; this route only persists-and-serves what exists.
 */
export async function handleBlueprintDiffRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: BlueprintDiffRouteCtx,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/blueprints\/([^/]+)\/diffs$/)
  if (!match) return false
  if (req.method !== 'GET') return false

  const docId = match[1]!
  if (!isValidUuid(docId)) {
    ctx.sendJson(400, { error: 'document id must be a valid uuid' })
    return true
  }

  const docCheck = await withCompanyClient(ctx.company.id, (c) =>
    c.query<{ exists: boolean }>(
      `select exists(
         select 1 from blueprint_documents
         where company_id = $1 and id = $2 and deleted_at is null
       ) as exists`,
      [ctx.company.id, docId],
    ),
  )
  if (!docCheck.rows[0]?.exists) {
    ctx.sendJson(404, { error: 'blueprint document not found' })
    return true
  }

  const result = await withCompanyClient(ctx.company.id, (c) =>
    c.query<DiffRow>(
      `select
         d.id,
         d.new_page_id,
         d.prior_page_id,
         np.page_number as new_page_number,
         pp.page_number as prior_page_number,
         d.change_kind,
         d.bbox_x,
         d.bbox_y,
         d.bbox_w,
         d.bbox_h,
         d.confidence,
         d.affected_measurement_ids,
         d.notes,
         d.created_at
       from blueprint_page_diffs d
       join blueprint_pages np
         on np.company_id = d.company_id
        and np.id = d.new_page_id
        and np.blueprint_document_id = $2
       left join blueprint_pages pp
         on pp.company_id = d.company_id
        and pp.id = d.prior_page_id
       where d.company_id = $1
       order by np.page_number asc, d.created_at asc`,
      [ctx.company.id, docId],
    ),
  )

  // Roll the per-diff affected-measurement arrays up into one deduped list so
  // the badge can render a single "N measurements affected" count without the
  // client re-flattening. `affected_measurement_ids` is the cache populated by
  // the (follow-up) diff worker; it is treated as advisory here.
  const affectedSet = new Set<string>()
  for (const row of result.rows) {
    for (const id of row.affected_measurement_ids ?? []) affectedSet.add(id)
  }

  ctx.sendJson(200, {
    diffs: result.rows,
    affected_measurement_ids: [...affectedSet],
    affected_measurement_count: affectedSet.size,
  })
  return true
}

/**
 * Self-registered dispatch descriptor for the `blueprint-diffs` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const blueprintDiffsRouteDescriptor: DispatchRouteDescriptor = {
  name: 'blueprint-diffs',
  order: 370,
  handle: ({ req, url, pool, company, requireRoleStr, sendJson }) =>
    handleBlueprintDiffRoutes(req, url, {
      pool,
      company,
      requireRole: requireRoleStr,
      sendJson,
    }),
}
