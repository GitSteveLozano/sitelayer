import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { auditUnforcedCompanyTables, type RlsForceFinding } from './rls-force-audit.js'

/**
 * RLS Phase 3 audit — now a BLOCKING GATE.
 *
 * Phase 1 (migration 066) shipped RLS policies on every domain table; Phase 3
 * (migrations 085/101 + per-table follow-ups) ENABLED + FORCED RLS across the
 * company-scoped surface. This audit guards that posture so it can't silently
 * regress, and `scripts/verify-local.sh`'s integration stage sets
 * `RLS_PHASE3_FAIL_ON_LEAK=1` so a regression FAILS the deploy gate.
 *
 * This file does three things:
 *
 *  1. **Static route audit (always runs; hard gate under RLS_PHASE3_FAIL_ON_LEAK).**
 *     For every audited route, read the handler source and assert it reads/writes
 *     through `withCompanyClient(...)` / `withMutationTx(...)` (which set the
 *     `app.company_id` GUC inside a tx) and does not issue a raw `pool.query(`
 *     outside such a closure. A raw `pool.query` leaks rows across companies the
 *     instant FORCE RLS is on (the pool's role would need the GUC bound).
 *     Documented cross-company admin reads (`rawQueryExemptReason`) are exempt.
 *
 *  2. **Forced-coverage audit (live schema; hard gate under RLS_PHASE3_FAIL_ON_LEAK).**
 *     Queries the post-migration Postgres for every `company_id` table lacking
 *     FORCE ROW LEVEL SECURITY and flags any that aren't on the documented
 *     allowlist. This is the "next asset_deployments gap" catcher — migration
 *     118 shipped `asset_deployments` unforced and it slipped through; this gate
 *     makes that class fail at verify time. See ./rls-force-audit.ts.
 *
 *  3. **Runtime probe (gated by `CONSTRAINED_DB_URL`).** Connects to Postgres as
 *     a non-BYPASSRLS role, enables + forces RLS on the `projects` table, seeds
 *     one row per company, and verifies the policy actually scopes reads to the
 *     GUC value. Proves the mechanism the audits assume is real. Skips cleanly
 *     when the env var is unset.
 *
 * ## Running the audit locally
 *
 * The static audit runs unconditionally:
 *
 *   cd apps/api && npx vitest run src/routes/rls-phase3-audit.test.ts
 *
 * To run the runtime probe, first provision a constrained role:
 *
 *   psql "$DATABASE_URL" -c "create role app_role nobypassrls login password 'app_role'"
 *   psql "$DATABASE_URL" -c "grant select, insert, update, delete on all tables in schema public to app_role"
 *   psql "$DATABASE_URL" -c "grant usage on all sequences in schema public to app_role"
 *
 * then re-run with the constrained URL:
 *
 *   CONSTRAINED_DB_URL=postgres://app_role:app_role@localhost:5432/sitelayer \
 *     npx vitest run src/routes/rls-phase3-audit.test.ts
 *
 * The DB pointed at must be writable (the test seeds + tears down two
 * companies + two projects) and must already have migration 066 applied
 * so the `projects` RLS policy exists.
 */

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROUTES_DIR = resolve(__dirname)

const COMPANY_A = '00000000-0000-4000-8000-000000000001'
const COMPANY_B = '00000000-0000-4000-8000-000000000002'

/**
 * The 20 highest-impact routes for Phase 3. Each entry maps a public path
 * surface to its handler module under `apps/api/src/routes/`. The audit
 * inspects the handler source statically. The audit assertion is per-row:
 * each route's audit status is computed independently so a single offender
 * still surfaces every other route's status in the printed summary.
 */
type AuditedRoute = {
  /** Display path used in the printed summary. */
  surface: string
  /** Handler module filename, relative to this directory. */
  file: string
  /** Category — used to group the summary. */
  category: 'money' | 'bulk-read' | 'workflow'
  /**
   * Documented reason a module's raw `pool.query(` calls are NOT a leak risk
   * even under Phase 3 FORCE. Set ONLY for handlers whose raw queries target the
   * ENABLE-not-FORCE append-only/queue tables on the cross-company admin surface
   * (the pg_dump owner exemption from migration 078), where the read is
   * deliberately unscoped and filtered explicitly in SQL. When set, the static
   * audit treats the module's mixed raw queries as expected rather than a
   * failure (it still prints the call sites in the summary).
   */
  rawQueryExemptReason?: string
}

