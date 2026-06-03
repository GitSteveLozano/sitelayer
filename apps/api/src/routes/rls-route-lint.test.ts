import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * RLS route lint — the WHOLE-DIRECTORY ratchet over apps/api/src/routes/*.ts.
 *
 * Why this exists (and why the per-route `rls-phase3-audit.test.ts` is not
 * enough): that audit inspects exactly 20 hand-picked high-impact routes. The
 * route directory has ~95 handler files and grows every release. The
 * `company_isolation` RLS policy keeps the permissive
 * `app_current_company_id() IS NULL OR company_id = ...` branch (so legacy/debug
 * tooling keeps working), which means **a bare `pool.query` whose GUC is unbound
 * AND that lacks an explicit `company_id` predicate sees ALL tenants** — FORCE
 * RLS does NOT save you (the IS-NULL escape). The real control is one of:
 *   (a) route the query through `withCompanyClient` / `withMutationTx`
 *       (they `SET LOCAL app.company_id` so the GUC is bound), OR
 *   (b) carry an explicit `where company_id = $1` predicate in the SQL.
 * See docs/SECURITY_RLS.md and docs/MULTI_TENANCY.md RULE 1.
 *
 * Without this lint the cross-tenant blast radius can grow silently the instant
 * someone adds a 96th route file that issues a raw `pool.query` against a
 * company table with neither (a) nor (b) — the 20-route audit would never look
 * at it.
 *
 * This lint closes the gap with hard gates:
 *
 *   1. **Bare-unscoped-query scan (HARD).** Every non-test `routes/*.ts` is
 *      read; any raw `pool.query(` / `ctx.pool.query(` (including typed
 *      `pool.query<T>(`) whose statement binds NEITHER the GUC (file imports a
 *      GUC helper used around it) NOR an explicit `company_id` predicate FAILS,
 *      unless the file is on `RAW_QUERY_REVIEWED` with a documented reason
 *      (registry / platform-admin / append-only-debug / global-table surface).
 *      This is the true cross-tenant leak class.
 *
 *   2. **New-file ratchet (HARD).** Every route file that issues a raw query
 *      must be accounted for: either every raw query is `company_id`-predicated
 *      (RULE 1), or the file is on `RAW_QUERY_REVIEWED`. A brand-new handler
 *      that drops in a raw, unscoped query cannot grow exposure silently.
 *
 * Pure static analysis (no Postgres), so it runs in the unit stage.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROUTES_DIR = resolve(__dirname)

/**
 * Route files whose raw `pool.query(` calls are reviewed and NOT a cross-tenant
 * leak even where they don't bind `app.company_id`, each with the reason. Keep
 * this list TIGHT — it is the ratchet. Legitimate entries are ONLY:
 *   - the tenant-registry surface (companies / memberships / invites resolved
 *     BEFORE a GUC can exist; companies has no company_id column at all),
 *   - the platform-admin cross-tenant surface (gated by authorizePlatformAdmin),
 *   - documented append-only / debug reads,
 *   - global (non-company) tables keyed by a globally-unique id.
 * A regular per-company entity route must NEVER appear here for an UNSCOPED
 * query — wire it through withCompanyClient / withMutationTx, or add an explicit
 * `where company_id = $1` predicate.
 */
