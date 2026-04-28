import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { haversineDistanceMeters, isInsideGeofence } from '@sitelayer/domain'
import type { ActiveCompany } from '../auth-types.js'
import { recordMutationLedger, withMutationTx } from '../mutation-tx.js'
import { isValidUuid, parseOptionalNumber } from '../http-utils.js'

export type ClockRouteCtx = {
  pool: Pool
  company: ActiveCompany
  /**
   * Currently-active Clerk user id (or fallback header). Used as the
   * actor on clock_events and as the worker-resolution fallback.
   */
  currentUserId: string
  requireRole: (allowed: readonly string[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

/**
 * Handle clock event routes:
 * - POST /api/clock/in        — passive clock-in; resolves project via
 *                                explicit body.project_id or geofence
 *                                containment, falls back to no project
 *                                with inside_geofence=false
 * - POST /api/clock/out       — pairs with the latest open clock-in;
 *                                emits a draft labor_entry when the
 *                                duration is positive and < 24h
 * - GET  /api/clock/timeline  — admin/foreman/office; filterable by
 *                                worker_id and date
 */
export async function handleClockRoutes(req: http.IncomingMessage, url: URL, ctx: ClockRouteCtx): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/api/clock/in') {
    const body = await ctx.readBody()
    const lat = parseOptionalNumber(body.lat)
    const lng = parseOptionalNumber(body.lng)
    if (lat === null || lng === null) {
      ctx.sendJson(400, { error: 'lat and lng are required' })
      return true
    }
    const accuracy = parseOptionalNumber(body.accuracy_m)
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1024) : null
    const currentUserId = ctx.currentUserId

    const workerLookup = await ctx.pool.query<{ id: string }>(
      `
      select w.id
      from workers w
      where w.company_id = $1 and w.deleted_at is null
      order by w.created_at asc
      limit 1
      `,
      [ctx.company.id],
    )
    const workerId = workerLookup.rows[0]?.id ?? null

    let projectId: string | null = null
    let insideGeofence = false
    const explicitProjectId =
      body.project_id === undefined || body.project_id === null || body.project_id === ''
        ? null
        : String(body.project_id).trim()
    if (explicitProjectId) {
      if (!isValidUuid(explicitProjectId)) {
        ctx.sendJson(400, { error: 'project_id must be a valid uuid' })
        return true
      }
      const explicitProject = await ctx.pool.query<{
        id: string
        site_lat: string | null
        site_lng: string | null
        site_radius_m: number | null
      }>(
        `
        select id, site_lat, site_lng, site_radius_m
        from projects
        where company_id = $1 and id = $2 and deleted_at is null
        limit 1
        `,
        [ctx.company.id, explicitProjectId],
      )
      if (!explicitProject.rows[0]) {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      projectId = explicitProject.rows[0].id
      const pLat = Number(explicitProject.rows[0].site_lat)
      const pLng = Number(explicitProject.rows[0].site_lng)
      const pRad = Number(explicitProject.rows[0].site_radius_m ?? 0)
      if (Number.isFinite(pLat) && Number.isFinite(pLng) && pRad > 0) {
        insideGeofence = isInsideGeofence({
          lat: pLat,
          lng: pLng,
          radius_m: pRad,
          point: { lat, lng },
        })
      }
    } else {
      const candidateProjects = await ctx.pool.query<{
        id: string
        site_lat: string | null
        site_lng: string | null
        site_radius_m: number | null
      }>(
        `
        select id, site_lat, site_lng, site_radius_m
        from projects
        where company_id = $1
          and deleted_at is null
          and site_lat is not null
          and site_lng is not null
          and site_radius_m is not null
          and site_radius_m > 0
        `,
        [ctx.company.id],
      )
      let bestDistance = Number.POSITIVE_INFINITY
      for (const row of candidateProjects.rows) {
        const pLat = Number(row.site_lat)
        const pLng = Number(row.site_lng)
        const pRad = Number(row.site_radius_m ?? 0)
        if (!Number.isFinite(pLat) || !Number.isFinite(pLng) || pRad <= 0) continue
        if (!isInsideGeofence({ lat: pLat, lng: pLng, radius_m: pRad, point: { lat, lng } })) continue
        const distance = haversineDistanceMeters({ lat: pLat, lng: pLng }, { lat, lng })
        if (distance < bestDistance) {
          bestDistance = distance
          projectId = row.id
          insideGeofence = true
        }
      }
    }

    const inserted = await ctx.pool.query(
      `
      insert into clock_events (
        company_id, worker_id, project_id, clerk_user_id, event_type,
        lat, lng, accuracy_m, inside_geofence, notes
      )
      values ($1, $2, $3, $4, 'in', $5, $6, $7, $8, $9)
      returning id, company_id, worker_id, project_id, clerk_user_id,
                event_type, occurred_at, lat, lng, accuracy_m,
                inside_geofence, notes, created_at
      `,
      [ctx.company.id, workerId, projectId, currentUserId, lat, lng, accuracy, insideGeofence, notes],
    )
    ctx.sendJson(201, { clockEvent: inserted.rows[0] })
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/clock/out') {
    const body = await ctx.readBody()
    const lat = parseOptionalNumber(body.lat)
    const lng = parseOptionalNumber(body.lng)
    const accuracy = parseOptionalNumber(body.accuracy_m)
    const notes = typeof body.notes === 'string' ? body.notes.slice(0, 1024) : null
    const currentUserId = ctx.currentUserId

    const workerLookup = await ctx.pool.query<{ id: string }>(
      `
      select w.id
      from workers w
      where w.company_id = $1 and w.deleted_at is null
      order by w.created_at asc
      limit 1
      `,
      [ctx.company.id],
    )
    const workerId = workerLookup.rows[0]?.id ?? null

    const openInLookup = await ctx.pool.query<{
      id: string
      project_id: string | null
      occurred_at: string
      event_type: string
    }>(
      `
      select id, project_id, occurred_at, event_type
      from clock_events
      where company_id = $1
        and (
          ($2::uuid is not null and worker_id = $2::uuid)
          or ($2::uuid is null and clerk_user_id = $3)
        )
      order by occurred_at desc
      limit 1
      `,
      [ctx.company.id, workerId, currentUserId],
    )
    const openIn = openInLookup.rows[0]
    if (!openIn || openIn.event_type !== 'in') {
      ctx.sendJson(409, { error: 'no open clock-in found for this worker' })
      return true
    }

    const projectId = openIn.project_id
    let insideGeofence: boolean | null = null
    if (projectId && lat !== null && lng !== null) {
      const projectRow = await ctx.pool.query<{
        site_lat: string | null
        site_lng: string | null
        site_radius_m: number | null
      }>('select site_lat, site_lng, site_radius_m from projects where company_id = $1 and id = $2', [
        ctx.company.id,
        projectId,
      ])
      const row = projectRow.rows[0]
      if (row) {
        const pLat = Number(row.site_lat)
        const pLng = Number(row.site_lng)
        const pRad = Number(row.site_radius_m ?? 0)
        if (Number.isFinite(pLat) && Number.isFinite(pLng) && pRad > 0) {
          insideGeofence = isInsideGeofence({
            lat: pLat,
            lng: pLng,
            radius_m: pRad,
            point: { lat, lng },
          })
        }
      }
    }

    const inserted = await ctx.pool.query<{
      id: string
      worker_id: string | null
      project_id: string | null
      occurred_at: string
    }>(
      `
      insert into clock_events (
        company_id, worker_id, project_id, clerk_user_id, event_type,
        lat, lng, accuracy_m, inside_geofence, notes
      )
      values ($1, $2, $3, $4, 'out', $5, $6, $7, $8, $9)
      returning id, company_id, worker_id, project_id, clerk_user_id,
                event_type, occurred_at, lat, lng, accuracy_m,
                inside_geofence, notes, created_at
      `,
      [ctx.company.id, workerId, projectId, currentUserId, lat, lng, accuracy, insideGeofence, notes],
    )
    const outRow = inserted.rows[0]!

    let laborEntry: Record<string, unknown> | null = null
    if (projectId && workerId) {
      const startMs = Date.parse(openIn.occurred_at)
      const endMs = Date.parse(outRow.occurred_at)
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        const rawHours = (endMs - startMs) / (1000 * 60 * 60)
        if (rawHours > 0 && rawHours < 24) {
          const hours = Math.round(rawHours * 100) / 100
          const occurredOn = new Date(startMs).toISOString().slice(0, 10)
          laborEntry = await withMutationTx(async (client: PoolClient) => {
            const laborInsert = await client.query(
              `
              insert into labor_entries (
                company_id, project_id, worker_id, service_item_code,
                hours, sqft_done, status, occurred_on
              )
              values ($1, $2, $3, '', $4, 0, 'draft', $5)
              returning id, project_id, worker_id, service_item_code, hours,
                        sqft_done, status, occurred_on, version, deleted_at, created_at
              `,
              [ctx.company.id, projectId, workerId, hours, occurredOn],
            )
            const row = laborInsert.rows[0] as Record<string, unknown>
            await recordMutationLedger(client, {
              companyId: ctx.company.id,
              entityType: 'labor_entry',
              entityId: String(row.id),
              action: 'create',
              row,
              syncPayload: { action: 'create', source: 'clock_out', laborEntry: row },
            })
            return row
          })
        }
      }
    }

    ctx.sendJson(201, { clockEvent: outRow, laborEntry })
    return true
  }

  if (req.method === 'GET' && url.pathname === '/api/clock/timeline') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const workerIdParam = String(url.searchParams.get('worker_id') ?? '').trim()
    const dateParam = String(url.searchParams.get('date') ?? '').trim()
    const result = await ctx.pool.query(
      `
      select id, company_id, worker_id, project_id, clerk_user_id,
             event_type, occurred_at, lat, lng, accuracy_m,
             inside_geofence, notes, created_at
      from clock_events
      where company_id = $1
        and ($2 = '' or worker_id = $2::uuid)
        and (
          $3 = ''
          or (occurred_at >= ($3::date) and occurred_at < ($3::date + interval '1 day'))
        )
      order by occurred_at asc
      limit 500
      `,
      [ctx.company.id, workerIdParam, dateParam],
    )
    ctx.sendJson(200, { events: result.rows })
    return true
  }

  return false
}
