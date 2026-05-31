import type { PoolClient } from 'pg'
import { appendWorkflowEvent, recordLedger, type QueueClient } from '@sitelayer/queue'
import {
  LABOR_PAYROLL_WORKFLOW_NAME,
  LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
  transitionLaborPayrollWorkflow,
  type LaborPayrollWorkflowSnapshot,
  type LaborPayrollWorkflowState,
} from '@sitelayer/workflows'

// labor-payroll AUTO weekly post drain ("THIS WEEK PAYROLL · AUTO").
//
// This is the worker producer half of the design-implied auto-post path
// (Money · Cash Flow tile, dsg__03). It is NOT a new state machine — it
// dispatches the worker-only AUTO_APPROVE / AUTO_POST_REQUESTED events
// through the SAME pure reducer (packages/workflows/src/labor-payroll.ts)
// the human path uses, so the state_version / outbox / idempotency
// guarantees are unchanged. The only difference vs. a human APPROVE /
// POST_REQUESTED is the actor: this tick, gated on a per-company policy
// + a weekly clock window.
//
// Pipeline per in-window company:
//   generated --AUTO_APPROVE-->        approved (auto_posted=true)
//   approved  --AUTO_POST_REQUESTED--> posting  (enqueues the same
//                                                post_qbo_time_activities
//                                                outbox row the human
//                                                POST_REQUESTED enqueues)
// The existing labor-payroll-push drain then claims that outbox row and
// pushes the QBO TimeActivities exactly as it does for a human post.
//
// Idempotency / safety:
//   * The outbox row uses the SAME per-run idempotency key as the human
//     path (`labor_payroll_run:post:<run_id>`) so a human POST_REQUESTED
//     and an auto AUTO_POST_REQUESTED can never double-enqueue.
//   * Each run is locked FOR UPDATE and its state re-asserted before the
//     reducer runs. A stale auto-tick that races a human VOID (run left
//     `generated`/`approved`) is rejected by the reducer's from-set
//     assertion and skipped — the human action is authoritative.
//   * AUTO_POST_REQUESTED only fires from `approved` and ONLY when the
//     run is already auto_posted (i.e. this drain auto-approved it). It
//     never auto-posts a run a human approved by hand, and it never
//     re-pushes a `failed` run.
//   * Gated OFF by default: companies.labor_payroll_auto_post_enabled is
//     false for every existing company (migration 116), so this drain is
//     a no-op until a company explicitly opts in.

export type LaborPayrollAutoPostPolicy = {
  enabled: boolean
  /** ISO weekday (1=Mon .. 7=Sun) the weekly window opens on, or null. */
  weekday: number | null
  /** Local time-of-day the window opens, 'HH:MM[:SS]' or null. */
  after: string | null
}

export type LaborPayrollAutoPostSummary = {
  /** Runs evaluated (locked + state-checked) across both phases. */
  processed: number
  /** generated → approved transitions emitted. */
  approved: number
  /** approved → posting transitions emitted (+ outbox enqueued). */
  posted: number
  /** Runs skipped (raced a human action, or already advanced). */
  skipped: number
  /** Per-run failures (rolled back, left for the next tick). */
  failed: number
  /** True when the policy was off or the clock window was closed. */
  windowClosed: boolean
}

const EMPTY_SUMMARY: LaborPayrollAutoPostSummary = {
  processed: 0,
  approved: 0,
  posted: 0,
  skipped: 0,
  failed: 0,
  windowClosed: true,
}

// Cap per heartbeat so a backlog (e.g. a company that just opted in with
// many pending runs) can't stall the worker or flood the audit log in one
// tick. The rest are picked up on subsequent heartbeats while the window
// stays open.
const AUTO_POST_MAX_PER_HEARTBEAT = 25