const AUDITED_ROUTES: readonly AuditedRoute[] = [
  // Money-touching: every read or write here flows to QBO ledger; a cross-
  // company leak here would post a customer's invoice against the wrong
  // company in Intuit.
  { surface: '/api/projects/:id/estimate/push-qbo', file: 'estimate-pushes.ts', category: 'money' },
  { surface: '/api/rental-billing-runs', file: 'rental-billing-state.ts', category: 'money' },
  { surface: '/api/labor-payroll-runs', file: 'labor-payroll-runs.ts', category: 'money' },
  { surface: '/api/integrations/qbo', file: 'qbo.ts', category: 'money' },
  { surface: '/api/material-bills', file: 'material-bills.ts', category: 'money' },
  { surface: '/api/projects/:id/estimate', file: 'estimate.ts', category: 'money' },
  { surface: '/api/payroll-exports', file: 'payroll-exports.ts', category: 'money' },

  // Bulk-read: these handlers fan out across many domain tables in one
  // request. A single missed `withCompanyClient` here can leak hundreds of
  // rows in one response.
  {
    surface: '/api/bootstrap',
    file: 'system.ts',
    category: 'bulk-read',
    // system.ts handles BOTH /api/bootstrap (which reads exclusively through
    // withCompanyClient) AND /api/debug/traces/:id. The only raw pool.query
    // calls in the file are in the debug-trace helpers, reading the
    // ENABLE-not-FORCE append-only audit/queue tables (mutation_outbox,
    // sync_events, audit_events) on the documented cross-company admin surface
    // — they filter explicitly in SQL and are not a Phase 3 leak risk.
    rawQueryExemptReason: 'debug-trace reads target ENABLE-not-FORCE append-only audit tables (migration 078)',
  },
  { surface: '/api/projects', file: 'projects.ts', category: 'bulk-read' },
  { surface: '/api/customers', file: 'customers.ts', category: 'bulk-read' },
  { surface: '/api/workers', file: 'workers.ts', category: 'bulk-read' },
  { surface: '/api/daily-logs', file: 'daily-logs.ts', category: 'bulk-read' },
  { surface: '/api/schedules', file: 'schedules.ts', category: 'bulk-read' },
  { surface: '/api/takeoff/measurements', file: 'takeoff-measurements.ts', category: 'bulk-read' },
  { surface: '/api/projects/:id/blueprints', file: 'blueprints.ts', category: 'bulk-read' },
  { surface: '/api/analytics', file: 'analytics.ts', category: 'bulk-read' },

  // Workflow CRUD: thin reducer-backed endpoints, but each one issues both
  // reads (current snapshot) and writes (event append). The
  // workflow_event_log RLS policy already exists; routes still need the
  // GUC for the domain row read.
  { surface: '/api/time-review-runs', file: 'time-review-runs.ts', category: 'workflow' },
  { surface: '/api/projects/:id/lifecycle', file: 'project-lifecycle.ts', category: 'workflow' },
  { surface: '/api/crew-schedule-events', file: 'crew-schedule-events.ts', category: 'workflow' },
  { surface: '/api/clock', file: 'clock.ts', category: 'workflow' },
]

// Sanity check: the spec asks for exactly 20 routes.
if (AUDITED_ROUTES.length !== 20) {
  throw new Error(`rls-phase3-audit: expected 20 routes, got ${AUDITED_ROUTES.length}`)
}

type AuditFinding = {
  surface: string
  file: string
  category: AuditedRoute['category']
  /** True iff the module imports a GUC-binding helper. */
  importsGucHelper: boolean
  /** Lines that issue raw `pool.query(` calls (not wrapped in a closure that sets the GUC). */
  rawPoolQueryLines: number[]
  /** Total `pool.query(` occurrences, including those that filter `where company_id = $1`. */
  totalPoolQueryCalls: number
  /** True iff the module is judged safe to enable RLS against. */
  isSafe: boolean
  /** Human-readable verdict for the summary line. */
  verdict: string
}

