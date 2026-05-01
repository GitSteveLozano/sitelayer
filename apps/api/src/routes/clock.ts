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

/** Sources of a clock event — see migration 029_geofence_policy.sql. */
const ALLOWED_CLOCK_SOURCES = ['manual', 'auto_geofence', 'foreman_override'] as const
type ClockSource = (typeof ALLOWED_CLOCK_SOURCES)[number]

function parseClockSource(value: unknown): ClockSource {
  if (typeof value === 'string' && (ALLOWED_CLOCK_SOURCES as readonly string[]).includes(value)) {
    return value as ClockSource
  }
  return 'manual'
}

/**
 * Compute correctible_until for a non-manual clock event. Returns null
 * for manual events (no separate window — the user just submitted them)
 * and for projects without a configured correction window.
 */
function computeCorrectibleUntil(
  source: ClockSource,
  occurredAtIso: string,
  correctionWindowSeconds: number | null,
): string | null {
  if (source === 'manual') return null
  if (correctionWindowSeconds === null || correctionWindowSeconds <= 0) return null
  const occurredMs = Date.parse(occurredAtIso)
  if (!Number.isFinite(occurredMs)) return null
  return new Date(occurredMs + correctionWindowSeconds * 1000).toISOString()
}

/**
 * Handle clock event routes:
 * - POST /api/clock/in        — passive clock-in; resolves project via
 *                                explicit body.project_id or geofence
 *                                containment, falls back to no project
 *                                with inside_geofence=false. Accepts
 *                                body.source (manual|auto_geofence|
 *                                foreman_override). For auto_geofence
 *                                rejects with 409 when the resolved
 *                                project's auto_clock_in_enabled=false.
 *                                Computes correctible_until from the
 *                                project's auto_clock_correction_window
 *                                _seconds for non-manual sources.
 * - POST /api/clock/out       — pairs with the latest open clock-in;
 *                                emits a draft labor_entry when the
 *                                duration is positive and < 24h.
 *                                Same source / correctible_until
 *                                semantics as /in.
 * - GET  /api/clock/timeline  — admin/foreman/office; filterable by
 *                                worker_id and date
 *
 * Phase 1D will land POST /api/clock/events/:id/void to consume the
 * correctible_until column. Migration 030 (deferred) adds the soft-
 * delete columns; the void endpoint then becomes a one-route addition.
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
    const source = parseClockSource(body.source)
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
    let correctionWindowSeconds: number | null = null
    let autoClockEnabled = true
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
        auto_clock_in_enabled: boolean
        auto_clock_correction_window_seconds: number
      }>(
        `
        select id, site_lat, site_lng, site_radius_m,
               auto_clock_in_enabled, auto_clock_correction_window_seconds
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
      const row = explicitProject.rows[0]
      projectId = row.id
      autoClockEnabled = row.auto_clock_in_enabled
      correctionWindowSeconds = row.auto_clock_correction_window_seconds
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
    } else {
      const candidateProjects = await ctx.pool.query<{
        id: string
        site_lat: string | null
        site_lng: string | null
        site_radius_m: number | null
        auto_clock_in_enabled: boolean
        auto_clock_correction_window_seconds: number
      }>(
        `
        select id, site_lat, site_lng, site_radius_m,
               auto_clock_in_enabled, auto_clock_correction_window_seconds
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
          autoClockEnabled = row.auto_clock_in_enabled
          correctionWindowSeconds = row.auto_clock_correction_window_seconds
        }
      }
    }

    // Auto-geofence semantics: the PWA only fires source='auto_geofence'
    // when the device crossed a geofence the server configured. If we
    // can't reproduce that match server-side (no project resolved from
    // the lat/lng), the event is suspect — could be stale client
    // policies, GPS drift outside any geofence, or a forged request.
    // Reject rather than write an orphan auto-event with project_id=null.
    if (source === 'auto_geofence' && projectId === null) {
      ctx.sendJson(409, {
        error: 'no_geofence_match',
        message: 'no project geofence matched the supplied location — refusing auto clock-in',
      })
      return true
    }
    // Honour the per-project policy: if this event was triggered by the
    // PWA crossing the geofence (source='auto_geofence') and the project
    // is configured to run as reminder-only, refuse the auto-event so the
    // worker app falls back to its reminder UI.
    if (source === 'auto_geofence' && projectId !== null && !autoClockEnabled) {
      ctx.sendJson(409, {
        error: 'auto_clock_in_disabled',
        project_id: projectId,
        message: 'project is configured for geofence reminder only — clock in manually',
      })
      return true
    }

    const occurredAt = new Date().toISOString()
    const correctibleUntil = computeCorrectibleUntil(source, occurredAt, correctionWindowSeconds)

    const inserted = await ctx.pool.query(
      `
      insert into clock_events (
        company_id, worker_id, project_id, clerk_user_id, event_type,
        occurred_at, lat, lng, accuracy_m, inside_geofence, notes,
        source, correctible_until
      )
      values ($1, $2, $3, $4, 'in', $5, $6, $7, $8, $9, $10, $11, $12)
      returning id, company_id, worker_id, project_id, clerk_user_id,
                event_type, occurred_at, lat, lng, accuracy_m,
                inside_geofence, notes, source, correctible_until, created_at
      `,
      [
        ctx.company.id,
        workerId,
        projectId,
        currentUserId,
        occurredAt,
        lat,
        lng,
        accuracy,
        insideGeofence,
        notes,
        source,
        correctibleUntil,
      ],
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
    const source = parseClockSource(body.source)
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
    let correctionWindowSeconds: number | null = null
    if (projectId) {
      const projectRow = await ctx.pool.query<{
        site_lat: string | null
        site_lng: string | null
        site_radius_m: number | null
        auto_clock_correction_window_seconds: number
      }>(
        `select site_lat, site_lng, site_radius_m, auto_clock_correction_window_seconds
         from projects where company_id = $1 and id = $2`,
        [ctx.company.id, projectId],
      )
      const row = projectRow.rows[0]
      if (row) {
        correctionWindowSeconds = row.auto_clock_correction_window_seconds
        if (lat !== null && lng !== null) {
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
    }

    const occurredAt = new Date().toISOString()
    const correctibleUntil = computeCorrectibleUntil(source, occurredAt, correctionWindowSeconds)

    const inserted = await ctx.pool.query<{
      id: string
      worker_id: string | null
      project_id: string | null
      occurred_at: string
    }>(
      `
      insert into clock_events (
        company_id, worker_id, project_id, clerk_user_id, event_type,
        occurred_at, lat, lng, accuracy_m, inside_geofence, notes,
        source, correctible_until
      )
      values ($1, $2, $3, $4, 'out', $5, $6, $7, $8, $9, $10, $11, $12)
      returning id, company_id, worker_id, project_id, clerk_user_id,
                event_type, occurred_at, lat, lng, accuracy_m,
                inside_geofence, notes, source, correctible_until, created_at
      `,
      [
        ctx.company.id,
        workerId,
        projectId,
        currentUserId,
        occurredAt,
        lat,
        lng,
        accuracy,
        insideGeofence,
        notes,
        source,
        correctibleUntil,
      ],
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
