import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { HttpError, isValidUuid } from '../http-utils.js'

export type BudgetRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface BudgetSnapshotRow {
  id: string
  company_id: string
  project_id: string
  version: number
  frozen_at: string
  frozen_by: string | null
  note: string | null
  material_total: string
  labor_total: string
  budget_total: string
  created_at: string
}

interface BudgetSnapshotLineRow {
  id: string
  cost_code: string | null
  division_code: string | null
  service_item_code: string
  qty: string
  unit: string
  material_amount: string
  labor_amount: string
}

// The per-cost-code roll-up of the live estimate (the bid) that a freeze
// captures. Keyed by service_item_code — the one axis shared with both
// estimate_lines and labor_entries.
interface EstimateRollupRow {
  service_item_code: string
  division_code: string | null
  unit: string
  qty: string
  material_amount: string
  labor_amount: string
}

// ---------------------------------------------------------------------------
// Variance view shapes (returned by GET .../budget/variance)
// ---------------------------------------------------------------------------

interface VarianceCostCode {
  service_item_code: string
  cost_code: string | null
  division_code: string | null
  unit: string
  budget_qty: number
  budget_material_cents: number
  budget_labor_cents: number
  budget_total_cents: number
  actual_material_cents: number
  actual_labor_cents: number
  actual_total_cents: number
  variance_cents: number
  // Ordinal confidence per the AI Layer rule — never a numeric pct. Mirrors
  // bid-accuracy.ts: |variance / budget| < 5% → high (on budget); < 15% → med;
  // else low (budget materially off).
  confidence: 'low' | 'med' | 'high'
}

const num = (raw: string | number | null | undefined): number => {
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}
const toCents = (dollars: number): number => Math.round(dollars * 100)

function confidenceFor(budgetCents: number, varianceCents: number): 'low' | 'med' | 'high' {
  if (budgetCents <= 0) return 'low'
  const absPct = Math.abs((varianceCents / budgetCents) * 100)
  return absPct < 5 ? 'high' : absPct < 15 ? 'med' : 'low'
}

/**
 * Roll the project's CURRENT estimate_lines (the live bid) up by
 * service_item_code, splitting the dollar amount into labor (kind='labor')
 * vs material (everything else) per the estimate_lines.kind column (mig 109).
 * This is the exact shape frozen into budget_snapshot_lines, and the exact
 * taxonomy the actuals are rolled by, so budget and actuals are comparable.
 */
async function rollupEstimate(client: PoolClient, companyId: string, projectId: string): Promise<EstimateRollupRow[]> {
  const result = await client.query<EstimateRollupRow>(
    `select
       el.service_item_code,
       max(el.division_code) as division_code,
       max(el.unit) as unit,
       coalesce(sum(el.quantity), 0)::text as qty,
       coalesce(sum(case when el.kind = 'labor' then 0 else el.amount end), 0)::text as material_amount,
       coalesce(sum(case when el.kind = 'labor' then el.amount else 0 end), 0)::text as labor_amount
     from estimate_lines el
     where el.company_id = $1 and el.project_id = $2
     group by el.service_item_code
     order by el.service_item_code asc`,
    [companyId, projectId],
  )
  return result.rows
}

/**
 * Per-service-item actuals for a project, rolled by the SAME taxonomy as the
 * budget so the two line up:
 *   - labor actuals  = sum(labor_entries.hours) × project.labor_rate, keyed by
 *     labor_entries.service_item_code (the field-recorded code).
 *   - material actuals = sum(material_bills.amount). material_bills has NO
 *     service_item_code (schema 001) — material spend is per-project, not
 *     cost-coded — so ALL material actuals attribute to a single synthetic
 *     unallocated bucket (service_item_code = ''), surfaced as "Unallocated
 *     material" in the view. This is an honest limitation, not a guess: there
 *     is no taxonomy on the bill to split it by. (Flagged in the PR.)
 */