const RAW_QUERY_REVIEWED: Readonly<Record<string, string>> = {
  // Platform-admin cross-tenant API (/api/admin/*) — gated by
  // authorizePlatformAdmin before any query; reads companies/memberships/
  // impersonation_sessions across tenants BY DESIGN.
  'admin.ts': 'platform-admin cross-tenant surface (authorizePlatformAdmin)',

  // Read-only platform-admin job-fleet + queue-health (/api/admin/jobs) — gated
  // by authorizePlatformAdmin before any query. Reads the GLOBAL public.job_runs
  // table (no company_id column, like dispatch_lanes) and INTENTIONALLY
  // cross-tenant mutation_outbox/sync_events status summaries (platform-admin
  // fleet view, aggregated across all companies BY DESIGN).
  'admin-jobs.ts':
    'platform-admin cross-tenant surface (authorizePlatformAdmin): global job_runs + cross-tenant queue summaries',

  // Tenant ROOT registry. companies has no company_id column; the
  // company_memberships lookup IS the pre-GUC resolution path (you cannot bind
  // app.company_id until you have resolved which company the request is for).
  'companies.ts': 'tenant-registry: companies has no company_id; membership lookup is the pre-GUC resolution path',

  // Custom-role CRUD on the membership/registry surface (resolved via
  // membership lookup before app.company_id exists).
  'company-roles.ts': 'custom-role CRUD on the membership/registry surface (pre-GUC)',

  // company_invites lifecycle on the registry surface; invite tokens resolve
  // before app.company_id exists.
  'invites.ts': 'invite-token lifecycle on the registry surface (pre-GUC)',

  // Clerk webhook mirror writes to `clerk_users` — a GLOBAL table keyed by the
  // globally-unique Clerk user id, with NO company_id column. Not a tenant
  // table; cross-tenant isolation does not apply.
  'public.ts': 'clerk_users is a global table keyed by the globally-unique Clerk id (no company_id)',

  // `dispatch_lanes` is the INTENTIONALLY global fleet-wide kill-switch table
  // (migration 094 — no company_id column; documented benign in MULTI_TENANCY.md).
  // The other portal/portal-capture reads here carry explicit company_id.
  'dispatch-lanes.ts': 'dispatch_lanes is a global fleet kill-switch table (migration 094, no company_id)',

  // Public PORTAL surface. `loadPortalCompany` reads the `companies` registry
  // row by id (the pre-GUC company-resolution path on the unauthenticated
  // portal); every capture_sessions read carries an explicit `company_id = $`.
  'portal-capture-sessions.ts':
    'portal company-resolution reads companies (no company_id); session reads carry explicit company_id',

  // Debug-trace reads target the ENABLE-not-FORCE append-only audit/queue tables
  // (mutation_outbox, sync_events) on the documented cross-company admin surface
  // (migration 078 pg_dump owner exemption); the audit/work-request reads carry
  // an explicit `where company_id = $1`. Bootstrap reads go through
  // withCompanyClient. Mirrors rawQueryExemptReason in rls-phase3-audit.test.ts.
  'system.ts':
    'debug-trace reads target ENABLE-not-FORCE append-only audit tables (migration 078); other reads carry explicit company_id',
}

/**
 * Infrastructure for the route cascade, not per-feature handlers. Still scanned
 * for bare queries, but they don't need a reviewed-handler classification.
 */
const NON_HANDLER_FILES = new Set([
  'dispatch.ts', // route cascade wiring; destructures `pool` but never queries it
  'rls-force-audit.ts', // catalog-only pg_class audit (no tenant rows)
])

/** True for a `routes/*.ts` handler module (excludes `*.test.ts` siblings). */
function isRouteModule(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')
}

type RawQueryCall = {
  line: number
  /** True iff the SQL statement following this call carries a company_id predicate. */
  companyIdScoped: boolean
}

type RouteLintFinding = {
  file: string
  importsGucHelper: boolean
  /** Every raw `pool.query(` / `pool.query<T>(` / `ctx.pool.query(` call. */
  rawQueries: RawQueryCall[]
  /** Raw queries that bind NEITHER the GUC nor an explicit company_id predicate. */
  unscopedRawLines: number[]
  reviewedReason: string | null
}

// Matches `pool.query(`, `pool.query<Foo>(`, `ctx.pool.query(`, with optional
// generic type args between `query` and `(`.
const RAW_QUERY_RE = /\b(?:ctx\.)?pool\.query\s*(?:<[^>]*>)?\s*\(/

/**
 * Heuristic: does the SQL statement that starts at `pool.query(` (line index
 * `start`) carry a `company_id` predicate (an explicit app-layer scope per
 * MULTI_TENANCY RULE 1)? We scan forward until the call's argument list looks
 * closed (a line ending in `)` after the opening, capped to a window) and look
 * for a `company_id` token in the SQL — `where company_id = $1`,
 * `x.company_id = $1`, `and company_id = ...`, etc.
 */
function statementIsCompanyIdScoped(lines: string[], start: number): boolean {
  const WINDOW = 40
  let buf = ''
  for (let i = start; i < Math.min(lines.length, start + WINDOW); i++) {
    const line = lines[i] ?? ''
    buf += line + '\n'
    // Stop once the statement is plausibly closed: a `)` that ends a call. We
    // keep it simple — once we've seen the closing `)` of the params array.
    if (i > start && /\)\s*$/.test(line.trim()) && /company_id/i.test(buf)) break
    if (i > start && /^\s*\)/.test(line) && i - start > 2) break
  }
  return /company_id/i.test(buf)
}

