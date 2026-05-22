// Dispatch lanes — runtime kill-switch primitive.
//
// Each runner pipeline in worker.ts is wrapped in withLaneGate(name, ...).
// The gate consults `dispatch_lanes`:
//   - active   → runs the underlying function
//   - paused   → skips (logs once-per-minute per lane)
//   - degraded → runs but logs a warning (a future concurrency semaphore
//                will read this state too; for now it's purely advisory)
//
// State is cached in-process for LANE_CACHE_TTL_MS (default 5s) to avoid
// hammering Postgres on every heartbeat. The cache is invalidated lazily
// when `resume_after` falls into the past — the runner self-resumes
// rather than waiting for the auto-pause keeper to find the row.
//
// A row missing from `dispatch_lanes` fails open (returns `active`) so a
// freshly-introduced runner doesn't deadlock the worker waiting for a
// migration to seed its lane. The accompanying migration seeds every lane
// that exists today; new lanes should add an INSERT in a follow-up
// migration.

import type { Pool } from 'pg'
import type { Logger } from '@sitelayer/logger'

export type LaneState = 'active' | 'paused' | 'degraded'

export interface LaneSnapshot {
  state: LaneState
  pause_reason: string
  resume_after: Date | null
}

interface LaneCacheEntry {
  snapshot: LaneSnapshot
  fetched_at: number
}

const LANE_CACHE_TTL_MS = (() => {
  const raw = Number(process.env.DISPATCH_LANE_CACHE_TTL_MS ?? 5_000)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5_000
})()

const PAUSED_LOG_THROTTLE_MS = 60_000

const cache = new Map<string, LaneCacheEntry>()
const pausedLogState = new Map<string, number>()

/**
 * Test helper — clears the in-memory caches. Worker boot doesn't need
 * this; tests do, because they construct multiple runners sequentially
 * and need a clean slate per case.
 */
export function __resetDispatchLaneCachesForTests(): void {
  cache.clear()
  pausedLogState.clear()
}

/**
 * Fetch the current lane snapshot. Cached for LANE_CACHE_TTL_MS. If the
 * row is missing (lane not yet seeded), returns `active` and skips the
 * cache — the next migration may seed it and we want to pick that up
 * within the next tick.
 */
export async function getLaneState(pool: Pool, name: string): Promise<LaneSnapshot> {
  const now = Date.now()
  const cached = cache.get(name)
  if (cached && now - cached.fetched_at < LANE_CACHE_TTL_MS) {
    return maybeAutoResume(pool, name, cached.snapshot, now)
  }

  let snapshot: LaneSnapshot
  try {
    const result = await pool.query<{ state: LaneState; pause_reason: string; resume_after: Date | null }>(
      `select state, pause_reason, resume_after
         from dispatch_lanes
        where name = $1`,
      [name],
    )
    const row = result.rows[0]
    if (!row) {
      // Fail-open for new runners whose lane hasn't been seeded yet.
      // Don't cache — we want the seed to take effect immediately.
      return { state: 'active', pause_reason: '', resume_after: null }
    }
    snapshot = row
  } catch {
    // Don't take the worker down over a transient DB hiccup; the
    // queue-drain runner is the real authority on whether DB is reachable.
    // Fail-open here matches the missing-row semantics above.
    return { state: 'active', pause_reason: '', resume_after: null }
  }

  cache.set(name, { snapshot, fetched_at: now })
  return maybeAutoResume(pool, name, snapshot, now)
}

/**
 * If `resume_after` is in the past and the lane is paused/degraded, flip
 * it back to `active` lazily. Avoids requiring the auto-pause keeper to
 * be the only path that re-enables a lane.
 */
async function maybeAutoResume(pool: Pool, name: string, snapshot: LaneSnapshot, now: number): Promise<LaneSnapshot> {
  if (snapshot.state === 'active') return snapshot
  if (!snapshot.resume_after) return snapshot
  if (snapshot.resume_after.getTime() > now) return snapshot

  // Best-effort flip. If another worker beat us to it, the UPDATE is a
  // no-op because state is already 'active'.
  try {
    await pool.query(
      `update dispatch_lanes
          set state = 'active',
              pause_reason = '',
              paused_at = null,
              resume_after = null,
              last_decided_by = 'system:auto-resume',
              last_decided_at = now(),
              updated_at = now()
        where name = $1 and state <> 'active' and resume_after is not null and resume_after <= now()`,
      [name],
    )
    await pool.query(
      `insert into dispatch_lane_decisions (lane_name, from_state, to_state, reason, decided_by)
       values ($1, $2, 'active', 'auto-resume after resume_after elapsed', 'system:auto-resume')`,
      [name, snapshot.state],
    )
  } catch {
    // Ignored: another tick will retry the resume.
  }

  const fresh: LaneSnapshot = { state: 'active', pause_reason: '', resume_after: null }
  cache.set(name, { snapshot: fresh, fetched_at: now })
  return fresh
}