async function rollupActuals(
  client: PoolClient,
  companyId: string,
  projectId: string,
): Promise<{ laborByCode: Map<string, number>; materialTotalCents: number }> {
  const laborRes = await client.query<{ service_item_code: string; labor_cents: string }>(
    `select
       le.service_item_code,
       coalesce(sum(le.hours * coalesce(p.labor_rate, 0) * 100), 0)::bigint::text as labor_cents
     from labor_entries le
     join projects p on p.company_id = le.company_id and p.id = le.project_id
     where le.company_id = $1 and le.project_id = $2 and le.deleted_at is null
     group by le.service_item_code`,
    [companyId, projectId],
  )
  const laborByCode = new Map<string, number>()
  for (const r of laborRes.rows) laborByCode.set(r.service_item_code, num(r.labor_cents))

  const materialRes = await client.query<{ material_cents: string }>(
    `select coalesce(sum(mb.amount * 100), 0)::bigint::text as material_cents
     from material_bills mb
     where mb.company_id = $1 and mb.project_id = $2 and mb.deleted_at is null`,
    [companyId, projectId],
  )
  const materialTotalCents = num(materialRes.rows[0]?.material_cents)
  return { laborByCode, materialTotalCents }
}

const SNAPSHOT_COLUMNS = `id, company_id, project_id, version, frozen_at, frozen_by, note,
  material_total, labor_total, budget_total, created_at`

/**
 * Budget freeze + variance (Takeoff Deep Dive §4 — bid / budget / actuals).
 *
 *   POST /api/projects/:id/budget/freeze   — snapshot the CURRENT estimate_lines
 *       (rolled up by cost-code) into a NEW immutable budget_snapshots row. If a
 *       snapshot already exists, mint the NEXT version (change-order freeze);
 *       an existing snapshot is NEVER mutated (DB trigger enforces this too).
 *   GET  /api/projects/:id/budget          — list this project's snapshots
 *       (newest first) for the change-order audit trail + the freeze badge.
 *   GET  /api/projects/:id/budget/variance — per-cost-code BUDGET (latest
 *       frozen snapshot) vs ACTUALS (material_bills + labor_entries rolled by
 *       the same taxonomy).
 *
 * The freeze is an EXPLICIT operator action — it is NOT tied to
 * project_lifecycle (no state-machine change). estimate_lines stays the live
 * bid, untouched. Additive: a project with no freeze simply has no snapshot,
 * and the variance view reports "not yet frozen".
 */
