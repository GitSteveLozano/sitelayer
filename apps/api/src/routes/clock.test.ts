import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest'
import type { Pool } from 'pg'
import type pino from 'pino'
import { attachMutationTx } from '../mutation-tx.js'
import { handleClockRoutes, type ClockRouteCtx } from './clock.js'
import type { BlueprintStorage } from '../storage.js'

/**
 * Clock-route tests.
 *
 * Two surfaces are covered:
 *  - the auto clock-OUT path (auto_out_idle / auto_out_geo), driven through
 *    a real http.Server so the JSON body parser round-trips, and
 *  - the manual clock-IN path with geofence resolution (explicit project,
 *    nearest-fence resolution, the auto_geofence no-match 409, and the
 *    auto_clock_in_disabled policy 409).
 *
 * Mirrors worker-issues.test.ts: a fake pg-shaped pool answers only the
 * queries the /in and /out handlers issue. We assert the recorded
 * clock_events.event_type and that source stays 'auto_geofence' (the
 * column's CHECK constraint forbids a new source value).
 */

const COMPANY_ID = 'co-1'
const WORKER_ID = '11111111-1111-4111-8111-111111111111'
const PROJECT_ID = '22222222-2222-4222-8222-222222222222'

type OpenInRow = {
  id: string
  project_id: string | null
  occurred_at: string
  event_type: string
}

type InsertedEvent = {
  source: string
  event_type: string
  worker_id: string | null
  project_id: string | null
}

type ProjectGeofenceRow = {
  id: string
  site_lat: string | null
  site_lng: string | null
  site_radius_m: number | null
  auto_clock_in_enabled: boolean
  auto_clock_correction_window_seconds: number
}

class FakePool {
  /** The most-recent event the open-in lookup returns; null = no open in. */
  openIn: OpenInRow | null = null
  /** Captured clock_events INSERTs. */
  inserted: InsertedEvent[] = []
  /** Captured labor_entries INSERTs. */
  laborEntries: unknown[][] = []
  /** Projects the /in geofence resolution can match. */
  projects: ProjectGeofenceRow[] = []
  /** Worker the self-path lookup returns; null = no rostered worker. */
  worker: { id: string } | null = { id: WORKER_ID }
  outbox: unknown[] = []
  syncEvents: unknown[] = []
  private idCounter = 0

  attach() {
    attachMutationTx({
      pool: this as unknown as Pool,
      logger: { warn: () => undefined } as unknown as pino.Logger,
    })
  }

  async query(sql: string, params: unknown[] = []) {
    return this.dispatch(sql, params)
  }

  async connect() {
    return {
      query: (sql: string, params: unknown[] = []) => this.dispatch(sql, params),
      release: () => undefined,
    }
  }

  private dispatch(sqlRaw: string, params: unknown[]) {
    const sql = sqlRaw.trim().toLowerCase()
    if (
      sql.startsWith('begin') ||
      sql.startsWith('commit') ||
      sql.startsWith('rollback') ||
      sql.startsWith('select set_config')
    ) {
      return { rows: [], rowCount: 0 }
    }

    // Self-path worker lookup.
    if (/^select\s+w\.id\s+from\s+workers/.test(sql)) {
      return { rows: this.worker ? [this.worker] : [], rowCount: this.worker ? 1 : 0 }
    }

    // /in explicit-project lookup (by id, includes auto_clock_in_enabled).
    if (
      /^select\s+id,\s+site_lat,\s+site_lng,\s+site_radius_m,\s*[\s\S]*auto_clock_in_enabled/.test(sql) &&
      /id = \$2/.test(sql)
    ) {
      const [, projectId] = params as [string, string]
      const row = this.projects.find((p) => p.id === projectId)
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }
    }

    // /in candidate-project lookup (all geofenced projects for the company).
    if (/^select\s+id,\s+site_lat,\s+site_lng,\s+site_radius_m,\s*[\s\S]*auto_clock_in_enabled/.test(sql)) {
      const rows = this.projects.filter(
        (p) => p.site_lat !== null && p.site_lng !== null && p.site_radius_m !== null && (p.site_radius_m ?? 0) > 0,
      )
      return { rows, rowCount: rows.length }
    }

