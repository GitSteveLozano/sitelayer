import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import {
  parseTimeReviewEventRequest,
  TIME_REVIEW_WORKFLOW_NAME,
  TIME_REVIEW_WORKFLOW_SCHEMA_VERSION,
  transitionTimeReviewWorkflow,
  type TimeReviewHumanEventType,
  type TimeReviewWorkflowEvent,
  type TimeReviewWorkflowSnapshot,
  type TimeReviewWorkflowState,
} from '@sitelayer/workflows'
import type { ActiveCompany, CompanyRole } from '../auth-types.js'
import { recordMutationLedger, recordWorkflowEvent, withMutationTx } from '../mutation-tx.js'
import { recordAudit } from '../audit.js'
import { observeAudit } from '../metrics.js'
import { isValidDateInput, isValidUuid } from '../http-utils.js'

export type TimeReviewRouteCtx = {
  pool: Pool
  company: ActiveCompany
  currentUserId: string
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
}

const TIME_REVIEW_RUN_COLUMNS = `
  id, company_id, project_id, period_start, period_end,
  state, state_version,
  covered_entry_ids, total_hours, total_entries, anomaly_count,
  reviewer_user_id, approved_at, rejected_at, rejection_reason, reopened_at,
  workflow_engine, workflow_run_id,
  origin, created_at, updated_at
`

type TimeReviewRunRow = {
  id: string
  company_id: string
  project_id: string | null
  period_start: string
  period_end: string
  state: TimeReviewWorkflowState
  state_version: number
  covered_entry_ids: string[]
  total_hours: string
  total_entries: number
  anomaly_count: number
  reviewer_user_id: string | null
  approved_at: string | null
  rejected_at: string | null
  rejection_reason: string | null
  reopened_at: string | null
  workflow_engine: string
  workflow_run_id: string | null
  origin: string | null
  created_at: string
  updated_at: string
}

function rowToSnapshot(row: TimeReviewRunRow): TimeReviewWorkflowSnapshot {
  return {
    state: row.state,
    state_version: row.state_version,
    reviewer_user_id: row.reviewer_user_id,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
    rejection_reason: row.rejection_reason,
    reopened_at: row.reopened_at,
  }
}