/**
 * Parse a route module's source and decide whether it's ready for Phase 3.
 *
 * Heuristic rules (intentionally conservative — false positives are
 * preferred over false negatives because a missed leak is the failure
 * mode that matters):
 *
 *   - Safe: module imports `withCompanyClient` or `withMutationTx` AND
 *     issues no raw `pool.query(` calls anywhere in the file.
 *   - Safe-with-caveat: module imports one of those helpers AND every
 *     raw `pool.query(` call filters by `where company_id = $1`. Such
 *     calls work TODAY (RLS off) but will silently leak under Phase 3
 *     unless rewritten through the helper. The audit flags them.
 *   - Leak risk: module issues `pool.query(` calls AND does not import a
 *     GUC helper.
 *
 * The parser does line-based matching rather than a full AST walk — the
 * routes are hand-rolled SQL strings, not closures-of-closures, and this
 * is cheap to keep in sync as routes evolve.
 */
function auditRouteModule(route: AuditedRoute): AuditFinding {
  const sourcePath = resolve(ROUTES_DIR, route.file)
  const source = readFileSync(sourcePath, 'utf8')
  const lines = source.split('\n')

  const importsGucHelper =
    /from\s+['"]\.\.\/mutation-tx\.js['"]/.test(source) && /(withCompanyClient|withMutationTx)/.test(source)

  // Find every raw `pool.query(` line. The route handler shape is `ctx.pool`
  // (the per-request DispatchContext shape) — we match both `ctx.pool.query(`
  // and bare `pool.query(` for completeness.
  const rawPoolQueryLines: number[] = []
  let totalPoolQueryCalls = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/\bpool\.query\s*\(/.test(line) || /\bctx\.pool\.query\s*\(/.test(line)) {
      totalPoolQueryCalls += 1
      // Comments don't count.
      if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) continue
      rawPoolQueryLines.push(i + 1)
    }
  }

  let isSafe: boolean
  let verdict: string
  if (rawPoolQueryLines.length === 0 && importsGucHelper) {
    isSafe = true
    verdict = 'uses withCompanyClient'
  } else if (rawPoolQueryLines.length === 0 && !importsGucHelper) {
    // Pure pass-through routes (e.g. handlers that only call helpers in other
    // modules) end up here. Mark safe but note the missing import so the
    // operator can verify by hand.
    isSafe = true
    verdict = 'no direct queries (delegates to helpers)'
  } else if (route.rawQueryExemptReason) {
    // Module has raw pool.query calls, but they are a DOCUMENTED cross-company
    // admin read against ENABLE-not-FORCE append-only tables — not a leak risk
    // under Phase 3 FORCE. Report the call sites but treat as safe.
    isSafe = true
    verdict = `exempt — ${rawPoolQueryLines.length} raw pool.query call(s) at line(s) ${rawPoolQueryLines
      .slice(0, 5)
      .join(', ')}${rawPoolQueryLines.length > 5 ? '…' : ''} (${route.rawQueryExemptReason})`
  } else if (importsGucHelper) {
    // The module uses helpers somewhere but ALSO has raw pool.query calls.
    // Under Phase 3 those raw calls become leak risks unless every one of
    // them filters by company_id AND the route accepts the trade-off that
    // its rows will appear in cross-company reads if RLS sweeps over them.
    isSafe = false
    verdict = `mixed — ${rawPoolQueryLines.length} raw pool.query call(s) at line(s) ${rawPoolQueryLines.slice(0, 5).join(', ')}${
      rawPoolQueryLines.length > 5 ? '…' : ''
    } (LEAK RISK under Phase 3)`
  } else {
    isSafe = false
    verdict = `issues ${rawPoolQueryLines.length} raw pool.query call(s) and does not import withCompanyClient (LEAK RISK)`
  }

  return {
    surface: route.surface,
    file: route.file,
    category: route.category,
    importsGucHelper,
    rawPoolQueryLines,
    totalPoolQueryCalls,
    isSafe,
    verdict,
  }
}

// ---------------------------------------------------------------------------
// Static audit — always runs, even without CONSTRAINED_DB_URL.
//
// Phase 3 RLS is now ENABLED + FORCED across the company-scoped surface
// (migrations 085/101 + the per-table follow-ups), and the integration stage
// of scripts/verify-local.sh sets `RLS_PHASE3_FAIL_ON_LEAK=1`, so this audit is
// a BLOCKING GATE: any audited route that issues a raw `pool.query(` outside a
// withCompanyClient / withMutationTx closure (and is not a documented
// cross-company admin read — see `rawQueryExemptReason`) fails the build. The
// printed summary at the bottom still lists every route's status. Leave
// `RLS_PHASE3_FAIL_ON_LEAK` unset for a report-only run during local iteration.
// ---------------------------------------------------------------------------

const findings: AuditFinding[] = AUDITED_ROUTES.map(auditRouteModule)
const FAIL_ON_LEAK = process.env.RLS_PHASE3_FAIL_ON_LEAK === '1'