    // Open-in lookup (the latest non-voided event for the worker).
    if (/^select\s+id,\s+project_id,\s+occurred_at,\s+event_type\s+from\s+clock_events/.test(sql)) {
      return { rows: this.openIn ? [this.openIn] : [], rowCount: this.openIn ? 1 : 0 }
    }

    // Project row read for inside_geofence + correction window (/out path).
    if (/^select\s+site_lat,\s+site_lng,\s+site_radius_m,\s+auto_clock_correction_window_seconds/.test(sql)) {
      return {
        rows: [{ site_lat: '34.0', site_lng: '-118.0', site_radius_m: 100, auto_clock_correction_window_seconds: 120 }],
        rowCount: 1,
      }
    }

    // clock_events INSERT — capture source + event_type. The columns are
    // (company,worker,project,user,event_type,occurred,lat,lng,acc,inside,
    //  notes,source,correctible). The /in path hardcodes event_type='in' in
    // the VALUES list (12 params); the /out path binds it as the LAST param
    // ($13) so auto_out_* flavours flow through.
    if (/^insert\s+into\s+clock_events/.test(sql)) {
      this.idCounter += 1
      const eventType = /values\s*\(\s*\$1,\s*\$2,\s*\$3,\s*\$4,\s*'in'/i.test(sql) ? 'in' : (params[12] as string)
      const row = {
        id: `evt-${this.idCounter}`,
        company_id: params[0] as string,
        worker_id: (params[1] ?? null) as string | null,
        project_id: (params[2] ?? null) as string | null,
        clerk_user_id: params[3] as string,
        event_type: eventType,
        occurred_at: params[4] as string,
        lat: params[5],
        lng: params[6],
        accuracy_m: params[7],
        inside_geofence: params[8],
        notes: params[9],
        source: params[10] as string,
        correctible_until: params[11],
        created_at: new Date().toISOString(),
      }
      this.inserted.push({
        source: row.source,
        event_type: row.event_type,
        worker_id: row.worker_id,
        project_id: row.project_id,
      })
      return { rows: [row], rowCount: 1 }
    }

    // labor_entries INSERT — capture for assertions.
    if (/^insert\s+into\s+labor_entries/.test(sql)) {
      this.laborEntries.push(params)
      return {
        rows: [
          {
            id: `labor-${this.laborEntries.length}`,
            project_id: params[1],
            worker_id: params[2],
            service_item_code: '',
            hours: params[3],
            sqft_done: 0,
            status: 'draft',
            occurred_on: params[4],
            version: 1,
            deleted_at: null,
            created_at: new Date().toISOString(),
          },
        ],
        rowCount: 1,
      }
    }

    if (/^insert\s+into\s+sync_events/.test(sql)) {
      this.syncEvents.push(params)
      return { rows: [], rowCount: 1 }
    }
    if (/^insert\s+into\s+mutation_outbox/.test(sql)) {
      this.outbox.push(params)
      return { rows: [], rowCount: 1 }
    }
    if (/^insert\s+into\s+audit_events/.test(sql)) {
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`unexpected SQL in fake pool: ${sqlRaw.slice(0, 200)}`)
  }
}

let pool: FakePool
let server: http.Server
let port: number

const stubStorage = {} as unknown as BlueprintStorage

beforeAll(async () => {
  pool = new FakePool()
  pool.attach()
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const ctx: ClockRouteCtx = {
      pool: pool as unknown as Pool,
      company: { id: COMPANY_ID, slug: 'co', name: 'Co', created_at: '', role: 'member' as const },
      currentUserId: 'u-1',
      requireRole: () => true,
      readBody: () =>
        new Promise<Record<string, unknown>>((resolve) => {
          const chunks: Buffer[] = []
          req.on('data', (c) => chunks.push(c as Buffer))
          req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if (!text) return resolve({})
            try {
              resolve(JSON.parse(text) as Record<string, unknown>)
            } catch {
              resolve({})
            }
          })
        }),
      sendJson: (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      },
      storage: stubStorage,
      maxPhotoBytes: 1024,
    }
    handleClockRoutes(req, url, ctx)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not handled' }))
        }
      })
      .catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: (err as Error).message ?? 'error' }))
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  pool.openIn = null
  pool.inserted = []
  pool.laborEntries = []
  pool.projects = []
  pool.worker = { id: WORKER_ID }
  pool.outbox = []
  pool.syncEvents = []
})