/**
 * Wrap a runner tick in the lane gate. Active → runs; paused → skips
 * (with throttled logging); degraded → runs with a warning. The gate is
 * a thin pre/post hook; it never mutates the function's result.
 */
export async function withLaneGate(pool: Pool, logger: Logger, name: string, fn: () => Promise<void>): Promise<void> {
  const snapshot = await getLaneState(pool, name)
  if (snapshot.state === 'paused') {
    logPausedThrottled(logger, name, snapshot)
    return
  }
  if (snapshot.state === 'degraded') {
    logger.warn(
      {
        lane: name,
        pause_reason: snapshot.pause_reason,
        resume_after: snapshot.resume_after?.toISOString() ?? null,
      },
      '[lane-gate] degraded — running with advisory concurrency hint',
    )
  }
  await fn()
}

/**
 * Variant for runners that return a summary object the caller wants to
 * fold into a heartbeat tick log. Paused → returns `fallback`. Active /
 * degraded → returns the function's result (degraded logs a warning
 * first). Keeps the caller's return-type narrow; no need to thread
 * `LaneState` through every runner signature.
 */
export async function runIfLaneActive<T>(
  pool: Pool,
  logger: Logger,
  name: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const snapshot = await getLaneState(pool, name)
  if (snapshot.state === 'paused') {
    logPausedThrottled(logger, name, snapshot)
    return fallback
  }
  if (snapshot.state === 'degraded') {
    logger.warn(
      {
        lane: name,
        pause_reason: snapshot.pause_reason,
        resume_after: snapshot.resume_after?.toISOString() ?? null,
      },
      '[lane-gate] degraded — running with advisory concurrency hint',
    )
  }
  return fn()
}

function logPausedThrottled(logger: Logger, name: string, snapshot: LaneSnapshot): void {
  const now = Date.now()
  const last = pausedLogState.get(name) ?? 0
  if (now - last < PAUSED_LOG_THROTTLE_MS) return
  pausedLogState.set(name, now)
  logger.info(
    {
      lane: name,
      pause_reason: snapshot.pause_reason,
      resume_after: snapshot.resume_after?.toISOString() ?? null,
    },
    '[lane-gate] paused — skipping drain',
  )
}

/**
 * Set lane state. No-op when the target state matches the current row
 * (avoids writing a decision row every keeper tick). Used by the
 * auto-pause keeper AND the admin POST endpoints.
 */
export async function setLaneState(
  pool: Pool,
  args: {
    name: string
    to_state: LaneState
    reason: string
    decided_by: string
    resume_after?: Date | null
    metadata?: Record<string, unknown>
  },
): Promise<{ changed: boolean; from_state: LaneState | null }> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const current = await client.query<{ state: LaneState }>(
      `select state from dispatch_lanes where name = $1 for update`,
      [args.name],
    )
    const currentRow = current.rows[0]
    if (!currentRow) {
      await client.query('rollback')
      return { changed: false, from_state: null }
    }
    const fromState = currentRow.state
    if (fromState === args.to_state) {
      await client.query('rollback')
      return { changed: false, from_state: fromState }
    }
    const pausedAt = args.to_state === 'paused' || args.to_state === 'degraded' ? new Date() : null
    await client.query(
      `update dispatch_lanes
          set state = $2,
              pause_reason = $3,
              paused_at = $4,
              resume_after = $5,
              last_decided_by = $6,
              last_decided_at = now(),
              metadata = coalesce($7::jsonb, metadata),
              updated_at = now()
        where name = $1`,
      [
        args.name,
        args.to_state,
        args.reason,
        pausedAt,
        args.resume_after ?? null,
        args.decided_by,
        args.metadata ? JSON.stringify(args.metadata) : null,
      ],
    )
    await client.query(
      `insert into dispatch_lane_decisions (lane_name, from_state, to_state, reason, decided_by, metadata)
       values ($1, $2, $3, $4, $5, coalesce($6::jsonb, '{}'::jsonb))`,
      [
        args.name,
        fromState,
        args.to_state,
        args.reason,
        args.decided_by,
        args.metadata ? JSON.stringify(args.metadata) : null,
      ],
    )
    await client.query('commit')
    // Invalidate cache for this lane so the next tick reads the new state.
    cache.delete(args.name)
    return { changed: true, from_state: fromState }
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