describe('RLS Phase 3 audit — static analysis', () => {
  // Sentinel test: at least proves the audit ran and surfaced the expected
  // number of routes. The per-route findings end up in the printed summary
  // at the bottom of this file.
  it('inspected every audited route module', () => {
    expect(findings.length).toBe(AUDITED_ROUTES.length)
    for (const f of findings) {
      expect(f.file).toBeTruthy()
      expect(f.surface).toBeTruthy()
    }
  })

  // Hard gate (active under RLS_PHASE3_FAIL_ON_LEAK=1 — set by verify-local.sh's
  // integration stage). Any audited route that issues a raw pool.query outside a
  // GUC-binding closure (and isn't a documented exemption) breaks the build.
  if (FAIL_ON_LEAK) {
    for (const finding of findings) {
      it(`${finding.surface} (${finding.file}) is ready for Phase 3 RLS`, () => {
        expect(
          finding.isSafe,
          `${finding.surface} — ${finding.verdict}\n` +
            `  file: apps/api/src/routes/${finding.file}\n` +
            `  raw pool.query lines: ${finding.rawPoolQueryLines.join(', ') || '(none)'}\n` +
            `  importsGucHelper: ${finding.importsGucHelper}\n` +
            `  hint: route the read/write through withCompanyClient(ctx.company.id, (c) => c.query(...)) or withMutationTx(async (client) => ...).`,
        ).toBe(true)
      })
    }
  }
})

// ---------------------------------------------------------------------------
// Forced-RLS coverage audit — the "next asset_deployments gap" catcher.
//
// Runs against the live (post-migration) integration Postgres. For every
// `public` table that has a `company_id` column, it reads
// `pg_class.relforcerowsecurity`; any table that is NOT forced AND NOT on the
// documented allowlist (`RLS_FORCE_AUDIT_ALLOWLIST` in ./rls-force-audit.ts) is
// a finding. asset_deployments was such a finding until migration 145 forced
// it. Under RLS_PHASE3_FAIL_ON_LEAK=1 (set by verify-local.sh's integration
// stage) a finding FAILS the build, so the next company-scoped table that ships
// without forced RLS is caught at gate time. The probe only reads pg_catalog,
// so the BYPASSRLS `sitelayer` integration role is fine — no constrained role
// needed. Skips cleanly outside the integration suite.
// ---------------------------------------------------------------------------

const RUN_INTEGRATION = process.env.RUN_API_INTEGRATION === '1'
const describeForceAudit = RUN_INTEGRATION ? describe : describe.skip
const FORCE_AUDIT_DB_URL = process.env.DATABASE_URL ?? 'postgres://sitelayer:sitelayer@localhost:5432/sitelayer'

describeForceAudit('RLS forced-coverage audit — live schema (company_id tables)', () => {
  let pool: Pool
  let forceFindings: RlsForceFinding[] = []
  let inspectedCount = 0

  it('every company_id table is FORCE RLS or explicitly allowlisted', async () => {
    pool = new Pool({ connectionString: FORCE_AUDIT_DB_URL, max: 2 })
    const { state, findings } = await auditUnforcedCompanyTables((sql) => pool.query(sql))
    inspectedCount = state.length
    forceFindings = findings

    // Sanity: the audit must actually see the company-scoped surface — a query
    // that returns nothing would silently pass. The domain has ~100 such tables.
    expect(inspectedCount).toBeGreaterThan(50)

    // asset_deployments specifically must be forced now (the slice's keystone).
    const assetDeployments = state.find((s) => s.table === 'asset_deployments')
    expect(assetDeployments, 'asset_deployments must exist in the audited surface').toBeDefined()
    expect(assetDeployments?.forced, 'asset_deployments must have FORCE ROW LEVEL SECURITY (migration 145)').toBe(true)

    if (FAIL_ON_LEAK) {
      expect(
        forceFindings,
        forceFindings.length === 0
          ? ''
          : `Found company_id table(s) without FORCE ROW LEVEL SECURITY and not on the allowlist:\n` +
              forceFindings.map((f) => `  - ${f.table}: ${f.reason}`).join('\n') +
              `\n\nFix: add the per-table RLS in a NEW migration (mirror 101_v2_rls.sql / 145_asset_deployments_rls.sql),\n` +
              `or, if the table is intentionally not tenant-isolated, add it to RLS_FORCE_AUDIT_ALLOWLIST\n` +
              `in apps/api/src/routes/rls-force-audit.ts with a one-line reason.`,
      ).toEqual([])
    }
  })

  afterAll(async () => {
    if (pool) await pool.end()
    // Always print the coverage summary so the operator sees the punch-list
    // even when the gate is off (report-only) or green.
    const lines: string[] = ['', 'RLS forced-coverage audit:']
    lines.push(`  inspected ${inspectedCount} company_id table(s).`)
    if (forceFindings.length === 0) {
      lines.push('  all company_id tables are FORCE RLS or explicitly allowlisted.')
    } else {
      lines.push(`  ${forceFindings.length} unforced + non-allowlisted table(s):`)
      for (const f of forceFindings) lines.push(`    XX ${f.table} — ${f.reason}`)
    }
    lines.push('')
    console.log(lines.join('\n'))
  })
})

