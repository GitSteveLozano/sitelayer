import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { isValidUuid, parseJsonBody } from '../http-utils.js'
import type { DispatchRouteDescriptor } from './dispatch.js'

// Wire-format for the milestone routes. Both bodies are multi-alias: POST
// dispatches on milestones[] / label / (default ladder) and PATCH builds a
// dynamic SET from whichever optional fields are present. The existing deep
// coercers (`coerceMilestoneInput`, `parseOptionalMoney`, `isMilestoneStatus`)
// stay the source of truth — these schemas only reject malformed top-level
// shapes up front (e.g. `milestones: 7`, `label: {...}`). `milestones[]`
// entries are typed as objects without validating their inner shape (the
// coercer owns that). `.loose()` keeps unknown keys.
const NumericInputSchema = z.union([z.number(), z.string()])

type MilestoneStatus = 'not_yet' | 'invoiced' | 'paid'

const MILESTONE_STATUSES: readonly MilestoneStatus[] = ['not_yet', 'invoiced', 'paid']

// Reject an out-of-domain `status` at PARSE time (→ 400) rather than relying
// only on the downstream `isMilestoneStatus` runtime guard. The create path
// previously coerced an unknown status to `not_yet` and the patch path 400'd
// after parse — both now fail fast and uniformly here. The runtime guard is
// kept as belt-and-suspenders for entries that bypass these top-level schemas
// (e.g. inner `milestones[]` objects validated by `coerceMilestoneInput`).
const MilestoneStatusSchema = z.enum(MILESTONE_STATUSES as [MilestoneStatus, ...MilestoneStatus[]])

const MilestoneCreateBodySchema = z
  .object({
    milestones: z.array(z.record(z.string(), z.unknown())).optional(),
    label: z.string().optional(),
    pct: NumericInputSchema.nullish(),
    amount: NumericInputSchema.nullish(),
    sort_order: NumericInputSchema.nullish(),
    status: MilestoneStatusSchema.optional(),
    estimate_push_id: z.union([z.string(), z.null()]).optional(),
    contract_value: NumericInputSchema.nullish(),
  })
  .loose()

const MilestonePatchBodySchema = z
  .object({
    status: MilestoneStatusSchema.optional(),
    label: z.string().optional(),
    pct: NumericInputSchema.nullish(),
    amount: NumericInputSchema.nullish(),
    sort_order: NumericInputSchema.nullish(),
    estimate_push_id: z.union([z.string(), z.null()]).optional(),
  })
  .loose()

export type ProjectBillingMilestoneRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const MILESTONE_COLUMNS = `
  id, company_id, project_id, label, pct, amount, sort_order, status,
  estimate_push_id, invoiced_at, paid_at, tier_origin, created_at, updated_at
`

type MilestoneRow = {
  id: string
  company_id: string
  project_id: string
  label: string
  pct: string | null
  amount: string | null
  sort_order: number
  status: MilestoneStatus
  estimate_push_id: string | null
  invoiced_at: string | null
  paid_at: string | null
  tier_origin: string | null
  created_at: string
  updated_at: string
}

type Milestone = {
  id: string
  company_id: string
  project_id: string
  label: string
  pct: number | null
  amount: number | null
  sort_order: number
  status: MilestoneStatus
  estimate_push_id: string | null
  invoiced_at: string | null
  paid_at: string | null
  tier_origin: string | null
  created_at: string
  updated_at: string
}

function rowToMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    company_id: row.company_id,
    project_id: row.project_id,
    label: row.label,
    pct: row.pct === null ? null : Number(row.pct),
    amount: row.amount === null ? null : Number(row.amount),
    sort_order: row.sort_order,
    status: row.status,
    estimate_push_id: row.estimate_push_id,
    invoiced_at: row.invoiced_at,
    paid_at: row.paid_at,
    tier_origin: row.tier_origin,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function isMilestoneStatus(value: unknown): value is MilestoneStatus {
  return typeof value === 'string' && (MILESTONE_STATUSES as readonly string[]).includes(value)
}

/** One milestone definition off a create request. `status` defaults to not_yet. */
type MilestoneInput = {
  label: string
  pct: number | null
  amount: number | null
  sort_order: number
  status: MilestoneStatus
  estimate_push_id: string | null
}

