import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  LABOR_PAYROLL_WORKFLOW_NAME,
  LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
  nextLaborPayrollEvents,
  parseLaborPayrollEventRequest,
  transitionLaborPayrollWorkflow,
  type LaborPayrollHumanEventType,
  type LaborPayrollWorkflowEvent,
  type LaborPayrollWorkflowSnapshot,
  type LaborPayrollWorkflowState,
  type WorkflowSnapshot,
} from '@sitelayer/workflows'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, recordWorkflowEvent, withCompanyClient, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { observeAudit, observeWorkflowEvent, workflowEventOutcome } from '../metrics.js'
import { HttpError, isValidDateInput, isValidUuid } from '../http-utils.js'

/**
 * Labor payroll workflow routes.
 *
 * Surface:
 *   GET  /api/labor-payroll-runs                    company-scoped list,
 *                                                   optional ?state=&period_start=
 *   GET  /api/labor-payroll-runs/:id                WorkflowSnapshot
 *   POST /api/labor-payroll-runs                    create from time-review-run id
 *                                                   or directly from period
 *   POST /api/labor-payroll-runs/preview            preview coverage for a period
 *                                                   (locked labor entries in window
 *                                                   not yet on a payroll run)
 *   POST /api/labor-payroll-runs/:id/events         { event, state_version }
 *
 * Mirrors apps/api/src/routes/rental-billing-state.ts in shape so the same
 * UI/replay tooling works without forks.
 *
 * POST_REQUESTED enqueues a stable-keyed mutation_outbox row with
 * mutation_type='post_qbo_time_activities' and idempotency key
 * `labor_payroll_run:post:<run_id>`. The worker drain in
 * apps/worker/src/labor-payroll-push.ts claims those rows, pushes each
 * covered labor_entry as a QBO TimeActivity, and emits POST_SUCCEEDED
 * with the array of QBO ids.
 */

export type LaborPayrollRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

