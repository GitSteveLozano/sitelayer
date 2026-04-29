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

function snapshotsEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b)
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',')}}`
}