/**
 * Pure decision: is the weekly auto-post window open at `now` for this
 * policy? No DB or wall-clock read — `now` is supplied so the same logic
 * is unit-testable and replay-safe.
 *
 * The window opens at `after` (local time-of-day) on the configured ISO
 * weekday and stays open for the remainder of that weekday. A run that
 * appears later the same day (e.g. a late time-review approval) is still
 * caught; a run only ever auto-posts once because the reducer's from-set
 * assertion rejects a second tick.
 *
 * Returns false (closed) when:
 *   - the policy is disabled,
 *   - weekday or after is unset (incompletely configured),
 *   - today's ISO weekday != the configured weekday, or
 *   - the local time-of-day is before `after`.
 */
export function isAutoPostWindowOpen(policy: LaborPayrollAutoPostPolicy, now: Date): boolean {
  if (!policy.enabled) return false
  if (policy.weekday == null || !policy.after) return false
  if (Number.isNaN(now.getTime())) return false

  // JS getDay(): 0=Sun..6=Sat. Convert to ISO weekday 1=Mon..7=Sun.
  const isoWeekday = now.getDay() === 0 ? 7 : now.getDay()
  if (isoWeekday !== policy.weekday) return false

  const afterMinutes = parseTimeOfDayMinutes(policy.after)
  if (afterMinutes == null) return false
  const nowMinutes = now.getHours() * 60 + now.getMinutes()
  return nowMinutes >= afterMinutes
}

/**
 * Parse a 'HH:MM' / 'HH:MM:SS' time-of-day string to minutes since
 * midnight. Returns null on a malformed value (so a bad policy row reads
 * as "window closed" rather than throwing in the tick).
 */
export function parseTimeOfDayMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim())
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 60 + minutes
}

type AutoPostRunRow = {
  id: string
  state: LaborPayrollWorkflowState
  state_version: number
  approved_at: string | null
  approved_by_user_id: string | null
  posted_at: string | null
  failed_at: string | null
  error_message: string | null
  qbo_payroll_batch_ref: string[] | null
  auto_posted: boolean
  covered_labor_entry_ids: string[]
  period_start: string
  period_end: string
  total_hours: string
  total_cents: string
}

const AUTO_POST_RUN_COLUMNS = `
  id,
  state,
  state_version,
  approved_at,
  approved_by_user_id,
  posted_at,
  failed_at,
  error_message,
  qbo_payroll_batch_ref,
  auto_posted,
  covered_labor_entry_ids,
  to_char(period_start, 'YYYY-MM-DD') as period_start,
  to_char(period_end, 'YYYY-MM-DD') as period_end,
  total_hours,
  total_cents
`

function rowToWorkflowSnapshot(row: AutoPostRunRow): LaborPayrollWorkflowSnapshot {
  return {
    state: row.state,
    state_version: row.state_version,
    approved_at: row.approved_at,
    approved_by: row.approved_by_user_id,
    posted_at: row.posted_at,
    failed_at: row.failed_at,
    error: row.error_message,
    qbo_timeactivity_ids: row.qbo_payroll_batch_ref,
    auto_posted: row.auto_posted,
  }
}

// Synthetic actor id stamped on auto-approved runs so the trail can tell an
// automated approval from a human one (alongside the auto_posted=true flag).
export const AUTO_POST_ACTOR = 'system:labor-payroll-auto-post'

/**
 * Load the per-company auto-post policy. Returns the disabled default if
 * the company row is missing.
 */
export async function fetchAutoPostPolicy(client: QueueClient, companyId: string): Promise<LaborPayrollAutoPostPolicy> {
  const result = await client.query<{
    labor_payroll_auto_post_enabled: boolean
    labor_payroll_auto_post_weekday: number | null
    labor_payroll_auto_post_after: string | null
  }>(
    `select labor_payroll_auto_post_enabled,
            labor_payroll_auto_post_weekday,
            labor_payroll_auto_post_after
       from companies
      where id = $1
      limit 1`,
    [companyId],
  )
  const row = result.rows[0]
  if (!row) return { enabled: false, weekday: null, after: null }
  return {
    enabled: row.labor_payroll_auto_post_enabled === true,
    weekday: row.labor_payroll_auto_post_weekday,
    after: row.labor_payroll_auto_post_after,
  }
}