// ---------------------------------------------------------------------------
// Runtime probe — gated by CONSTRAINED_DB_URL. Verifies the mechanism the
// static audit assumes is real. We toggle RLS on `projects` only, prove
// the GUC scopes reads, and disable RLS again. The probe is a smoke test
// for the constrained-role plumbing, NOT a per-route HTTP exercise.
// ---------------------------------------------------------------------------

const CONSTRAINED_DB_URL = process.env.CONSTRAINED_DB_URL
const describeRuntime = CONSTRAINED_DB_URL ? describe : describe.skip

describeRuntime('RLS Phase 3 audit — runtime probe (constrained role)', () => {
  let pool: Pool
  const projectA = randomUUID()
  const projectB = randomUUID()
  // Use a unique slug per run so concurrent CI shards don't collide on the
  // companies-table unique index.
  const slugSuffix = randomUUID().slice(0, 8)

  async function ensureCompaniesExist() {
    await pool.query(
      `insert into companies (id, slug, name)
       values ($1, $2, $3), ($4, $5, $6)
       on conflict (id) do nothing`,
      [
        COMPANY_A,
        `rls-phase3-a-${slugSuffix}`,
        'RLS Phase 3 Audit A',
        COMPANY_B,
        `rls-phase3-b-${slugSuffix}`,
        'RLS Phase 3 Audit B',
      ],
    )
  }

  async function ensureProjectsExist() {
    await pool.query(
      `insert into projects (id, company_id, name, customer_name, division_code, status)
       values ($1, $2, 'A project', 'A customer', 'D1', 'planning'),
              ($3, $4, 'B project', 'B customer', 'D1', 'planning')
       on conflict (id) do nothing`,
      [projectA, COMPANY_A, projectB, COMPANY_B],
    )
  }

  it('confirms the configured role is NOT a BYPASSRLS superuser', async () => {
    pool = new Pool({ connectionString: CONSTRAINED_DB_URL, max: 2 })
    const result = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean; rolname: string }>(
      'select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user',
    )
    const row = result.rows[0]
    expect(row, 'CONSTRAINED_DB_URL must point at a role visible in pg_roles').toBeDefined()
    if (!row) return
    expect(row.rolbypassrls, 'CONSTRAINED_DB_URL must point at a NOBYPASSRLS role').toBe(false)
    expect(row.rolsuper, 'CONSTRAINED_DB_URL must point at a non-superuser role').toBe(false)
  })

  it('reads only company A rows when app.company_id = COMPANY_A', async () => {
    await ensureCompaniesExist()
    await ensureProjectsExist()
    await pool.query('alter table projects enable row level security')
    await pool.query('alter table projects force row level security')

    try {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select set_config($1, $2, true)', ['app.company_id', COMPANY_A])
        const visible = await client.query<{ id: string }>('select id from projects where id = any($1::uuid[])', [
          [projectA, projectB],
        ])
        expect(visible.rows.map((r) => r.id)).toEqual([projectA])
        await client.query('commit')
      } finally {
        client.release()
      }
    } finally {
      // Always drop the RLS toggle so the dev DB isn't left in a forced
      // state if a teardown step throws.
      await pool.query('alter table projects no force row level security').catch(() => undefined)
      await pool.query('alter table projects disable row level security').catch(() => undefined)
    }
  })

  it('reads only company B rows when app.company_id = COMPANY_B', async () => {
    await ensureCompaniesExist()
    await ensureProjectsExist()
    await pool.query('alter table projects enable row level security')
    await pool.query('alter table projects force row level security')

    try {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select set_config($1, $2, true)', ['app.company_id', COMPANY_B])
        const visible = await client.query<{ id: string }>('select id from projects where id = any($1::uuid[])', [
          [projectA, projectB],
        ])
        expect(visible.rows.map((r) => r.id)).toEqual([projectB])
        await client.query('commit')
      } finally {
        client.release()
      }
    } finally {
      await pool.query('alter table projects no force row level security').catch(() => undefined)
      await pool.query('alter table projects disable row level security').catch(() => undefined)
    }
  })

  it('rejects a write against the wrong company (RLS WITH CHECK)', async () => {
    await ensureCompaniesExist()
    await ensureProjectsExist()
    await pool.query('alter table projects enable row level security')
    await pool.query('alter table projects force row level security')

    try {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select set_config($1, $2, true)', ['app.company_id', COMPANY_A])
        // Attempt to write a row owned by company B while bound to A.
        await expect(
          client.query(
            `insert into projects (id, company_id, name, customer_name, division_code, status)
             values ($1, $2, 'X', 'X cust', 'D1', 'planning')`,
            [randomUUID(), COMPANY_B],
          ),
        ).rejects.toThrow(/row-level security/i)
        await client.query('rollback').catch(() => undefined)
      } finally {
        client.release()
      }
    } finally {
      await pool.query('alter table projects no force row level security').catch(() => undefined)
      await pool.query('alter table projects disable row level security').catch(() => undefined)
    }
  })

  afterAll(async () => {
    if (!pool) return
    const swallow = async (sql: string, params: unknown[] = []) => {
      try {
        await pool.query(sql, params)
      } catch {
        // best-effort
      }
    }
    // Make doubly sure RLS is off before we leave (in case an assertion
    // throw bypassed the per-test finally block).
    await swallow('alter table projects no force row level security')
    await swallow('alter table projects disable row level security')
    await swallow('delete from company_bootstrap_state where company_id = any($1::uuid[])', [[COMPANY_A, COMPANY_B]])
    await swallow('delete from projects where id = any($1::uuid[])', [[projectA, projectB]])
    await swallow('delete from companies where id = any($1::uuid[])', [[COMPANY_A, COMPANY_B]])
    await pool.end()
  })
})