function parseOptionalMoney(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Coerce one milestone definition off a request entry. Returns null when the
 * entry is structurally invalid (missing/blank label or non-object).
 */
function coerceMilestoneInput(raw: unknown, fallbackSort: number): MilestoneInput | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  const label = typeof obj.label === 'string' ? obj.label.trim() : ''
  if (!label) return null
  const sortRaw = Number(obj.sort_order)
  const sortOrder = Number.isFinite(sortRaw) ? Math.trunc(sortRaw) : fallbackSort
  const status = isMilestoneStatus(obj.status) ? obj.status : 'not_yet'
  const estimatePushId =
    typeof obj.estimate_push_id === 'string' && isValidUuid(obj.estimate_push_id) ? obj.estimate_push_id : null
  return {
    label,
    pct: parseOptionalMoney(obj.pct),
    amount: parseOptionalMoney(obj.amount),
    sort_order: sortOrder,
    status,
    estimate_push_id: estimatePushId,
  }
}

/**
 * Default deposit / progress / final ladder. Percentages mirror the prior
 * invoice-quick.tsx stub (30 / 50 / 20). When a `contractValue` is supplied
 * the amounts are derived; otherwise amounts stay null and the UI can prompt.
 */
function defaultLadder(contractValue: number | null): MilestoneInput[] {
  const amountFor = (pct: number): number | null =>
    contractValue !== null && Number.isFinite(contractValue) ? Math.round((contractValue * pct) / 100) : null
  return [
    {
      label: 'Deposit · 30%',
      pct: 30,
      amount: amountFor(30),
      sort_order: 0,
      status: 'not_yet',
      estimate_push_id: null,
    },
    {
      label: 'Progress · 50%',
      pct: 50,
      amount: amountFor(50),
      sort_order: 1,
      status: 'not_yet',
      estimate_push_id: null,
    },
    { label: 'Final · 20%', pct: 20, amount: amountFor(20), sort_order: 2, status: 'not_yet', estimate_push_id: null },
  ]
}

/**
 * Project billing-milestone routes (104_project_billing_milestones.sql):
 *   GET   /api/projects/:id/billing-milestones   list a project's milestones (ladder order)
 *   POST  /api/projects/:id/billing-milestones   create one milestone, an explicit set,
 *                                                 or (default) seed a deposit/progress/final ladder
 *   PATCH /api/billing-milestones/:id             manual status transition + field edits
 *                                                 (mark invoiced / mark paid stamps invoiced_at/paid_at)
 *
 * Additive tracking layer ALONGSIDE estimate_push (routes/estimate-pushes.ts);
 * status is set MANUALLY — there is NO QBO payment-webhook auto-detection.
 *
 * AR-HONESTY (audit ITEM 3 / gap "AR milestone free-form toggle"): the
 * `invoiced` / `paid` status here is a MANUAL operator assertion, NOT a
 * QBO-confirmed fact. A real reconciliation would consume an inbound QBO
 * Payment webhook (`mapQboEntityType('Payment') === 'payment'` is now mapped,
 * so the sync_events audit row lands) and reconcile `paid_at` from QBO truth —
 * but that worker does not exist yet (see the sized follow-up note below). To
 * keep the data honest until then, every manual mark-invoiced / mark-paid
 * transition stamps `realized_source: 'manual'` on its audit row so a
 * downstream reader can never mistake a hand-flipped toggle for a
 * QBO-reconciled payment.
 *
 * SIZED FOLLOW-UP — real QBO Payment reconciliation (deferred, ~1–2 days):
 *   1. add an inbound-`sync_events` consumer worker (no such consumer exists
 *      today — the webhook only RECORDS pending rows);
 *   2. for each `entity_type='payment'` row, fetch the Payment from QBO
 *      (Payment.Line[].LinkedTxn → Invoice), resolve the Invoice → milestone
 *      via integration_mappings / estimate_push_id;
 *   3. reconcile the milestone to `paid` with `realized_source='qbo'` +
 *      `paid_at` from QBO, idempotently (sync_events dedupe);
 *   4. optionally add a `realized_source` column (separate migration) so the
 *      provenance is queryable, not only in the audit log.
 */
export async function handleProjectBillingMilestoneRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: ProjectBillingMilestoneRouteCtx,
): Promise<boolean> {
  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/billing-milestones$/)

  // --- list for a project -------------------------------------------------
  if (projectMatch && req.method === 'GET') {
    if (!ctx.requireRole(['admin', 'foreman', 'office', 'member'])) return true
    const projectId = projectMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const rows = await withCompanyClient(ctx.company.id, (c) =>
      c.query<MilestoneRow>(
        `select ${MILESTONE_COLUMNS} from project_billing_milestones
         where company_id = $1 and project_id = $2
         order by sort_order asc, created_at asc`,
        [ctx.company.id, projectId],
      ),
    )
    ctx.sendJson(200, { billing_milestones: rows.rows.map(rowToMilestone) })
    return true
  }

  // --- create one / a set / the default ladder ----------------------------
  if (projectMatch && req.method === 'POST') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const projectId = projectMatch[1]!
    if (!isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const parsedBody = parseJsonBody(MilestoneCreateBodySchema, await ctx.readBody())
    if (!parsedBody.ok) {
      ctx.sendJson(400, { error: parsedBody.error })
      return true
    }
    const body = parsedBody.value

    // Resolve the milestone set to insert. Precedence:
    //   1. body.milestones[] — explicit set
    //   2. body.label present — single milestone
    //   3. otherwise — seed the default deposit/progress/final ladder,
    //      deriving amounts from body.contract_value when supplied.
    let inputs: MilestoneInput[]
    if (Array.isArray(body.milestones)) {
      const coerced: MilestoneInput[] = []
      for (let i = 0; i < body.milestones.length; i++) {
        const one = coerceMilestoneInput(body.milestones[i], i)
        if (!one) {
          ctx.sendJson(400, { error: `milestones[${i}] requires a non-empty label` })
          return true
        }
        coerced.push(one)
      }
      if (coerced.length === 0) {
        ctx.sendJson(400, { error: 'milestones must be a non-empty array' })
        return true
      }
      inputs = coerced
    } else if (typeof body.label === 'string' && body.label.trim()) {
      const one = coerceMilestoneInput(body, 0)
      if (!one) {
        ctx.sendJson(400, { error: 'label must be a non-empty string' })
        return true
      }
      inputs = [one]
    } else {
      inputs = defaultLadder(parseOptionalMoney(body.contract_value))
    }

    try {
      const created = await withMutationTx(async (client: PoolClient) => {
        const proj = await client.query<{ id: string }>(
          `select id from projects where company_id = $1 and id = $2 and deleted_at is null limit 1`,
          [ctx.company.id, projectId],
        )
        if (!proj.rows[0]) return { kind: 'not_found' as const }

        const rows: MilestoneRow[] = []
        for (const m of inputs) {
          const inserted = await client.query<MilestoneRow>(
            `insert into project_billing_milestones
               (company_id, project_id, label, pct, amount, sort_order, status, estimate_push_id,
                invoiced_at, paid_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8,
                     case when $7 = 'not_yet' then null else now() end,
                     case when $7 = 'paid' then now() else null end)
             returning ${MILESTONE_COLUMNS}`,
            [ctx.company.id, projectId, m.label, m.pct, m.amount, m.sort_order, m.status, m.estimate_push_id],
          )
          rows.push(inserted.rows[0]!)
        }

        await recordAudit(client, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          action: 'project_billing_milestone.created',
          entityType: 'project_billing_milestone',
          entityId: projectId,
          after: { project_id: projectId, count: rows.length, labels: rows.map((r) => r.label) },
        })
        return { kind: 'ok' as const, rows }
      })
      if (created.kind === 'not_found') {
        ctx.sendJson(404, { error: 'project not found' })
        return true
      }
      ctx.sendJson(201, { billing_milestones: created.rows.map(rowToMilestone) })
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to create billing milestones' })
    }
    return true
  }

  // --- patch one milestone (manual status transition + field edits) -------
  const detailMatch = url.pathname.match(/^\/api\/billing-milestones\/([^/]+)$/)
  if (detailMatch && req.method === 'PATCH') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const parsedPatch = parseJsonBody(MilestonePatchBodySchema, await ctx.readBody())
    if (!parsedPatch.ok) {
      ctx.sendJson(400, { error: parsedPatch.error })
      return true
    }
    const body = parsedPatch.value

    // Build the SET clause from the supplied fields. `status` drives the
    // invoiced_at / paid_at stamping (manual mark-invoiced / mark-paid).
    const sets: string[] = []
    const params: unknown[] = [ctx.company.id, id]
    let nextStatus: MilestoneStatus | null = null

    if (body.status !== undefined) {
      if (!isMilestoneStatus(body.status)) {
        ctx.sendJson(400, { error: `status must be one of: ${MILESTONE_STATUSES.join(', ')}` })
        return true
      }
      nextStatus = body.status
      params.push(nextStatus)
      sets.push(`status = $${params.length}`)
      // Stamp invoiced_at the first time it reaches invoiced/paid; stamp
      // paid_at on paid; clear both when reset to not_yet. coalesce keeps an
      // existing earlier stamp rather than overwriting it on a re-mark.
      if (nextStatus === 'not_yet') {
        sets.push('invoiced_at = null', 'paid_at = null')
      } else if (nextStatus === 'invoiced') {
        sets.push('invoiced_at = coalesce(invoiced_at, now())', 'paid_at = null')
      } else {
        // paid
        sets.push('invoiced_at = coalesce(invoiced_at, now())', 'paid_at = coalesce(paid_at, now())')
      }
    }

    if (body.label !== undefined) {
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      if (!label) {
        ctx.sendJson(400, { error: 'label must be a non-empty string' })
        return true
      }
      params.push(label)
      sets.push(`label = $${params.length}`)
    }
    if (body.pct !== undefined) {
      params.push(parseOptionalMoney(body.pct))
      sets.push(`pct = $${params.length}`)
    }
    if (body.amount !== undefined) {
      params.push(parseOptionalMoney(body.amount))
      sets.push(`amount = $${params.length}`)
    }
    if (body.sort_order !== undefined) {
      const sortRaw = Number(body.sort_order)
      if (!Number.isFinite(sortRaw)) {
        ctx.sendJson(400, { error: 'sort_order must be a number' })
        return true
      }
      params.push(Math.trunc(sortRaw))
      sets.push(`sort_order = $${params.length}`)
    }
    if (body.estimate_push_id !== undefined) {
      const pushId = body.estimate_push_id
      if (pushId !== null && !(typeof pushId === 'string' && isValidUuid(pushId))) {
        ctx.sendJson(400, { error: 'estimate_push_id must be a uuid or null' })
        return true
      }
      params.push(pushId === null ? null : pushId)
      sets.push(`estimate_push_id = $${params.length}`)
    }

    if (sets.length === 0) {
      ctx.sendJson(400, { error: 'no updatable fields supplied' })
      return true
    }

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const locked = await client.query<MilestoneRow>(
          `select ${MILESTONE_COLUMNS} from project_billing_milestones
           where company_id = $1 and id = $2 for update`,
          [ctx.company.id, id],
        )
        const current = locked.rows[0]
        if (!current) return { kind: 'not_found' as const }
        const updated = await client.query<MilestoneRow>(
          `update project_billing_milestones set
             ${sets.join(', ')}, updated_at = now()
           where company_id = $1 and id = $2
           returning ${MILESTONE_COLUMNS}`,
          params,
        )
        const row = updated.rows[0]!
        await recordAudit(client, {
          companyId: ctx.company.id,
          actorUserId: ctx.currentUserId,
          action: nextStatus
            ? `project_billing_milestone.${nextStatus === 'not_yet' ? 'reset' : `marked_${nextStatus}`}`
            : 'project_billing_milestone.updated',
          entityType: 'project_billing_milestone',
          entityId: id,
          before: { status: current.status },
          // realized_source='manual' makes the AR realization honest: a
          // mark-invoiced / mark-paid here is an operator assertion, NOT a
          // QBO-confirmed payment. A future QBO Payment reconciler would stamp
          // 'qbo' instead (see the module docstring's sized follow-up).
          after: nextStatus ? { status: row.status, realized_source: 'manual' } : { status: row.status },
        })
        return { kind: 'ok' as const, row }
      })
      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'billing milestone not found' })
        return true
      }
      ctx.sendJson(200, { billing_milestone: rowToMilestone(result.row) })
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'failed to update billing milestone' })
    }
    return true
  }

  return false
}

/**
 * Self-registered dispatch descriptor for the `project-billing-milestones` route (Campaign E:
 * descriptors live in their route module; dispatch.ts imports them). Keep
 * `name`/`order` byte-identical — the conformance gate in dispatch.test.ts
 * locks the assembled table.
 */
export const projectBillingMilestonesRouteDescriptor: DispatchRouteDescriptor = {
  name: 'project-billing-milestones',
  order: 680,
  handle: ({ req, url, pool, company, currentUserId, requireRoleStr, readBody, sendJson }) =>
    handleProjectBillingMilestoneRoutes(req, url, {
      pool,
      company,
      currentUserId,
      requireRole: requireRoleStr,
      readBody,
      sendJson,
    }),
}
