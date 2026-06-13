// Capture → replay → freeze: turn a live workflow entity's event log into a
// self-verified, replayable regression fixture (2026-06-13 PR3).
//
// The highest-value debug primitive from the correctness-architecture review:
// "a real bug becomes a permanent replayable regression." Given an entity's
// append-only `workflow_event_log`, this captures the ordered event sequence,
// REPLAYS it through the registered reducer (applyEventLog), and asserts the
// replay reproduces the terminal state the DB recorded. The result is a frozen
// artifact you can check in and re-run forever — no live DB, no anonymizer.
//
// SCOPE / what is deferred. This captures the WORKFLOW EVENT SEQUENCE, which is
// enough to (a) self-verify the bug reproduces and (b) re-drive the reducer to
// the exact terminal state. It deliberately does NOT walk FK dependencies
// (company / project / customer) or anonymize PII out of payloads — that is the
// deferred "anonymizer" the review flagged as the whole risk, and it isn't
// needed for the single-contractor local-debug loop. For full throwaway-DB
// seeding, drop the emitted fragment into a `scenarios/*.yaml` under the right
// entity collection and let `scripts/seed-scenario.ts` replay it.

import { getWorkflow } from './registry.js'
import { applyEventLog, type WorkflowEventLogEntry } from './replay.js'

export interface CapturedWorkflowEvent {
  /** The BEFORE state_version this event was applied at (matches the log row). */
  state_version: number
  type: string
  payload: Record<string, unknown>
}

export interface CaptureVerification {
  /** The capture is a faithful, replayable regression of the live entity:
   *  reducer registered + replay clean + replayed terminal == logged terminal. */
  ok: boolean
  /** applyEventLog found no schema_version / gap / divergence / illegal issue. */
  replayClean: boolean
  /** The state the reducer replays to equals the snapshot_after of the LAST
   *  log row (what the DB actually persisted). */
  terminalMatches: boolean
  /** Human-readable issue lines (empty when ok). */
  issues: string[]
}

export interface CapturedScenario {
  workflow: string
  schemaVersion: number
  entityId: string
  /** Ordered captured events (state_version ascending). */
  events: CapturedWorkflowEvent[]
  /** Terminal state reached by replaying through the reducer, or null on a
   *  divergence / unknown workflow. */
  replayedState: string | null
  /** Terminal state the DB recorded on the last log row's snapshot_after. */
  loggedState: string | null
  verification: CaptureVerification
}

/**
 * Capture + self-verify a workflow entity from its ordered event log. Pure: no
 * DB, no clock — the reducer's own purity is what makes the replay a faithful
 * reproduction. Feed it the rows of `workflow_event_log` for one
 * (workflow_name, entity_id), ordered by state_version ascending.
 */
export function captureScenarioFromLog(log: readonly WorkflowEventLogEntry[]): CapturedScenario {
  if (log.length === 0) {
    return {
      workflow: '',
      schemaVersion: 0,
      entityId: '',
      events: [],
      replayedState: null,
      loggedState: null,
      verification: {
        ok: false,
        replayClean: false,
        terminalMatches: false,
        issues: ['empty event log — no rows to capture (entity has no workflow_event_log history)'],
      },
    }
  }

  const first = log[0] as WorkflowEventLogEntry
  const last = log[log.length - 1] as WorkflowEventLogEntry
  const workflow = first.workflow_name
  const def = getWorkflow(workflow)

  const events: CapturedWorkflowEvent[] = log.map((r) => ({
    state_version: r.state_version,
    type: r.event_payload.type,
    payload: { ...r.event_payload },
  }))
  const loggedState = last.snapshot_after.state ?? null

  const issues: string[] = []
  if (!def) {
    issues.push(`no workflow registered as "${workflow}" — its reducer may have been removed or renamed`)
  }

  // Replay from the reducer's initial state at the first row's BEFORE version.
  // A divergence here means the captured log isn't a clean prefix-to-terminal
  // history (truncated / out-of-order / schema-drifted) — surfaced, not hidden.
  const initial = { state: def?.initialState ?? first.snapshot_after.state, state_version: first.state_version }
  const replay = applyEventLog(initial, log)
  const replayClean = replay.ok
  if (!replay.ok) {
    for (const issue of replay.issues) {
      issues.push(
        `replay diverged at state_version=${issue.state_version} event=${issue.event_type} ` +
          `reason=${issue.reason}${issue.detail ? ` — ${issue.detail}` : ''}`,
      )
    }
  }

  const replayedState = replay.finalSnapshot?.state ?? null
  const terminalMatches = replayedState !== null && replayedState === loggedState
  if (replayClean && !terminalMatches) {
    issues.push(`replayed terminal "${replayedState}" does not match logged terminal "${loggedState}"`)
  }

  return {
    workflow,
    schemaVersion: def?.schemaVersion ?? first.schema_version,
    entityId: first.entity_id,
    events,
    replayedState,
    loggedState,
    verification: {
      ok: Boolean(def) && replayClean && terminalMatches,
      replayClean,
      terminalMatches,
      issues,
    },
  }
}

/**
 * Serialize a captured scenario to a self-contained YAML regression fixture.
 * Re-runnable through `applyEventLog` / the reducer with no DB. Payloads are
 * emitted as JSON flow-mappings (valid YAML) so timestamps, nulls, and arrays
 * round-trip exactly. The header records the verification verdict so a reviewer
 * sees at a glance whether the capture faithfully reproduces the entity.
 */
export function captureScenarioToYaml(captured: CapturedScenario): string {
  const v = captured.verification
  const lines: string[] = [
    `# Captured workflow regression — ${captured.workflow} / ${captured.entityId}`,
    `# Generated by scripts/capture-to-scenario.ts from live workflow_event_log.`,
    `# Verification: ${v.ok ? 'OK' : 'NOT REPRODUCIBLE'} ` +
      `(replayClean=${v.replayClean}, terminalMatches=${v.terminalMatches})`,
    `#   replayed terminal: ${captured.replayedState ?? '(none)'} | logged terminal: ${captured.loggedState ?? '(none)'}`,
  ]
  for (const issue of v.issues) lines.push(`#   ! ${issue}`)
  lines.push(
    `# To seed a throwaway DB with full company/project context, nest these events`,
    `# under the matching scenario entity collection and run scripts/seed-scenario.ts.`,
    `workflow: ${captured.workflow}`,
    `schema_version: ${captured.schemaVersion}`,
    `entity_id: ${captured.entityId}`,
    `terminal_state: ${captured.replayedState ?? captured.loggedState ?? 'null'}`,
    `events:`,
  )
  for (const event of captured.events) {
    // Strip the redundant `type` from the inline payload (it's on its own line).
    const { type: _omit, ...rest } = event.payload
    lines.push(`  - state_version: ${event.state_version}`)
    lines.push(`    type: ${event.type}`)
    lines.push(`    payload: ${JSON.stringify(rest)}`)
  }
  return lines.join('\n') + '\n'
}