type LaborPayrollRunRow = {
  id: string
  company_id: string
  period_start: string
  period_end: string
  state: LaborPayrollWorkflowState
  state_version: number
  approved_at: string | null
  approved_by_user_id: string | null
  posted_at: string | null
  failed_at: string | null
  error_message: string | null
  qbo_payroll_batch_ref: string[] | null
  covered_labor_entry_ids: string[]
  total_hours: string
  total_cents: string
  time_review_run_id: string | null
  workflow_engine: string
  workflow_run_id: string | null
  version: number
  origin: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

const LABOR_PAYROLL_RUN_COLUMNS = `
  id,
  company_id,
  to_char(period_start, 'YYYY-MM-DD') as period_start,
  to_char(period_end, 'YYYY-MM-DD') as period_end,
  state,
  state_version,
  approved_at,
  approved_by_user_id,
  posted_at,
  failed_at,
  error_message,
  qbo_payroll_batch_ref,
  covered_labor_entry_ids,
  total_hours,
  total_cents,
  time_review_run_id,
  workflow_engine,
  workflow_run_id,
  version,
  origin,
  deleted_at,
  created_at,
  updated_at
`

function rowToSnapshot(row: LaborPayrollRunRow): LaborPayrollWorkflowSnapshot {
  return {
    state: row.state,
    state_version: row.state_version,
    approved_at: row.approved_at,
    approved_by: row.approved_by_user_id,
    posted_at: row.posted_at,
    failed_at: row.failed_at,
    error: row.error_message,
    qbo_timeactivity_ids: row.qbo_payroll_batch_ref,
  }
}

type LaborPayrollWorkflowContext = {
  id: string
  company_id: string
  period_start: string
  period_end: string
  approved_at: string | null
  approved_by_user_id: string | null
  posted_at: string | null
  failed_at: string | null
  error_message: string | null
  qbo_payroll_batch_ref: string[] | null
  covered_labor_entry_ids: string[]
  total_hours: string
  total_cents: string
  time_review_run_id: string | null
  workflow_engine: string
  workflow_run_id: string | null
  created_at: string
  updated_at: string
}

function snapshotResponse(
  row: LaborPayrollRunRow,
): WorkflowSnapshot<LaborPayrollWorkflowState, LaborPayrollHumanEventType, LaborPayrollWorkflowContext> {
  return {
    state: row.state,
    state_version: row.state_version,
    next_events: nextLaborPayrollEvents(row.state),
    context: {
      id: row.id,
      company_id: row.company_id,
      period_start: row.period_start,
      period_end: row.period_end,
      approved_at: row.approved_at,
      approved_by_user_id: row.approved_by_user_id,
      posted_at: row.posted_at,
      failed_at: row.failed_at,
      error_message: row.error_message,
      qbo_payroll_batch_ref: row.qbo_payroll_batch_ref,
      covered_labor_entry_ids: row.covered_labor_entry_ids,
      total_hours: row.total_hours,
      total_cents: row.total_cents,
      time_review_run_id: row.time_review_run_id,
      workflow_engine: row.workflow_engine,
      workflow_run_id: row.workflow_run_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  }
}

function buildReducerEvent(eventType: LaborPayrollHumanEventType, actorUserId: string): LaborPayrollWorkflowEvent {
  const nowIso = new Date().toISOString()
  if (eventType === 'APPROVE') {
    return { type: 'APPROVE', approved_at: nowIso, approved_by: actorUserId }
  }
  if (eventType === 'POST_REQUESTED') {
    return { type: 'POST_REQUESTED' }
  }
  if (eventType === 'RETRY_POST') {
    return { type: 'RETRY_POST' }
  }
  return { type: 'VOID' }
}

type LaborEntryCoverageRow = {
  id: string
  worker_id: string | null
  hours: string
  occurred_on: string
  payroll_run_id: string | null
  review_locked_at: string | null
  base_hourly_cents: number | null
  insurance_pct: string | null
  benefits_pct: string | null
}

/**
 * Resolve the labor_entries that a payroll run covers. The selection rule
 * matches the time-review APPROVE side-effect: only entries that are
 * locked (review_locked_at is not null) AND not yet claimed by another
 * payroll run (payroll_run_id is null) are eligible.
 *
 * Joins workers to surface the burden multipliers; the loaded-cost
 * computation is straight burden math (no overtime split here — Phase 1
 * payroll batches don't separate straight-vs-OT, that lands later).
 */
async function fetchEligibleLaborEntries(
  client: Pool | PoolClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<LaborEntryCoverageRow[]> {
  const result = await client.query<LaborEntryCoverageRow>(
    `select le.id,
            le.worker_id,
            le.hours,
            to_char(le.occurred_on, 'YYYY-MM-DD') as occurred_on,
            le.payroll_run_id,
            le.review_locked_at,
            w.base_hourly_cents,
            w.insurance_pct,
            w.benefits_pct
       from labor_entries le
       left join workers w on w.id = le.worker_id and w.company_id = le.company_id
      where le.company_id = $1
        and le.deleted_at is null
        and le.review_locked_at is not null
        and le.payroll_run_id is null
        and le.occurred_on between $2::date and $3::date`,
    [companyId, periodStart, periodEnd],
  )
  return result.rows
}

function computeCoverageTotals(rows: LaborEntryCoverageRow[]): {
  ids: string[]
  totalHours: string
  totalCents: string
} {
  const ids = rows.map((r) => r.id)
  const totalHoursNum = rows.reduce((sum, r) => sum + Number(r.hours || 0), 0)
  // Loaded burden = base_hourly_cents * hours * (1 + insurance_pct/100 + benefits_pct/100)
  // No OT split here — Phase 1 payroll batches treat all hours straight.
  let totalCents = 0
  for (const r of rows) {
    const base = Number(r.base_hourly_cents || 0)
    const insurance = Number(r.insurance_pct || 0)
    const benefits = Number(r.benefits_pct || 0)
    const hours = Number(r.hours || 0)
    const loaded = base * (1 + insurance / 100 + benefits / 100)
    totalCents += Math.round(loaded * hours)
  }
  return {
    ids,
    totalHours: totalHoursNum.toFixed(2),
    totalCents: String(totalCents),
  }
}

export async function handleLaborPayrollRunRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: LaborPayrollRouteCtx,
): Promise<boolean> {
  // -------------------------------------------------------------------------
  // GET /api/labor-payroll-runs?state=&period_start=
  // -------------------------------------------------------------------------
  if (req.method === 'GET' && url.pathname === '/api/labor-payroll-runs') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const stateFilter = String(url.searchParams.get('state') ?? '').trim()
    const periodStart = String(url.searchParams.get('period_start') ?? '').trim()
    const allowedStates: LaborPayrollWorkflowState[] = [
      'generated',
      'approved',
      'posting',
      'posted',
      'failed',
      'voided',
    ]
    if (stateFilter && !allowedStates.includes(stateFilter as LaborPayrollWorkflowState)) {
      ctx.sendJson(400, { error: 'state must be one of generated|approved|posting|posted|failed|voided' })
      return true
    }
    if (periodStart && !isValidDateInput(periodStart)) {
      ctx.sendJson(400, { error: 'period_start must be YYYY-MM-DD' })
      return true
    }
    const params: unknown[] = [ctx.company.id]
    let where = `company_id = $1 and deleted_at is null`
    if (stateFilter) {
      params.push(stateFilter)
      where += ` and state = $${params.length}`
    }
    if (periodStart) {
      params.push(periodStart)
      where += ` and period_start = $${params.length}::date`
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<LaborPayrollRunRow>(
        `select ${LABOR_PAYROLL_RUN_COLUMNS}
       from labor_payroll_runs
       where ${where}
       order by period_end desc, created_at desc
       limit 200`,
        params,
      ),
    )
    ctx.sendJson(200, { laborPayrollRuns: result.rows })
    return true
  }

  // -------------------------------------------------------------------------
  // POST /api/labor-payroll-runs/preview?period_start=&period_end=
  // Returns the labor_entries that would be claimed by a new run for the
  // window without actually creating one. Useful for the review surface.
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/labor-payroll-runs/preview') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const periodStart = String(url.searchParams.get('period_start') ?? '').trim()
    const periodEnd = String(url.searchParams.get('period_end') ?? '').trim()
    if (!isValidDateInput(periodStart) || !isValidDateInput(periodEnd)) {
      ctx.sendJson(400, { error: 'period_start and period_end are required (YYYY-MM-DD)' })
      return true
    }
    if (periodEnd < periodStart) {
      ctx.sendJson(400, { error: 'period_end must be >= period_start' })
      return true
    }
    const rows = await fetchEligibleLaborEntries(ctx.pool, ctx.company.id, periodStart, periodEnd)
    const totals = computeCoverageTotals(rows)
    ctx.sendJson(200, {
      period_start: periodStart,
      period_end: periodEnd,
      covered_labor_entry_ids: totals.ids,
      total_entries: rows.length,
      total_hours: totals.totalHours,
      total_cents: totals.totalCents,
      labor_entries: rows.map((r) => ({
        id: r.id,
        worker_id: r.worker_id,
        hours: r.hours,
        occurred_on: r.occurred_on,
      })),
    })
    return true
  }

  // -------------------------------------------------------------------------
  // GET /api/labor-payroll-runs/:id → WorkflowSnapshot
  // -------------------------------------------------------------------------
  const detailMatch = url.pathname.match(/^\/api\/labor-payroll-runs\/([^/]+)$/)
  if (req.method === 'GET' && detailMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const result = await withCompanyClient(ctx.company.id, (c) =>
      c.query<LaborPayrollRunRow>(
        `select ${LABOR_PAYROLL_RUN_COLUMNS}
       from labor_payroll_runs
       where company_id = $1 and id = $2 and deleted_at is null
       limit 1`,
        [ctx.company.id, id],
      ),
    )
    const row = result.rows[0]
    if (!row) {
      ctx.sendJson(404, { error: 'labor payroll run not found' })
      return true
    }
    ctx.sendJson(200, snapshotResponse(row))
    return true
  }

  // -------------------------------------------------------------------------
  // POST /api/labor-payroll-runs
  // Body: { period_start, period_end, time_review_run_id? }
  // Creates a new labor_payroll_run row in 'generated' state, claims the
  // eligible labor_entries by stamping payroll_run_id on each. One batch
  // per (company_id, period_start, period_end) — duplicates 409.
  // -------------------------------------------------------------------------
  if (req.method === 'POST' && url.pathname === '/api/labor-payroll-runs') {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const body = await ctx.readBody()
    const periodStart = typeof body.period_start === 'string' ? body.period_start.trim() : ''
    const periodEnd = typeof body.period_end === 'string' ? body.period_end.trim() : ''
    const timeReviewRunId =
      typeof body.time_review_run_id === 'string' && body.time_review_run_id.trim()
        ? body.time_review_run_id.trim()
        : null
    if (!isValidDateInput(periodStart) || !isValidDateInput(periodEnd)) {
      ctx.sendJson(400, { error: 'period_start and period_end are required (YYYY-MM-DD)' })
      return true
    }
    if (periodEnd < periodStart) {
      ctx.sendJson(400, { error: 'period_end must be >= period_start' })
      return true
    }
    if (timeReviewRunId !== null && !isValidUuid(timeReviewRunId)) {
      ctx.sendJson(400, { error: 'time_review_run_id must be a valid uuid' })
      return true
    }

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        // Refuse duplicates — the unique (company_id, period_start, period_end)
        // constraint would catch this at insert time, but checking up front
        // gives a clearer error.
        const existing = await client.query<{ id: string }>(
          `select id from labor_payroll_runs
           where company_id = $1 and period_start = $2::date and period_end = $3::date
             and deleted_at is null
           limit 1`,
          [ctx.company.id, periodStart, periodEnd],
        )
        if (existing.rows[0]) {
          return { kind: 'conflict' as const, runId: existing.rows[0].id }
        }

        const eligible = await fetchEligibleLaborEntries(client, ctx.company.id, periodStart, periodEnd)
        if (eligible.length === 0) {
          return { kind: 'no_entries' as const }
        }
        const totals = computeCoverageTotals(eligible)

        const insert = await client.query<LaborPayrollRunRow>(
          `insert into labor_payroll_runs (
             company_id, period_start, period_end,
             covered_labor_entry_ids, total_hours, total_cents,
             time_review_run_id
           )
           values ($1, $2::date, $3::date, $4::uuid[], $5, $6, $7)
           returning ${LABOR_PAYROLL_RUN_COLUMNS}`,
          [ctx.company.id, periodStart, periodEnd, totals.ids, totals.totalHours, totals.totalCents, timeReviewRunId],
        )
        const created = insert.rows[0]
        if (!created) throw new HttpError(500, 'labor payroll run insert returned no row')

        // Claim the labor entries by stamping payroll_run_id. Filtered on
        // payroll_run_id IS NULL so a concurrent batch can't double-claim.
        if (totals.ids.length > 0) {
          await client.query(
            `update labor_entries
               set payroll_run_id = $2
             where company_id = $1
               and id = any($3::uuid[])
               and payroll_run_id is null`,
            [ctx.company.id, created.id, totals.ids],
          )
        }

        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'labor_payroll_run',
          entityId: created.id,
          action: 'create',
          row: created,
          actorUserId: ctx.currentUserId,
        })
        return { kind: 'ok' as const, row: created }
      })

      if (result.kind === 'conflict') {
        ctx.sendJson(409, {
          error: 'a labor payroll run already exists for this period',
          existing_run_id: result.runId,
        })
        return true
      }
      if (result.kind === 'no_entries') {
        ctx.sendJson(400, {
          error: 'no eligible labor entries in this window — entries must be locked by an approved time review',
        })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'labor_payroll_run',
        entityId: result.row.id,
        action: 'create',
        after: result.row,
      })
      observeAudit('labor_payroll_run', 'create')
      ctx.sendJson(201, snapshotResponse(result.row))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  // -------------------------------------------------------------------------
  // POST /api/labor-payroll-runs/:id/events
  // -------------------------------------------------------------------------
  const eventMatch = url.pathname.match(/^\/api\/labor-payroll-runs\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventMatch) {
    if (!ctx.requireRole(['admin', 'office'])) return true
    const id = eventMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const parsed = parseLaborPayrollEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion } = parsed.value

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const lockedResult = await client.query<LaborPayrollRunRow>(
          `select ${LABOR_PAYROLL_RUN_COLUMNS}
           from labor_payroll_runs
           where company_id = $1 and id = $2 and deleted_at is null
           for update`,
          [ctx.company.id, id],
        )
        const current = lockedResult.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.state_version !== stateVersion) {
          return { kind: 'version_conflict' as const, run: current }
        }

        const reducerEvent = buildReducerEvent(eventType as LaborPayrollHumanEventType, ctx.currentUserId)
        let nextSnapshot: LaborPayrollWorkflowSnapshot
        try {
          nextSnapshot = transitionLaborPayrollWorkflow(rowToSnapshot(current), reducerEvent)
        } catch (err) {
          return {
            kind: 'illegal_transition' as const,
            run: current,
            message: err instanceof Error ? err.message : String(err),
          }
        }

        const updateResult = await client.query<LaborPayrollRunRow>(
          `update labor_payroll_runs
             set state = $3,
                 state_version = $4,
                 approved_at = $5,
                 approved_by_user_id = $6,
                 posted_at = $7,
                 failed_at = $8,
                 error_message = $9,
                 qbo_payroll_batch_ref = $10::jsonb,
                 version = version + 1,
                 updated_at = now()
           where company_id = $1 and id = $2
           returning ${LABOR_PAYROLL_RUN_COLUMNS}`,
          [
            ctx.company.id,
            id,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.approved_at ?? null,
            nextSnapshot.approved_by ?? null,
            nextSnapshot.posted_at ?? null,
            nextSnapshot.failed_at ?? null,
            nextSnapshot.error ?? null,
            nextSnapshot.qbo_timeactivity_ids ? JSON.stringify(nextSnapshot.qbo_timeactivity_ids) : null,
          ],
        )
        const updated = updateResult.rows[0]
        if (!updated) throw new HttpError(500, 'labor payroll run update returned no row')

        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: LABOR_PAYROLL_WORKFLOW_NAME,
          schemaVersion: LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
          entityType: 'labor_payroll_run',
          entityId: updated.id,
          stateVersion,
          eventType,
          eventPayload: reducerEvent,
          snapshotAfter: nextSnapshot,
          actorUserId: ctx.currentUserId,
        })
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'labor_payroll_run',
          entityId: updated.id,
          action: `event:${eventType.toLowerCase()}`,
          row: updated,
          idempotencyKey: `labor_payroll_run:event:${updated.id}:${updated.state_version}`,
        })

        // POST_REQUESTED: enqueue the QBO push outbox row. Per-run idempotency
        // key (NOT per-state_version) so a RETRY_POST → POST_REQUESTED replay
        // lands on the same row and 'on conflict do update' resets it to
        // pending without creating duplicate work.
        if (eventType === 'POST_REQUESTED') {
          await recordMutationLedger(client, {
            companyId: ctx.company.id,
            entityType: 'labor_payroll_run',
            entityId: updated.id,
            action: 'post_qbo_time_activities',
            mutationType: 'post_qbo_time_activities',
            row: updated,
            outboxPayload: {
              labor_payroll_run_id: updated.id,
              period_start: updated.period_start,
              period_end: updated.period_end,
              covered_labor_entry_ids: updated.covered_labor_entry_ids,
              total_hours: updated.total_hours,
              total_cents: updated.total_cents,
            },
            idempotencyKey: `labor_payroll_run:post:${updated.id}`,
          })
        }

        return { kind: 'ok' as const, run: updated, eventType }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'labor payroll run not found' })
        return true
      }
      if (result.kind === 'version_conflict') {
        ctx.sendJson(409, {
          error: 'state_version mismatch — reload and retry',
          snapshot: snapshotResponse(result.run),
        })
        return true
      }
      if (result.kind === 'illegal_transition') {
        ctx.sendJson(409, {
          error: result.message,
          snapshot: snapshotResponse(result.run),
        })
        return true
      }

      await recordAudit(ctx.pool, {
        companyId: ctx.company.id,
        actorUserId: ctx.currentUserId,
        entityType: 'labor_payroll_run',
        entityId: result.run.id,
        action: `event:${result.eventType.toLowerCase()}`,
        after: result.run,
      })
      observeAudit('labor_payroll_run', `event:${result.eventType.toLowerCase()}`)
      const outcome = workflowEventOutcome(result.eventType)
      if (outcome) observeWorkflowEvent(LABOR_PAYROLL_WORKFLOW_NAME, outcome)
      ctx.sendJson(200, snapshotResponse(result.run))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  return false
}