/**
 * Drain the weekly auto-post cadence for one company.
 *
 * Phase 0: read the policy + clock window. Short-circuit to a no-op
 * (windowClosed:true) when the company hasn't opted in or it's not the
 * configured day/time — the common case.
 *
 * Phase 1 (generated → approved): for each `generated` run, dispatch
 * AUTO_APPROVE. Each run is locked and re-asserted inside its own tx.
 *
 * Phase 2 (approved → posting): for each `approved` run that THIS drain
 * auto-approved (auto_posted=true), dispatch AUTO_POST_REQUESTED and
 * enqueue the post_qbo_time_activities outbox row (same per-run
 * idempotency key as the human path) so the existing push drain pushes
 * the QBO TimeActivities.
 *
 * `now` is injectable for tests; defaults to the wall clock.
 *
 * `setCompanyGuc` binds `app.company_id` for the RLS-protected writes
 * (workflow_event_log / mutation_outbox / sync_events). It is called
 * inside each per-row BEGIN (SET LOCAL is tx-scoped). Optional so the
 * unit tests can omit it; the runner always supplies it.
 */
export async function processLaborPayrollAutoPost(
  client: PoolClient,
  companyId: string,
  opts: { now?: Date; limit?: number; setCompanyGuc?: (c: PoolClient, companyId: string) => Promise<void> } = {},
): Promise<LaborPayrollAutoPostSummary> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? AUTO_POST_MAX_PER_HEARTBEAT
  const setGuc = opts.setCompanyGuc ?? (async () => {})

  const policy = await fetchAutoPostPolicy(client, companyId)
  if (!isAutoPostWindowOpen(policy, now)) {
    return { ...EMPTY_SUMMARY }
  }

  let processed = 0
  let approvedCount = 0
  let postedCount = 0
  let skipped = 0
  let failed = 0

  // Phase 1: generated → approved. Candidate pre-filter; each run is
  // re-locked + re-asserted inside its per-row tx.
  const generatedCandidates = await client.query<{ id: string }>(
    `select id from labor_payroll_runs
      where company_id = $1 and state = 'generated' and deleted_at is null
      order by period_end asc, created_at asc
      limit $2`,
    [companyId, limit],
  )

  for (const candidate of generatedCandidates.rows) {
    processed += 1
    await client.query('begin')
    try {
      await setGuc(client, companyId)
      const locked = await lockRun(client, companyId, candidate.id)
      if (!locked || locked.state !== 'generated') {
        // Raced a human action (APPROVE / VOID) — skip; human is authoritative.
        await client.query('commit')
        skipped += 1
        continue
      }
      await applyAutoEvent(client, companyId, locked, {
        type: 'AUTO_APPROVE',
        approved_at: now.toISOString(),
        approved_by: AUTO_POST_ACTOR,
      })
      await client.query('commit')
      approvedCount += 1
    } catch (err) {
      await client.query('rollback').catch(() => {})
      failed += 1
      warn('[labor-payroll] auto-approve failed', { runId: candidate.id, error: errMessage(err) })
    }
  }

  // Phase 2: approved (auto_posted) → posting + enqueue outbox. Only runs
  // THIS drain auto-approved are eligible — never a human-approved run.
  const approvedCandidates = await client.query<{ id: string }>(
    `select id from labor_payroll_runs
      where company_id = $1 and state = 'approved' and auto_posted = true and deleted_at is null
      order by period_end asc, created_at asc
      limit $2`,
    [companyId, limit],
  )

  for (const candidate of approvedCandidates.rows) {
    processed += 1
    await client.query('begin')
    try {
      await setGuc(client, companyId)
      const locked = await lockRun(client, companyId, candidate.id)
      if (!locked || locked.state !== 'approved' || locked.auto_posted !== true) {
        await client.query('commit')
        skipped += 1
        continue
      }
      const updated = await applyAutoEvent(client, companyId, locked, { type: 'AUTO_POST_REQUESTED' })
      // Enqueue the QBO push outbox row — SAME mutation_type + idempotency
      // key as the human POST_REQUESTED (apps/api/src/routes/labor-payroll-runs.ts).
      // recordLedger's `on conflict (company_id, idempotency_key) do update`
      // makes a re-tick or a human/auto overlap a safe upsert, not a dup.
      await recordLedger(client, {
        companyId,
        entityType: 'labor_payroll_run',
        entityId: locked.id,
        mutationType: 'post_qbo_time_activities',
        idempotencyKey: `labor_payroll_run:post:${locked.id}`,
        syncPayload: {
          action: 'post_qbo_time_activities',
          labor_payroll_run_id: locked.id,
          origin: 'worker:auto_post',
          state_version: updated?.state_version ?? null,
        },
        outboxPayload: {
          labor_payroll_run_id: locked.id,
          period_start: locked.period_start,
          period_end: locked.period_end,
          covered_labor_entry_ids: locked.covered_labor_entry_ids,
          total_hours: locked.total_hours,
          total_cents: locked.total_cents,
        },
        actorUserId: AUTO_POST_ACTOR,
      })
      await client.query('commit')
      postedCount += 1
    } catch (err) {
      await client.query('rollback').catch(() => {})
      failed += 1
      warn('[labor-payroll] auto-post-request failed', { runId: candidate.id, error: errMessage(err) })
    }
  }

  return { processed, approved: approvedCount, posted: postedCount, skipped, failed, windowClosed: false }
}