function classifyRouteModule(file: string): RouteLintFinding {
  const source = readFileSync(resolve(ROUTES_DIR, file), 'utf8')
  const lines = source.split('\n')

  const importsGucHelper =
    /from\s+['"]\.\.\/mutation-tx\.js['"]/.test(source) && /(withCompanyClient|withMutationTx)/.test(source)

  const reviewedReason = Object.prototype.hasOwnProperty.call(RAW_QUERY_REVIEWED, file)
    ? RAW_QUERY_REVIEWED[file]!
    : null

  const rawQueries: RawQueryCall[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!RAW_QUERY_RE.test(line)) continue
    // Comments don't count.
    if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) continue
    rawQueries.push({ line: i + 1, companyIdScoped: statementIsCompanyIdScoped(lines, i) })
  }

  // A raw query is an UNSCOPED leak risk when it carries no company_id predicate
  // (the GUC is also not bound for a raw pool.query — that's the whole point).
  // Files on RAW_QUERY_REVIEWED are exempt (registry/admin/global/append-only).
  const unscopedRawLines = reviewedReason ? [] : rawQueries.filter((q) => !q.companyIdScoped).map((q) => q.line)

  return { file, importsGucHelper, rawQueries, unscopedRawLines, reviewedReason }
}

const routeFiles = readdirSync(ROUTES_DIR).filter(isRouteModule).sort()
const findings = routeFiles.map(classifyRouteModule)

describe('RLS route lint — whole-directory ratchet', () => {
  it('scanned every route handler module', () => {
    // The directory has ~95 handlers; a count that collapses to a handful means
    // the glob broke and the lint is silently passing.
    expect(routeFiles.length).toBeGreaterThan(80)
  })

  // GATE 1 — bare-unscoped-query scan (HARD). A raw pool.query with neither the
  // GUC bound nor an explicit company_id predicate sees ALL tenants (the IS-NULL
  // escape in the company_isolation policy). That is the true cross-tenant leak.
  it('no route issues a raw pool.query that binds neither the GUC nor a company_id predicate', () => {
    const offenders = findings.filter((f) => f.unscopedRawLines.length > 0)
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : 'Route file(s) issue a raw pool.query with NO app.company_id GUC and NO explicit company_id predicate\n' +
            '(this sees ALL tenants — the IS-NULL escape in the company_isolation policy; FORCE RLS does NOT help):\n' +
            offenders
              .map(
                (f) =>
                  `  - apps/api/src/routes/${f.file} (unscoped raw query at line(s) ${f.unscopedRawLines.join(', ')})`,
              )
              .join('\n') +
            '\n\nFix one of:\n' +
            '  (a) route it through withCompanyClient(companyId, (c) => c.query(...)) /\n' +
            '      withMutationTx(companyId, async (client) => ...) so SET LOCAL app.company_id binds the GUC, OR\n' +
            '  (b) add an explicit `where company_id = $1` predicate (MULTI_TENANCY RULE 1; FORCE RLS is the backstop).\n' +
            'Only add to RAW_QUERY_REVIEWED if the file is the tenant-registry / platform-admin / documented\n' +
            'append-only / global-table surface, with a reason.',
    ).toEqual([])
  })

  // GATE 2 — new-file ratchet (HARD). Every route file that issues raw queries
  // must be accounted for: either ALL its raw queries are company_id-predicated,
  // OR the file is on RAW_QUERY_REVIEWED. (GATE 1 already fails on unscoped
  // queries; this asserts the accounting explicitly so a NEW file with a raw,
  // unscoped query can't slip in unreviewed.)
  it('every route file with raw queries is accounted for (predicate-scoped or reviewed)', () => {
    const unaccounted = findings.filter(
      (f) => f.rawQueries.length > 0 && f.unscopedRawLines.length > 0 && !f.reviewedReason,
    )
    expect(
      unaccounted,
      unaccounted.length === 0
        ? ''
        : 'New/unreviewed route file(s) with raw, unscoped queries — predicate-scope them or add to RAW_QUERY_REVIEWED:\n' +
            unaccounted.map((f) => `  - apps/api/src/routes/${f.file}`).join('\n'),
    ).toEqual([])
  })

  // Sanity: the reviewed allowlist must not rot — every entry must still exist
  // AND still issue a raw query, else delete it so the gate keeps protecting it.
  it('RAW_QUERY_REVIEWED has no stale entries', () => {
    const stale: string[] = []
    for (const file of Object.keys(RAW_QUERY_REVIEWED)) {
      const finding = findings.find((f) => f.file === file)
      if (!finding) {
        stale.push(`${file} (no longer present in routes/)`)
        continue
      }
      if (finding.rawQueries.length === 0) {
        stale.push(`${file} (no longer issues a raw pool.query — remove the exemption)`)
      }
    }
    expect(stale, stale.length === 0 ? '' : `Stale RAW_QUERY_REVIEWED entries:\n  ${stale.join('\n  ')}`).toEqual([])
  })

  // NON_HANDLER_FILES must not silently start querying tenant tables.
  it('infrastructure files do not issue unscoped raw queries', () => {
    const infraOffenders = findings.filter((f) => NON_HANDLER_FILES.has(f.file) && f.unscopedRawLines.length > 0)
    expect(infraOffenders.map((f) => f.file)).toEqual([])
  })
})
