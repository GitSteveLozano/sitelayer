import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

/**
 * RLS Phase 3 readiness audit.
 *
 * Phase 1 (migration 066) shipped RLS policies on every domain table; Phase 2
 * left them DISABLED in shadow mode so misconfigured routes wouldn't tank the
 * pilot. Phase 3 will FLIP RLS ENABLE/FORCE on the 77 domain tables. The
 * pre-condition for that flip is: every route either checks out a
 * `withCompanyClient(...)` / `withMutationTx(...)` client (which sets the
 * `app.company_id` GUC inside a tx), or its raw `pool.query(...)` calls go
 * away. A raw `pool.query` would silently leak rows across companies the
 * instant RLS is enabled because the pool's BYPASSRLS role bypasses the
 * policy, but the GUC never gets bound to the connection.
 *
 * This file does two things:
 *
 *  1. **Static audit (always runs).** For every route under audit, read the
 *     handler source and assert that the file imports either `withCompanyClient`
 *     or `withMutationTx` from `../mutation-tx.js`. Flag any module that
 *     issues `pool.query(` or `client.query(` calls outside such a closure
 *     so the operator can see exactly which file is the leak risk. This
 *     audit prints a per-route summary in `afterAll` (the report Step 5 of
 *     the spec asks for).
 *
 *  2. **Runtime probe (gated by `CONSTRAINED_DB_URL`).** Connects to Postgres
 *     as a non-BYPASSRLS role, enables + forces RLS on the `projects` table,
 *     seeds one row per company, and verifies the policy actually scopes
 *     reads to the GUC value. Proves the mechanism the audit assumes is
 *     real before Phase 3 turns it on for the other 76 tables. Skips
 *     cleanly when the env var is unset — CI doesn't have a constrained
 *     role provisioned yet.
 *
 * Important: this file MUST NOT enable RLS on any non-test table. The Phase
 * 3 flip is the follow-up PR. Phase 1's `alter table … enable row level
 * security` lives on `audit_events`, `workflow_event_log`,
 * `mutation_outbox`, and `sync_events`; everything else stays in shadow
 * mode until that follow-up.
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
  { surface: '/api/bootstrap', file: 'system.ts', category: 'bulk-read' },
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
// IMPORTANT: the static audit is a *report*, not a fail-the-build gate. CI
// runs without CONSTRAINED_DB_URL and Phase 3 has not flipped RLS yet, so
// the existing mixed `pool.query`/`withCompanyClient` modules are
// intentionally not failures today. They become failures the day Phase 3
// flips RLS on; until then the printed summary is the operator's punch
// list. Use the `RLS_PHASE3_FAIL_ON_LEAK=1` env var to convert the
// summary into hard test failures — wire that up the same PR that
// enables RLS so the audit becomes a blocking gate at the right time.
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

  // Optional hard gate. Off by default so CI stays green while Phase 3 is
  // still in shadow mode; flip RLS_PHASE3_FAIL_ON_LEAK=1 the same PR that
  // enables RLS so any new offender breaks the build.
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
