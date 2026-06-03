// Job-runs ledger — periodic-job-fleet observability.
//
// Each company-agnostic worker runner upserts ONE row into the GLOBAL
// `public.job_runs` table per run (PK = job_name). The table is a run
// ledger only — it does NOT drive scheduling; cadence stays in each
// runner. It mirrors `public.dispatch_lanes`: company-agnostic, NO RLS,
// so writers use a plain pool/client WITHOUT setting the `app.company_id`
// RLS GUC. See docker/postgres/init/001_job_runs.sql for the schema.
//
// Recording is strictly best-effort: a recording failure must NEVER break
// the drain. recordJobRun / markJobRunStarted swallow + log their own
// errors and never throw; withJobRun re-throws nothing of its own (it
// re-raises only what `fn` itself threw, after recording the error).

import type { QueryResult, QueryResultRow } from 'pg'
import type { Logger } from '@sitelayer/logger'

/**
 * Minimal query surface satisfied by both a pg `Pool` and a `PoolClient`.
 * job_runs is GLOBAL, so callers pass the plain pool directly — no
 * per-row connection / RLS GUC dance required.
 */
export interface JobRunClient {
  query<R extends QueryResultRow = QueryResultRow>(queryText: string, values?: unknown[]): Promise<QueryResult<R>>
}

export type JobRunStatus = 'ok' | 'error' | 'skipped'

export interface JobRunResult {
  status: JobRunStatus
  durationMs?: number
  error?: string | null
  nextEligibleAt?: Date | null
  scope?: string
  metadata?: Record<string, unknown>
}

// Optional logger — recording is best-effort and may be invoked from a
// path that doesn't carry a logger. When absent we stay silent.
type MaybeLogger = Pick<Logger, 'warn'> | undefined

/**
 * UPSERT one ledger row for `jobName`, reflecting the outcome of a run.
 *
 * Always increments run_count; bumps success/failure/skipped per status.
 * Sets last_finished_at = now() and updated_at = now(). On first sight of
 * a job the INSERT seeds the row (created_at defaults to now()); on every
 * subsequent run the ON CONFLICT branch updates it in place.
 *
 * Never throws — a recording failure is swallowed + logged so it can
 * never break the drain.
 */
export async function recordJobRun(
  client: JobRunClient,
  jobName: string,
  result: JobRunResult,
  logger?: MaybeLogger,
): Promise<void> {
  const scope = result.scope ?? 'global'
  const lastError = result.error ?? ''
  const durationMs = result.durationMs ?? null
  const nextEligibleAt = result.nextEligibleAt ?? null
  const metadata = JSON.stringify(result.metadata ?? {})
  // Counter deltas — exactly one of success/failure/skipped per run.
  const successDelta = result.status === 'ok' ? 1 : 0
  const failureDelta = result.status === 'error' ? 1 : 0
  const skippedDelta = result.status === 'skipped' ? 1 : 0

  try {
    await client.query(
      `insert into public.job_runs (
         job_name, scope, last_finished_at, last_status, last_error,
         last_duration_ms, run_count, success_count, failure_count,
         skipped_count, next_eligible_at, metadata, updated_at
       ) values (
         $1, $2, now(), $3, $4,
         $5, 1, $6, $7,
         $8, $9, $10::jsonb, now()
       )
       on conflict (job_name) do update set
         scope = excluded.scope,
         last_finished_at = now(),
         last_status = excluded.last_status,
         last_error = excluded.last_error,
         last_duration_ms = excluded.last_duration_ms,
         next_eligible_at = excluded.next_eligible_at,
         metadata = excluded.metadata,
         run_count = public.job_runs.run_count + 1,
         success_count = public.job_runs.success_count + $6,
         failure_count = public.job_runs.failure_count + $7,
         skipped_count = public.job_runs.skipped_count + $8,
         updated_at = now()`,
      [
        jobName,
        scope,
        result.status,
        lastError,
        durationMs,
        successDelta,
        failureDelta,
        skippedDelta,
        nextEligibleAt,
        metadata,
      ],
    )
  } catch (err) {
    logger?.warn({ err, job_name: jobName }, '[job-runs] failed to record job run')
  }
}

/**
 * Best-effort stamp that a job has STARTED: last_started_at = now(),
 * last_status = 'running'. Does NOT touch run_count or any terminal
 * counter — that happens in recordJobRun when the run finishes. Seeds
 * the row on first sight so the very first 'running' is visible.
 *
 * Never throws.
 */
export async function markJobRunStarted(
  client: JobRunClient,
  jobName: string,
  scope = 'global',
  logger?: MaybeLogger,
): Promise<void> {
  try {
    await client.query(
      `insert into public.job_runs (job_name, scope, last_started_at, last_status, updated_at)
       values ($1, $2, now(), 'running', now())
       on conflict (job_name) do update set
         scope = excluded.scope,
         last_started_at = now(),
         last_status = 'running',
         updated_at = now()`,
      [jobName, scope],
    )
  } catch (err) {
    logger?.warn({ err, job_name: jobName }, '[job-runs] failed to mark job run started')
  }
}

export interface WithJobRunOptions {
  scope?: string
  /** Metadata folded into the ok/error recording (e.g. { idle }). */
  metadata?: Record<string, unknown>
  nextEligibleAt?: Date | null
  logger?: MaybeLogger
}

/**
 * Convenience wrapper: stamp `running` (best-effort), run `fn`, then
 * record `ok` (with measured durationMs) or `error` (with the error
 * message). Returns fn's result. The ONLY thing that can throw out of
 * withJobRun is whatever `fn` itself threw — the ledger writes never do.
 */
export async function withJobRun<T>(
  client: JobRunClient,
  jobName: string,
  fn: () => Promise<T>,
  options: WithJobRunOptions = {},
): Promise<T> {
  const { scope = 'global', metadata, nextEligibleAt, logger } = options
  const startedAt = Date.now()
  // Shared base — omit optional keys when absent so `exactOptionalPropertyTypes`
  // is satisfied (passing `undefined` for an optional prop is a type error).
  const base: JobRunResult = { status: 'ok', scope }
  if (metadata !== undefined) base.metadata = metadata
  if (nextEligibleAt !== undefined) base.nextEligibleAt = nextEligibleAt

  await markJobRunStarted(client, jobName, scope, logger)
  try {
    const value = await fn()
    await recordJobRun(client, jobName, { ...base, status: 'ok', durationMs: Date.now() - startedAt }, logger)
    return value
  } catch (err) {
    await recordJobRun(
      client,
      jobName,
      {
        ...base,
        status: 'error',
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      },
      logger,
    )
    throw err
  }
}
