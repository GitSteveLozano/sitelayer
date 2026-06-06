import type { IncomingMessage } from 'node:http'
import type { Identity } from '../auth.js'
import { authorizePlatformAdmin, parseSuperadminEnvIds, type AdminQueryExecutor } from '../admin-auth.js'

/**
 * Read-only platform-admin job-fleet + queue-health endpoint (powers the
 * read-only /admin/jobs page).
 *
 * GET /api/admin/jobs returns:
 *  - `job_runs`: the worker periodic-job fleet run-ledger from the GLOBAL
 *    `public.job_runs` table (company-agnostic, like dispatch_lanes), ordered
 *    by `last_finished_at DESC NULLS LAST`. Read with a PLAIN client (no
 *    `app.company_id` GUC) — the table has no RLS.
 *  - `queues`: a CROSS-TENANT (platform-admin) status summary of the two
 *    leased queue tables (`mutation_outbox`, `sync_events`), aggregated across
 *    ALL companies. The cross-tenant view is intentional: with no
 *    `app.company_id` set, `app_current_company_id()` is NULL and the
 *    `company_isolation` RLS policy permits every row (same plain-pool pattern
 *    `system.ts`'s trace-join uses).
 *
 * Gated IDENTICALLY to every other `/api/admin/*` route via
 * `authorizePlatformAdmin` (verified Clerk session whose `sub` is a
 * superadmin). Read-only: only GET is served; any other method on this exact
 * path returns 405. Because `handleAdminRoutes` claims the whole `/api/admin/*`
 * namespace and 404s unknown subpaths, this handler MUST be wired BEFORE it in
 * the dispatch cascade so `/api/admin/jobs` reaches here first.
 */

export interface AdminJobsRouteDeps {
  /** The request pool — the real `pg.Pool` satisfies this structurally. */
  pool: AdminQueryExecutor
  identity: Identity
  sendJson: (status: number, body: unknown) => void
  /** Defaults to parsing PLATFORM_SUPERADMIN_CLERK_IDS from the environment. */
  envIds?: ReadonlySet<string>
}

interface JobRunRow {
  job_name: string
  scope: string
  last_started_at: string | null
  last_finished_at: string | null
  last_status: string
  last_error: string
  last_duration_ms: number | null
  run_count: string | number
  success_count: string | number
  failure_count: string | number
  skipped_count: string | number
  next_eligible_at: string | null
  updated_at: string
}

interface QueueStatusRow {
  status: string
  n: string | number
}

interface QueueOldestRow {
  oldest_pending_age_seconds: string | number | null
}

interface QueueSummary {
  pending: number
  processing: number
  failed: number
  applied: number
  other: number
  total: number
  oldest_pending_age_seconds: number | null
}

const KNOWN_QUEUE_STATUSES = new Set(['pending', 'processing', 'failed', 'applied'])

function toInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * One grouped query per table (GROUP BY status) + a min(created_at) over
 * pending rows. Both are CROSS-TENANT — the plain client never sets
 * `app.company_id`, so RLS permits every company's rows.
 */
async function summarizeQueue(
  pool: AdminQueryExecutor,
  table: 'mutation_outbox' | 'sync_events',
): Promise<QueueSummary> {
  // `table` is a fixed literal from this module, never user input — safe to interpolate.
  const grouped = (await pool.query(`select status, count(*)::int as n from ${table} group by status`)) as {
    rows?: QueueStatusRow[]
  }
  const oldest = (await pool.query(
    `select extract(epoch from now() - min(created_at)) as oldest_pending_age_seconds
       from ${table}
      where status = 'pending'`,
  )) as { rows?: QueueOldestRow[] }

  const summary: QueueSummary = {
    pending: 0,
    processing: 0,
    failed: 0,
    applied: 0,
    other: 0,
    total: 0,
    oldest_pending_age_seconds: null,
  }

  for (const row of grouped.rows ?? []) {
    const n = toInt(row.n)
    summary.total += n
    if (KNOWN_QUEUE_STATUSES.has(row.status)) {
      summary[row.status as 'pending' | 'processing' | 'failed' | 'applied'] += n
    } else {
      summary.other += n
    }
  }

  const rawAge = oldest.rows?.[0]?.oldest_pending_age_seconds
  if (rawAge !== null && rawAge !== undefined) {
    const age = typeof rawAge === 'number' ? rawAge : Number.parseFloat(String(rawAge))
    summary.oldest_pending_age_seconds = Number.isFinite(age) ? age : null
  }

  return summary
}

/**
 * Returns true once it has handled (or rejected) the `/api/admin/jobs`
 * request; false to let the rest of the route cascade run.
 */
export async function handleAdminJobsRoutes(
  req: IncomingMessage,
  url: URL,
  deps: AdminJobsRouteDeps,
): Promise<boolean> {
  if (url.pathname !== '/api/admin/jobs') return false

  const { pool, identity, sendJson } = deps
  const envIds = deps.envIds ?? parseSuperadminEnvIds(process.env.PLATFORM_SUPERADMIN_CLERK_IDS)

  const gate = await authorizePlatformAdmin(pool, identity, envIds)
  if (!gate.ok) {
    sendJson(gate.status, { error: gate.message })
    return true
  }

  const method = (req.method ?? 'GET').toUpperCase()
  if (method !== 'GET') {
    sendJson(405, { error: 'method not allowed' })
    return true
  }

  // GLOBAL run-ledger — plain client, no app.company_id (no RLS on this table).
  const jobRunsResult = (await pool.query(
    `select job_name, scope, last_started_at, last_finished_at, last_status, last_error,
            last_duration_ms, run_count, success_count, failure_count, skipped_count,
            next_eligible_at, updated_at
       from job_runs
      order by last_finished_at desc nulls last`,
  )) as { rows?: JobRunRow[] }

  const jobRuns = (jobRunsResult.rows ?? []).map((r) => ({
    job_name: r.job_name,
    scope: r.scope,
    last_started_at: r.last_started_at,
    last_finished_at: r.last_finished_at,
    last_status: r.last_status,
    last_error: r.last_error,
    last_duration_ms: r.last_duration_ms,
    run_count: toInt(r.run_count),
    success_count: toInt(r.success_count),
    failure_count: toInt(r.failure_count),
    skipped_count: toInt(r.skipped_count),
    next_eligible_at: r.next_eligible_at,
    updated_at: r.updated_at,
  }))

  const [mutationOutbox, syncEvents] = await Promise.all([
    summarizeQueue(pool, 'mutation_outbox'),
    summarizeQueue(pool, 'sync_events'),
  ])

  sendJson(200, {
    generated_at: new Date().toISOString(),
    job_runs: jobRuns,
    queues: {
      mutation_outbox: mutationOutbox,
      sync_events: syncEvents,
    },
  })
  return true
}