function snapshotResponse(row: TimeReviewRunRow): {
  state: TimeReviewWorkflowState
  state_version: number
  context: Omit<TimeReviewRunRow, 'state' | 'state_version'>
  next_events: ReturnType<typeof workflowNextEvents>
} {
  return {
    state: row.state,
    state_version: row.state_version,
    context: {
      id: row.id,
      company_id: row.company_id,
      project_id: row.project_id,
      period_start: row.period_start,
      period_end: row.period_end,
      covered_entry_ids: row.covered_entry_ids,
      total_hours: row.total_hours,
      total_entries: row.total_entries,
      anomaly_count: row.anomaly_count,
      reviewer_user_id: row.reviewer_user_id,
      approved_at: row.approved_at,
      rejected_at: row.rejected_at,
      rejection_reason: row.rejection_reason,
      reopened_at: row.reopened_at,
      workflow_engine: row.workflow_engine,
      workflow_run_id: row.workflow_run_id,
      origin: row.origin,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    next_events: workflowNextEvents(row.state),
  }
}

// Local copy of the next-events derivation so the response shape lives
// alongside this module. Workflow package owns the canonical list; this
// is just the wire projection.
function workflowNextEvents(state: TimeReviewWorkflowState): Array<{ type: string; label: string }> {
  switch (state) {
    case 'pending':
      return [
        { type: 'APPROVE', label: 'Approve run' },
        { type: 'REJECT', label: 'Reject — needs corrections' },
      ]
    case 'approved':
      return [{ type: 'REOPEN', label: 'Reopen for correction' }]
    case 'rejected':
      return [{ type: 'REOPEN', label: 'Reopen' }]
  }
}

function buildReducerEvent(
  eventType: TimeReviewHumanEventType,
  actorUserId: string,
  reason: string | undefined,
): TimeReviewWorkflowEvent {
  const nowIso = new Date().toISOString()
  if (eventType === 'APPROVE') {
    return { type: 'APPROVE', approved_at: nowIso, reviewer_user_id: actorUserId }
  }
  if (eventType === 'REJECT') {
    return { type: 'REJECT', rejected_at: nowIso, reviewer_user_id: actorUserId, reason: reason ?? '' }
  }
  return { type: 'REOPEN', reopened_at: nowIso, reviewer_user_id: actorUserId, reason: reason ?? '' }
}

/**
 * Time review run routes (Sitemap.html § t-approve).
 *
 * - GET  /api/time-review-runs?state&project_id&from&to
 * - GET  /api/time-review-runs/:id              WorkflowSnapshot
 * - POST /api/time-review-runs                  create from period; computes
 *                                               covered_entry_ids + totals
 *                                               + simple anomaly_count
 * - POST /api/time-review-runs/:id/events       { event, state_version, reason? }
 *
 * APPROVE emits a `lock_labor_entries` outbox row keyed on
 * `time_review:lock:<run_id>:<state_version>`. The worker drains it
 * (Phase 1B handler in @sitelayer/queue) and stamps review_locked_at +
 * review_run_id on every uuid in covered_entry_ids.
 *
 * REOPEN emits a sibling outbox row with action='unlock' so the entries
 * become editable again. Re-locking on a subsequent APPROVE produces a
 * new state_version, so a new outbox key, so the lock fires fresh.
 */
export async function handleTimeReviewRunRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: TimeReviewRouteCtx,
): Promise<boolean> {
  if (req.method === 'GET' && url.pathname === '/api/time-review-runs') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const stateFilter = String(url.searchParams.get('state') ?? '').trim()
    const projectId = String(url.searchParams.get('project_id') ?? '').trim()
    const from = String(url.searchParams.get('from') ?? '').trim()
    const to = String(url.searchParams.get('to') ?? '').trim()
    if (stateFilter && stateFilter !== 'pending' && stateFilter !== 'approved' && stateFilter !== 'rejected') {
      ctx.sendJson(400, { error: 'state must be pending|approved|rejected' })
      return true
    }
    if (projectId && !isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project_id must be a valid uuid' })
      return true
    }
    if (from && !isValidDateInput(from)) {
      ctx.sendJson(400, { error: 'from must be YYYY-MM-DD' })
      return true
    }
    if (to && !isValidDateInput(to)) {
      ctx.sendJson(400, { error: 'to must be YYYY-MM-DD' })
      return true
    }
    const result = await ctx.pool.query<TimeReviewRunRow>(
      `select ${TIME_REVIEW_RUN_COLUMNS}
       from time_review_runs
       where company_id = $1
         and ($2 = '' or state = $2)
         and ($3 = '' or project_id = $3::uuid)
         and ($4 = '' or period_start >= $4::date)
         and ($5 = '' or period_end   <= $5::date)
       order by period_start desc, created_at desc
       limit 200`,
      [ctx.company.id, stateFilter, projectId, from, to],
    )
    ctx.sendJson(200, { timeReviewRuns: result.rows })
    return true
  }

  const detailMatch = url.pathname.match(/^\/api\/time-review-runs\/([^/]+)$/)
  if (req.method === 'GET' && detailMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = detailMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const result = await ctx.pool.query<TimeReviewRunRow>(
      `select ${TIME_REVIEW_RUN_COLUMNS}
       from time_review_runs
       where company_id = $1 and id = $2
       limit 1`,
      [ctx.company.id, id],
    )
    if (!result.rows[0]) {
      ctx.sendJson(404, { error: 'time review run not found' })
      return true
    }
    ctx.sendJson(200, snapshotResponse(result.rows[0]))
    return true
  }

  if (req.method === 'POST' && url.pathname === '/api/time-review-runs') {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const body = await ctx.readBody()
    const periodStart = typeof body.period_start === 'string' ? body.period_start.trim() : ''
    const periodEnd = typeof body.period_end === 'string' ? body.period_end.trim() : ''
    if (!isValidDateInput(periodStart) || !isValidDateInput(periodEnd)) {
      ctx.sendJson(400, { error: 'period_start and period_end are required (YYYY-MM-DD)' })
      return true
    }
    if (periodEnd < periodStart) {
      ctx.sendJson(400, { error: 'period_end must be >= period_start' })
      return true
    }
    const projectId = typeof body.project_id === 'string' && body.project_id.trim() ? body.project_id.trim() : null
    if (projectId !== null && !isValidUuid(projectId)) {
      ctx.sendJson(400, { error: 'project_id must be a valid uuid' })
      return true
    }

    // Pull the labor_entries the run will cover. Locked entries are skipped
    // because they're already part of an approved run. Phase 1A's anomaly
    // model is intentionally simple — single hours-over-eight signal — so
    // the column has a meaningful default before the cohort model lands
    // in Phase 5.
    const entryRows = await ctx.pool.query<{ id: string; hours: string; over_eight: boolean }>(
      `select id, hours, (hours::numeric > 8) as over_eight
       from labor_entries
       where company_id = $1
         and deleted_at is null
         and review_locked_at is null
         and ($2 = '' or project_id = $2::uuid)
         and occurred_on between $3::date and $4::date`,
      [ctx.company.id, projectId ?? '', periodStart, periodEnd],
    )

    const coveredEntryIds = entryRows.rows.map((r) => r.id)
    const totalEntries = entryRows.rows.length
    const totalHours = entryRows.rows
      .reduce((sum, r) => sum + Number(r.hours || 0), 0)
      .toFixed(2)
    const anomalyCount = entryRows.rows.filter((r) => r.over_eight).length

    const created = await withMutationTx(async (client: PoolClient) => {
      const insert = await client.query<TimeReviewRunRow>(
        `insert into time_review_runs (
           company_id, project_id, period_start, period_end,
           covered_entry_ids, total_hours, total_entries, anomaly_count
         )
         values ($1, $2, $3, $4, $5::uuid[], $6, $7, $8)
         returning ${TIME_REVIEW_RUN_COLUMNS}`,
        [
          ctx.company.id,
          projectId,
          periodStart,
          periodEnd,
          coveredEntryIds,
          totalHours,
          totalEntries,
          anomalyCount,
        ],
      )
      const row = insert.rows[0]!
      await recordMutationLedger(client, {
        companyId: ctx.company.id,
        entityType: 'time_review_run',
        entityId: row.id,
        action: 'create',
        row: row as unknown as Record<string, unknown>,
        actorUserId: ctx.currentUserId,
      })
      return row
    })

    ctx.sendJson(201, snapshotResponse(created))
    return true
  }

  const eventMatch = url.pathname.match(/^\/api\/time-review-runs\/([^/]+)\/events$/)
  if (req.method === 'POST' && eventMatch) {
    if (!ctx.requireRole(['admin', 'foreman', 'office'])) return true
    const id = eventMatch[1]!
    if (!isValidUuid(id)) {
      ctx.sendJson(400, { error: 'id must be a valid uuid' })
      return true
    }
    const body = await ctx.readBody()
    const parsed = parseTimeReviewEventRequest(body)
    if (!parsed.ok) {
      ctx.sendJson(400, { error: parsed.error })
      return true
    }
    const { event: eventType, state_version: stateVersion, reason } = parsed.value

    try {
      const result = await withMutationTx(async (client: PoolClient) => {
        const lockedResult = await client.query<TimeReviewRunRow>(
          `select ${TIME_REVIEW_RUN_COLUMNS}
           from time_review_runs
           where company_id = $1 and id = $2
           for update`,
          [ctx.company.id, id],
        )
        const current = lockedResult.rows[0]
        if (!current) return { kind: 'not_found' as const }
        if (current.state_version !== stateVersion) {
          return { kind: 'version_conflict' as const, run: current }
        }

        const reducerEvent = buildReducerEvent(eventType as TimeReviewHumanEventType, ctx.currentUserId, reason)
        let nextSnapshot: TimeReviewWorkflowSnapshot
        try {
          nextSnapshot = transitionTimeReviewWorkflow(rowToSnapshot(current), reducerEvent)
        } catch (err) {
          return {
            kind: 'illegal_transition' as const,
            run: current,
            message: err instanceof Error ? err.message : String(err),
          }
        }

        const updateResult = await client.query<TimeReviewRunRow>(
          `update time_review_runs
             set state = $3,
                 state_version = $4,
                 reviewer_user_id = $5,
                 approved_at = $6,
                 rejected_at = $7,
                 rejection_reason = $8,
                 reopened_at = $9,
                 updated_at = now()
           where company_id = $1 and id = $2
           returning ${TIME_REVIEW_RUN_COLUMNS}`,
          [
            ctx.company.id,
            id,
            nextSnapshot.state,
            nextSnapshot.state_version,
            nextSnapshot.reviewer_user_id ?? null,
            nextSnapshot.approved_at ?? null,
            nextSnapshot.rejected_at ?? null,
            nextSnapshot.rejection_reason ?? null,
            nextSnapshot.reopened_at ?? null,
          ],
        )
        const updated = updateResult.rows[0]!

        await recordWorkflowEvent(client, {
          companyId: ctx.company.id,
          workflowName: TIME_REVIEW_WORKFLOW_NAME,
          schemaVersion: TIME_REVIEW_WORKFLOW_SCHEMA_VERSION,
          entityType: 'time_review_run',
          entityId: updated.id,
          stateVersion,
          eventType,
          eventPayload: reducerEvent as unknown as Record<string, unknown>,
          snapshotAfter: nextSnapshot as unknown as Record<string, unknown>,
          actorUserId: ctx.currentUserId,
        })
        await recordMutationLedger(client, {
          companyId: ctx.company.id,
          entityType: 'time_review_run',
          entityId: updated.id,
          action: `event:${eventType.toLowerCase()}`,
          row: updated as unknown as Record<string, unknown>,
          idempotencyKey: `time_review_run:event:${updated.id}:${updated.state_version}`,
        })

        // APPROVE: enqueue lock_labor_entries side-effect.
        // REOPEN: enqueue unlock so the entries become editable again.
        // REJECT: nothing — the entries were never locked.
        if (eventType === 'APPROVE' || eventType === 'REOPEN') {
          const action: 'lock' | 'unlock' = eventType === 'APPROVE' ? 'lock' : 'unlock'
          await recordMutationLedger(client, {
            companyId: ctx.company.id,
            entityType: 'time_review_run',
            entityId: updated.id,
            action: `${action}_labor_entries`,
            mutationType: 'lock_labor_entries',
            row: updated as unknown as Record<string, unknown>,
            outboxPayload: {
              action,
              run_id: updated.id,
              covered_entry_ids: updated.covered_entry_ids,
              approved_at: updated.approved_at,
              state_version: updated.state_version,
            },
            // Per-state_version key so APPROVE → REOPEN → APPROVE
            // generates three distinct outbox rows.
            idempotencyKey: `time_review:lock:${updated.id}:${updated.state_version}`,
          })
        }

        return { kind: 'ok' as const, run: updated, eventType }
      })

      if (result.kind === 'not_found') {
        ctx.sendJson(404, { error: 'time review run not found' })
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
        entityType: 'time_review_run',
        entityId: result.run.id,
        action: `event:${result.eventType.toLowerCase()}`,
        after: result.run,
      })
      observeAudit('time_review_run', `event:${result.eventType.toLowerCase()}`)
      ctx.sendJson(200, snapshotResponse(result.run))
      return true
    } catch (err) {
      ctx.sendJson(500, { error: err instanceof Error ? err.message : 'internal error' })
      return true
    }
  }

  return false
}