export async function handleBudgetRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: BudgetRouteCtx,
): Promise<boolean> {
  const freezeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/budget\/freeze$/)
  const varianceMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/budget\/variance$/)
  const listMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/budget$/)

  // POST .../budget/freeze ---------------------------------------------------
  if (req.method === 'POST' && freezeMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = freezeMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody().catch(() => ({}) as Record<string, unknown>)
    const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null

    let result: { snapshot: BudgetSnapshotRow; lines: BudgetSnapshotLineRow[] } | null
    try {
      result = await withMutationTx(ctx.company.id, async (client) => {
        // Project must exist in this company (RLS already scopes, but a
        // missing project should 404 not silently freeze nothing).
        const proj = await client.query<{ id: string }>(
          `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
          [ctx.company.id, projectId],
        )
        if (!proj.rows[0]) return null

        const rollup = await rollupEstimate(client, ctx.company.id, projectId)
        if (rollup.length === 0) {
          throw new HttpError(400, 'no estimate lines to freeze — recompute the estimate first')
        }

        // Next version = max existing + 1 (change-order freeze). Locked so
        // two concurrent freezes can't both grab the same version.
        const verRes = await client.query<{ next_version: number }>(
          `select coalesce(max(version), 0) + 1 as next_version
           from budget_snapshots
           where company_id = $1 and project_id = $2`,
          [ctx.company.id, projectId],
        )
        const version = Number(verRes.rows[0]?.next_version ?? 1)

        let materialTotal = 0
        let laborTotal = 0
        for (const r of rollup) {
          materialTotal += num(r.material_amount)
          laborTotal += num(r.labor_amount)
        }
        const budgetTotal = materialTotal + laborTotal

        const header = await client.query<BudgetSnapshotRow>(
          `insert into budget_snapshots
             (company_id, project_id, version, frozen_by, note,
              material_total, labor_total, budget_total)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning ${SNAPSHOT_COLUMNS}`,
          [
            ctx.company.id,
            projectId,
            version,
            ctx.currentUserId,
            note,
            materialTotal.toFixed(2),
            laborTotal.toFixed(2),
            budgetTotal.toFixed(2),
          ],
        )
        const snapshot = header.rows[0]
        if (!snapshot) throw new HttpError(500, 'budget snapshot insert returned no row')

        const lines: BudgetSnapshotLineRow[] = []
        for (const r of rollup) {
          // cost_code is populated from division_code today (the only
          // higher-level cost-coding axis the estimate carries); NULLABLE so a
          // future real cost-code dimension can replace it without a rewrite.
          const inserted = await client.query<BudgetSnapshotLineRow>(
            `insert into budget_snapshot_lines
               (company_id, budget_snapshot_id, cost_code, division_code,
                service_item_code, qty, unit, material_amount, labor_amount)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             returning id, cost_code, division_code, service_item_code, qty, unit,
                       material_amount, labor_amount`,
            [
              ctx.company.id,
              snapshot.id,
              r.division_code,
              r.division_code,
              r.service_item_code,
              num(r.qty).toFixed(2),
              r.unit ?? '',
              num(r.material_amount).toFixed(2),
              num(r.labor_amount).toFixed(2),
            ],
          )
          const line = inserted.rows[0]
          if (line) lines.push(line)
        }

        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'budget_snapshot',
          entityId: snapshot.id,
          action: 'freeze',
          row: snapshot,
          actorUserId: ctx.currentUserId,
        })
        return { snapshot, lines }
      })
    } catch (err) {
      if (err instanceof HttpError) {
        ctx.sendJson(err.status, { error: err.message })
        return true
      }
      // Unique (company, project, version) collision under a concurrent
      // freeze → 409, never a silent dup.
      if (err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === '23505') {
        ctx.sendJson(409, { error: 'a budget freeze is already in progress for this project — retry' })
        return true
      }
      throw err
    }

    if (!result) {
      ctx.sendJson(404, { error: 'project not found' })
      return true
    }
    ctx.sendJson(201, { snapshot: result.snapshot, lines: result.lines })
    return true
  }

  // GET .../budget/variance --------------------------------------------------
  if (req.method === 'GET' && varianceMatch) {
    const projectId = varianceMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }

    const payload = await withCompanyClient(ctx.company.id, async (client) => {
      // Latest frozen snapshot is the current budget; prior versions are the
      // change-order trail (not compared here).
      const snapRes = await client.query<BudgetSnapshotRow>(
        `select ${SNAPSHOT_COLUMNS}
         from budget_snapshots
         where company_id = $1 and project_id = $2
         order by version desc
         limit 1`,
        [ctx.company.id, projectId],
      )
      const snapshot = snapRes.rows[0] ?? null

      const budgetLines: BudgetSnapshotLineRow[] = snapshot
        ? (
            await client.query<BudgetSnapshotLineRow>(
              `select id, cost_code, division_code, service_item_code, qty, unit,
                      material_amount, labor_amount
               from budget_snapshot_lines
               where company_id = $1 and budget_snapshot_id = $2
               order by service_item_code asc`,
              [ctx.company.id, snapshot.id],
            )
          ).rows
        : []

      const { laborByCode, materialTotalCents } = await rollupActuals(client, ctx.company.id, projectId)
      return { snapshot, budgetLines, laborByCode, materialTotalCents }
    })

    if (!payload.snapshot) {
      // Not frozen yet — the view renders a "Freeze budget" prompt. Still
      // surface the live actuals so the page isn't empty.
      ctx.sendJson(200, {
        frozen: false,
        snapshot: null,
        cost_codes: [],
        summary: {
          budget_total_cents: 0,
          actual_total_cents: payload.materialTotalCents,
          variance_cents: payload.materialTotalCents,
          unallocated_material_cents: payload.materialTotalCents,
        },
        attribution: 'No frozen budget yet. Freeze the current estimate to begin tracking variance.',
      })
      return true
    }

    // Merge budget lines with per-code labor actuals. material actuals have no
    // taxonomy on the bill, so they roll into a single Unallocated bucket
    // appended after the cost-coded lines.
    const laborByCode = new Map(payload.laborByCode)
    const costCodes: VarianceCostCode[] = []
    for (const bl of payload.budgetLines) {
      const code = bl.service_item_code
      const budgetMaterialCents = toCents(num(bl.material_amount))
      const budgetLaborCents = toCents(num(bl.labor_amount))
      const budgetTotalCents = budgetMaterialCents + budgetLaborCents
      const actualLaborCents = laborByCode.get(code) ?? 0
      laborByCode.delete(code)
      // Per-code material actuals are not knowable (no code on the bill); they
      // live in the Unallocated row, so a cost-coded line's actual_material is 0.
      const actualMaterialCents = 0
      const actualTotalCents = actualMaterialCents + actualLaborCents
      const varianceCents = actualTotalCents - budgetTotalCents
      costCodes.push({
        service_item_code: code,
        cost_code: bl.cost_code,
        division_code: bl.division_code,
        unit: bl.unit,
        budget_qty: num(bl.qty),
        budget_material_cents: budgetMaterialCents,
        budget_labor_cents: budgetLaborCents,
        budget_total_cents: budgetTotalCents,
        actual_material_cents: actualMaterialCents,
        actual_labor_cents: actualLaborCents,
        actual_total_cents: actualTotalCents,
        variance_cents: varianceCents,
        confidence: confidenceFor(budgetTotalCents, varianceCents),
      })
    }

    // Labor actuals against service-item codes that the budget never froze
    // (field crew logged a code the estimate didn't carry) — surface them so
    // they aren't silently dropped. Budget is 0, so it's pure overage.
    for (const [code, laborCents] of laborByCode) {
      if (laborCents === 0) continue
      costCodes.push({
        service_item_code: code,
        cost_code: null,
        division_code: null,
        unit: '',
        budget_qty: 0,
        budget_material_cents: 0,
        budget_labor_cents: 0,
        budget_total_cents: 0,
        actual_material_cents: 0,
        actual_labor_cents: laborCents,
        actual_total_cents: laborCents,
        variance_cents: laborCents,
        confidence: 'low',
      })
    }

    const budgetTotalCents = toCents(num(payload.snapshot.budget_total))
    const actualLaborCents = costCodes.reduce((a, c) => a + c.actual_labor_cents, 0)
    const actualTotalCents = actualLaborCents + payload.materialTotalCents
    const varianceCents = actualTotalCents - budgetTotalCents

    ctx.sendJson(200, {
      frozen: true,
      snapshot: payload.snapshot,
      cost_codes: costCodes,
      // Material spend has no cost-code taxonomy on the bill — reported as a
      // single project-level number (deep-dive §4 honest limitation).
      unallocated_material_cents: payload.materialTotalCents,
      summary: {
        budget_total_cents: budgetTotalCents,
        budget_material_cents: toCents(num(payload.snapshot.material_total)),
        budget_labor_cents: toCents(num(payload.snapshot.labor_total)),
        actual_material_cents: payload.materialTotalCents,
        actual_labor_cents: actualLaborCents,
        actual_total_cents: actualTotalCents,
        variance_cents: varianceCents,
      },
      attribution:
        `Budget = frozen estimate snapshot (v${payload.snapshot.version}). ` +
        'Actuals = material_bills + labor_entries × labor_rate, rolled by service_item_code. ' +
        'Material actuals are project-level (bills carry no cost-code).',
    })
    return true
  }

  // GET .../budget (list snapshots) -----------------------------------------
  if (req.method === 'GET' && listMatch) {
    const projectId = listMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project id must be a valid uuid' })
      return true
    }
    const snapshots = await withCompanyClient(ctx.company.id, async (client) => {
      const res = await client.query<BudgetSnapshotRow>(
        `select ${SNAPSHOT_COLUMNS}
         from budget_snapshots
         where company_id = $1 and project_id = $2
         order by version desc`,
        [ctx.company.id, projectId],
      )
      return res.rows
    })
    ctx.sendJson(200, { snapshots })
    return true
  }

  return false
}