// ---------------------------------------------------------------------------
// Summary printer — prints a per-route table at the end of the run, in the
// shape Step 5 of the spec asks for. Prints to stdout via console.log so
// it survives --reporter=dot.
// ---------------------------------------------------------------------------

afterAll(() => {
  const leaks = findings.filter((f) => !f.isSafe)
  const safe = findings.filter((f) => f.isSafe)
  const longest = findings.reduce((max, f) => Math.max(max, f.surface.length), 0)

  const lines: string[] = []
  lines.push('')
  lines.push('RLS Phase 3 audit summary:')
  for (const category of ['money', 'bulk-read', 'workflow'] as const) {
    lines.push(`  --- ${category} ---`)
    for (const f of findings.filter((x) => x.category === category)) {
      const mark = f.isSafe ? 'OK ' : 'XX '
      const padded = f.surface.padEnd(longest)
      lines.push(`  ${mark} ${padded} — ${f.verdict}`)
    }
  }
  lines.push('')
  lines.push(`  ${safe.length}/${findings.length} routes ready for Phase 3 RLS enable.`)
  if (leaks.length > 0) {
    lines.push(`  ${leaks.length} route(s) need to migrate raw pool.query → withCompanyClient before flip:`)
    for (const leak of leaks) {
      lines.push(`    - apps/api/src/routes/${leak.file} (${leak.surface})`)
    }
  }
  if (!CONSTRAINED_DB_URL) {
    lines.push('')
    lines.push('  Runtime probe SKIPPED (CONSTRAINED_DB_URL not set).')
    lines.push('  To exercise the constrained-role mechanism locally, provision a non-BYPASSRLS role:')
    lines.push('    psql "$DATABASE_URL" -c "create role app_role nobypassrls login password \'app_role\'"')
    lines.push(
      '    psql "$DATABASE_URL" -c "grant select, insert, update, delete on all tables in schema public to app_role"',
    )
    lines.push('  then re-run with:')
    lines.push('    CONSTRAINED_DB_URL=postgres://app_role:app_role@localhost:5432/sitelayer \\')
    lines.push('      npx vitest run src/routes/rls-phase3-audit.test.ts')
  }
  lines.push('')

  console.log(lines.join('\n'))
})
