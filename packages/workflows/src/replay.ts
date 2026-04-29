import { getWorkflow } from './registry.js'

/**
 * Wire shape of a single workflow_event_log row, narrow enough that
 * tests + tooling can construct one without the database.
 */
export interface WorkflowEventLogEntry {
  workflow_name: string
  schema_version: number
  entity_id: string
  state_version: number
  event_payload: { type: string; [k: string]: unknown }
  snapshot_after: { state: string; state_version: number; [k: string]: unknown }
}

export interface ReplayResult<Snapshot extends { state: string; state_version: number }> {
  ok: boolean
  finalSnapshot: Snapshot | null
  /** Per-step issues. ok=false if any step diverged from the persisted
   * snapshot. Each issue carries the entry that failed and a short
   * reason so callers can surface the first divergence. */
  issues: Array<{
    state_version: number
    event_type: string
    reason: 'schema_version_mismatch' | 'snapshot_divergence' | 'illegal_transition' | 'unknown_workflow' | 'gap'
    detail?: string
  }>
}

/**
 * Replay an ordered event log for a single workflow entity through the
 * registered reducer. Asserts:
 *   - all entries belong to the same workflow_name
 *   - schema_version on every row matches the registered reducer
 *   - state_version increments by exactly 1 per row, no gaps
 *   - reducer output matches the persisted snapshot_after
 *
 * Returns the final reducer output. The test harness compares this
 * against the row stored in `rental_billing_runs` (or whatever entity
 * table) to confirm bit-for-bit equivalence.
 */
export function applyEventLog<Snapshot extends { state: string; state_version: number }>(
  initial: Snapshot,
  log: readonly WorkflowEventLogEntry[],
): ReplayResult<Snapshot> {
  if (log.length === 0) {
    return { ok: true, finalSnapshot: initial, issues: [] }
  }
  const workflowName = log[0]!.workflow_name
  const definition = getWorkflow(workflowName)
  if (!definition) {
    return {
      ok: false,
      finalSnapshot: null,
      issues: [
        {
          state_version: log[0]!.state_version,
          event_type: log[0]!.event_payload.type,
          reason: 'unknown_workflow',
          detail: `no workflow registered as "${workflowName}"`,
        },
      ],
    }
  }

  const issues: ReplayResult<Snapshot>['issues'] = []
  let snapshot = initial
  let expectedVersion = initial.state_version

  for (const entry of log) {
    if (entry.schema_version !== definition.schemaVersion) {
      issues.push({
        state_version: entry.state_version,
        event_type: entry.event_payload.type,
        reason: 'schema_version_mismatch',
        detail: `entry schema=${entry.schema_version} reducer schema=${definition.schemaVersion}`,
      })
      return { ok: false, finalSnapshot: null, issues }
    }
    if (entry.state_version !== expectedVersion) {
      issues.push({
        state_version: entry.state_version,
        event_type: entry.event_payload.type,
        reason: 'gap',
        detail: `expected state_version=${expectedVersion} got ${entry.state_version}`,
      })
      return { ok: false, finalSnapshot: null, issues }
    }
    let next: Snapshot
    try {
      next = definition.reduce(snapshot as never, entry.event_payload as never) as Snapshot
    } catch (err) {
      issues.push({
        state_version: entry.state_version,
        event_type: entry.event_payload.type,
        reason: 'illegal_transition',
        detail: err instanceof Error ? err.message : String(err),
      })
      return { ok: false, finalSnapshot: null, issues }
    }
    if (!snapshotsEqual(next, entry.snapshot_after)) {
      issues.push({
        state_version: entry.state_version,
        event_type: entry.event_payload.type,
        reason: 'snapshot_divergence',
        detail: `reducer=${JSON.stringify(next)} persisted=${JSON.stringify(entry.snapshot_after)}`,
      })
      return { ok: false, finalSnapshot: null, issues }
    }
    snapshot = next
    expectedVersion = next.state_version
  }
  return { ok: issues.length === 0, finalSnapshot: snapshot, issues }
}

/**
 * Semantic equality for snapshots.
 *
 * Persisted snapshot_after JSON includes every reducer-snapshot field
 * (nulls preserved because the API handler spreads the live row before
 * the transition). Reducer-fresh output from a minimal initial state
 * only carries fields the transitions touched. They are equivalent when
 * every key on either side that's missing on the other is null.
 *
 * Non-null differences and array/scalar mismatches are still caught.
 */
function snapshotsEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a == null && b == null
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!snapshotsEqual(a[i], b[i])) return false
    }
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)])
  for (const k of keys) {
    const av = aObj[k]
    const bv = bObj[k]
    // Treat missing-and-null as equal so reducer-fresh snapshots (no
    // explicit null fields) match persisted snapshots (all null fields).
    if (av === undefined && bv === null) continue
    if (av === null && bv === undefined) continue
    if (!snapshotsEqual(av, bv)) return false
  }
  return true
}