async function lockRun(client: QueueClient, companyId: string, runId: string): Promise<AutoPostRunRow | null> {
  const result = await client.query<AutoPostRunRow>(
    `select ${AUTO_POST_RUN_COLUMNS}
       from labor_payroll_runs
      where company_id = $1 and id = $2 and deleted_at is null
      for update`,
    [companyId, runId],
  )
  return result.rows[0] ?? null
}

/**
 * Apply one worker auto event through the pure reducer, persist the new
 * row state + state_version, and append the workflow_event_log row. The
 * reducer's from-set assertion is the safety net: a transition illegal
 * from the (re-locked) current state throws and rolls the tx back.
 */
async function applyAutoEvent(
  client: QueueClient,
  companyId: string,
  current: AutoPostRunRow,
  event: { type: 'AUTO_APPROVE'; approved_at: string; approved_by: string } | { type: 'AUTO_POST_REQUESTED' },
): Promise<AutoPostRunRow | null> {
  const beforeVersion = current.state_version
  const next = transitionLaborPayrollWorkflow(rowToWorkflowSnapshot(current), event)

  const updated = await client.query<AutoPostRunRow>(
    `update labor_payroll_runs
        set state = $3,
            state_version = $4,
            approved_at = $5,
            approved_by_user_id = $6,
            auto_posted = $7,
            error_message = null,
            failed_at = null,
            version = version + 1,
            updated_at = now()
      where company_id = $1 and id = $2
      returning ${AUTO_POST_RUN_COLUMNS}`,
    [
      companyId,
      current.id,
      next.state,
      next.state_version,
      next.approved_at ?? null,
      next.approved_by ?? null,
      next.auto_posted ?? false,
    ],
  )
  const row = updated.rows[0] ?? null
  if (row) {
    await appendWorkflowEvent(client, {
      companyId,
      workflowName: LABOR_PAYROLL_WORKFLOW_NAME,
      schemaVersion: LABOR_PAYROLL_WORKFLOW_SCHEMA_VERSION,
      entityType: 'labor_payroll_run',
      entityId: current.id,
      stateVersion: beforeVersion,
      eventType: event.type,
      eventPayload: event as unknown as Record<string, unknown>,
      snapshotAfter: next as unknown as Record<string, unknown>,
      actorUserId: event.type === 'AUTO_APPROVE' ? event.approved_by : AUTO_POST_ACTOR,
    })
  }
  return row
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function warn(message: string, meta: Record<string, unknown>): void {
  ;(globalThis as { console?: { warn?: (...a: unknown[]) => void } }).console?.warn?.(message, meta)
}