function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      },
      (res) => {
        const buf: Buffer[] = []
        res.on('data', (c) => buf.push(c as Buffer))
        res.on('end', () => {
          const text = Buffer.concat(buf).toString('utf8')
          let parsed: unknown = text
          try {
            parsed = JSON.parse(text)
          } catch {
            // leave as text
          }
          resolve({ status: res.statusCode ?? 0, body: parsed })
        })
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

/** Seed an open clock-IN one hour ago so /out pairs and emits a labor entry. */
function seedOpenIn(projectId: string | null = PROJECT_ID) {
  pool.openIn = {
    id: 'in-1',
    project_id: projectId,
    occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    event_type: 'in',
  }
}

describe('POST /api/clock/out — auto clock-out reasons', () => {
  it('records event_type=auto_out_idle when source=auto_geofence + auto_out_reason=idle', async () => {
    seedOpenIn()
    const res = await postJson('/api/clock/out', {
      lat: 34.0,
      lng: -118.0,
      source: 'auto_geofence',
      auto_out_reason: 'idle',
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const ev = (res.body as { clockEvent: { event_type: string; source: string } }).clockEvent
    expect(ev.event_type).toBe('auto_out_idle')
    // Source stays auto_geofence — the 029 CHECK constraint forbids a new value.
    expect(ev.source).toBe('auto_geofence')
    expect(pool.inserted).toHaveLength(1)
    expect(pool.inserted[0]!.event_type).toBe('auto_out_idle')
    expect(pool.inserted[0]!.source).toBe('auto_geofence')
  })

  it('records event_type=auto_out_geo when source=auto_geofence + auto_out_reason=geofence', async () => {
    seedOpenIn()
    const res = await postJson('/api/clock/out', {
      lat: 34.0,
      lng: -118.0,
      source: 'auto_geofence',
      auto_out_reason: 'geofence',
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const ev = (res.body as { clockEvent: { event_type: string; source: string } }).clockEvent
    expect(ev.event_type).toBe('auto_out_geo')
    expect(ev.source).toBe('auto_geofence')
  })

  it('still records a draft labor_entry on the auto-out path', async () => {
    seedOpenIn()
    const res = await postJson('/api/clock/out', {
      lat: 34.0,
      lng: -118.0,
      source: 'auto_geofence',
      auto_out_reason: 'idle',
    })
    expect(res.status).toBe(201)
    const body = res.body as { laborEntry: { hours: number; status: string } | null }
    expect(body.laborEntry).not.toBeNull()
    expect(body.laborEntry!.status).toBe('draft')
    // ~1h elapsed.
    expect(body.laborEntry!.hours).toBeCloseTo(1, 1)
    expect(pool.laborEntries).toHaveLength(1)
  })

  it('records plain event_type=out for a manual clock-out (no reason)', async () => {
    seedOpenIn()
    const res = await postJson('/api/clock/out', { lat: 34.0, lng: -118.0 })
    expect(res.status).toBe(201)
    expect(pool.inserted[0]!.event_type).toBe('out')
    expect(pool.inserted[0]!.source).toBe('manual')
  })

  it('ignores auto_out_reason on a manual source — stays event_type=out', async () => {
    seedOpenIn()
    const res = await postJson('/api/clock/out', {
      lat: 34.0,
      lng: -118.0,
      source: 'manual',
      auto_out_reason: 'idle',
    })
    expect(res.status).toBe(201)
    // Only auto_geofence sources get the auto-out flavour.
    expect(pool.inserted[0]!.event_type).toBe('out')
  })

  it('ignores an unknown auto_out_reason — stays event_type=out', async () => {
    seedOpenIn()
    const res = await postJson('/api/clock/out', {
      lat: 34.0,
      lng: -118.0,
      source: 'auto_geofence',
      auto_out_reason: 'bogus',
    })
    expect(res.status).toBe(201)
    expect(pool.inserted[0]!.event_type).toBe('out')
  })

  it('returns 409 when there is no open clock-in to pair with', async () => {
    pool.openIn = null
    const res = await postJson('/api/clock/out', {
      lat: 34.0,
      lng: -118.0,
      source: 'auto_geofence',
      auto_out_reason: 'idle',
    })
    expect(res.status).toBe(409)
    expect(pool.inserted).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Manual clock-IN + geofence resolution.
// ---------------------------------------------------------------------------

function seedProject(overrides: Partial<ProjectGeofenceRow> = {}) {
  pool.projects.push({
    id: PROJECT_ID,
    site_lat: '34.0',
    site_lng: '-118.0',
    site_radius_m: 200,
    auto_clock_in_enabled: true,
    auto_clock_correction_window_seconds: 120,
    ...overrides,
  })
}

describe('POST /api/clock/in — manual + geofence', () => {
  it('returns 400 when lat/lng are missing', async () => {
    const res = await postJson('/api/clock/in', { source: 'manual' })
    expect(res.status).toBe(400)
    expect(pool.inserted).toHaveLength(0)
  })

  it('manual clock-in with an explicit project_id records source=manual, inside_geofence=true', async () => {
    seedProject()
    const res = await postJson('/api/clock/in', {
      lat: 34.0,
      lng: -118.0,
      project_id: PROJECT_ID,
      source: 'manual',
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const ev = (
      res.body as { clockEvent: { event_type: string; source: string; inside_geofence: boolean; project_id: string } }
    ).clockEvent
    expect(ev.event_type).toBe('in')
    expect(ev.source).toBe('manual')
    expect(ev.project_id).toBe(PROJECT_ID)
    expect(ev.inside_geofence).toBe(true)
    expect(pool.inserted[0]!.event_type).toBe('in')
    expect(pool.inserted[0]!.source).toBe('manual')
  })

  it('returns 404 when the explicit project_id is not in the company', async () => {
    // No projects seeded → explicit lookup misses.
    const res = await postJson('/api/clock/in', {
      lat: 34.0,
      lng: -118.0,
      project_id: PROJECT_ID,
      source: 'manual',
    })
    expect(res.status).toBe(404)
    expect(pool.inserted).toHaveLength(0)
  })

  it('returns 400 when the explicit project_id is not a valid uuid', async () => {
    const res = await postJson('/api/clock/in', {
      lat: 34.0,
      lng: -118.0,
      project_id: 'not-a-uuid',
      source: 'manual',
    })
    expect(res.status).toBe(400)
  })

  it('resolves the nearest geofence when no project_id is supplied', async () => {
    seedProject()
    const res = await postJson('/api/clock/in', { lat: 34.0, lng: -118.0, source: 'manual' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const ev = (res.body as { clockEvent: { project_id: string; inside_geofence: boolean } }).clockEvent
    expect(ev.project_id).toBe(PROJECT_ID)
    expect(ev.inside_geofence).toBe(true)
  })

  it('manual clock-in outside any geofence still records with project_id=null', async () => {
    // Project geofence is far from the supplied point.
    seedProject({ site_lat: '40.0', site_lng: '-74.0' })
    const res = await postJson('/api/clock/in', { lat: 34.0, lng: -118.0, source: 'manual' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const ev = (res.body as { clockEvent: { project_id: string | null; inside_geofence: boolean } }).clockEvent
    expect(ev.project_id).toBeNull()
    expect(ev.inside_geofence).toBe(false)
  })

  it('rejects an auto_geofence clock-in with 409 when no geofence matches', async () => {
    seedProject({ site_lat: '40.0', site_lng: '-74.0' })
    const res = await postJson('/api/clock/in', { lat: 34.0, lng: -118.0, source: 'auto_geofence' })
    expect(res.status).toBe(409)
    expect((res.body as { error: string }).error).toBe('no_geofence_match')
    expect(pool.inserted).toHaveLength(0)
  })

  it('rejects an auto_geofence clock-in with 409 when the project has auto-clock disabled', async () => {
    seedProject({ auto_clock_in_enabled: false })
    const res = await postJson('/api/clock/in', {
      lat: 34.0,
      lng: -118.0,
      project_id: PROJECT_ID,
      source: 'auto_geofence',
    })
    expect(res.status).toBe(409)
    expect((res.body as { error: string }).error).toBe('auto_clock_in_disabled')
    expect(pool.inserted).toHaveLength(0)
  })
})
