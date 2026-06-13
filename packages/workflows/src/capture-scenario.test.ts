// capture-scenario: the capture → replay → freeze loop, proven WITHOUT a DB.
import { describe, expect, it } from 'vitest'
import './index.js' // side-effect: register every workflow
import { getWorkflow } from './registry.js'
import type { WorkflowEventLogEntry } from './replay.js'
import { captureScenarioFromLog, captureScenarioToYaml } from './capture-scenario.js'

/**
 * Build a faithful workflow_event_log by driving the registered reducer forward
 * — the same shape the dispatch primitive's recordWorkflowEvent writes (row
 * state_version = the BEFORE version, snapshot_after = the reducer output).
 */
function buildLog(workflow: string, entityId: string, events: Array<{ type: string; [k: string]: unknown }>) {
  const def = getWorkflow(workflow)
  if (!def) throw new Error(`no workflow ${workflow}`)
  let snap: { state: string; state_version: number } = { state: def.initialState, state_version: 1 }
  const log: WorkflowEventLogEntry[] = []
  for (const event of events) {
    const before = snap.state_version
    snap = def.reduce(snap as never, event as never) as { state: string; state_version: number }
    log.push({
      workflow_name: workflow,
      schema_version: def.schemaVersion,
      entity_id: entityId,
      state_version: before,
      event_payload: event,
      snapshot_after: snap,
    })
  }
  return log
}

describe('captureScenarioFromLog', () => {
  it('captures a clean log and self-verifies the replay reproduces the terminal', () => {
    const log = buildLog('rental_billing_run', 'rbr-1', [
      { type: 'APPROVE', approved_at: '2026-01-15T11:00:00.000Z', approved_by: 'e2e-admin' },
      { type: 'POST_REQUESTED' },
      { type: 'POST_SUCCEEDED', posted_at: '2026-01-15T11:05:00.000Z', qbo_invoice_id: 'INV-9' },
    ])
    const captured = captureScenarioFromLog(log)
    expect(captured.verification.ok).toBe(true)
    expect(captured.verification.replayClean).toBe(true)
    expect(captured.verification.terminalMatches).toBe(true)
    expect(captured.replayedState).toBe('posted')
    expect(captured.loggedState).toBe('posted')
    expect(captured.events.map((e) => e.type)).toEqual(['APPROVE', 'POST_REQUESTED', 'POST_SUCCEEDED'])
    expect(captured.events[0]?.payload.approved_by).toBe('e2e-admin')
  })

  it('preserves payload-discriminated fields (notification SEND_FAILED.kind)', () => {
    const log = buildLog('notification', 'ntf-1', [
      { type: 'SEND_FAILED', failed_at: '2026-01-15T10:00:00.000Z', error: 'clerk 404', kind: 'clerk_not_found' },
    ])
    const captured = captureScenarioFromLog(log)
    expect(captured.verification.ok).toBe(true)
    expect(captured.replayedState).toBe('failed_clerk_not_found')
    expect(captured.events[0]?.payload.kind).toBe('clerk_not_found')
  })

  it('flags an empty log as not reproducible', () => {
    const captured = captureScenarioFromLog([])
    expect(captured.verification.ok).toBe(false)
    expect(captured.verification.issues[0]).toMatch(/empty event log/)
  })

  it('flags a log whose workflow reducer is no longer registered', () => {
    const log = buildLog('rental_billing_run', 'rbr-2', [
      { type: 'APPROVE', approved_at: '2026-01-15T11:00:00.000Z', approved_by: 'e2e-admin' },
    ])
    // Simulate a removed/renamed reducer.
    const tampered = log.map((r) => ({ ...r, workflow_name: 'deleted_workflow' }))
    const captured = captureScenarioFromLog(tampered)
    expect(captured.verification.ok).toBe(false)
    expect(captured.verification.issues.join(' ')).toMatch(/no workflow registered/)
  })

  it('flags a divergent (tampered) log instead of producing a false fixture', () => {
    const log = buildLog('rental_billing_run', 'rbr-3', [
      { type: 'APPROVE', approved_at: '2026-01-15T11:00:00.000Z', approved_by: 'e2e-admin' },
      { type: 'POST_REQUESTED' },
    ])
    // Corrupt the recorded snapshot_after of the first row — replay must catch it.
    const tampered = log.map((r, i) =>
      i === 0 ? { ...r, snapshot_after: { ...r.snapshot_after, state: 'posted' } } : r,
    )
    const captured = captureScenarioFromLog(tampered)
    expect(captured.verification.ok).toBe(false)
    expect(captured.verification.replayClean).toBe(false)
    expect(captured.verification.issues.join(' ')).toMatch(/replay diverged/)
  })
})

describe('captureScenarioToYaml', () => {
  it('emits a self-contained, re-runnable fixture with the verification verdict', () => {
    const log = buildLog('project_lifecycle', 'proj-1', [
      { type: 'START_ESTIMATING', actor_user_id: 'e2e-admin', occurred_at: '2026-01-15T09:00:00.000Z' },
      { type: 'SEND', actor_user_id: 'e2e-admin', occurred_at: '2026-01-15T10:00:00.000Z' },
      { type: 'DECLINE', actor_user_id: 'e2e-admin', occurred_at: '2026-01-15T11:00:00.000Z', reason: 'budget' },
    ])
    const yaml = captureScenarioToYaml(captureScenarioFromLog(log))
    expect(yaml).toMatch(/# Verification: OK/)
    expect(yaml).toMatch(/workflow: project_lifecycle/)
    expect(yaml).toMatch(/terminal_state: declined/)
    expect(yaml).toMatch(/type: DECLINE/)
    // payload emitted as a JSON flow-mapping (valid YAML), reason preserved,
    // redundant `type` stripped from the inline payload.
    expect(yaml).toMatch(/payload: \{"actor_user_id":"e2e-admin","occurred_at":".*","reason":"budget"\}/)
    expect(yaml).not.toMatch(/payload: \{"type"/)
  })

  it('marks a non-reproducible capture clearly in the header', () => {
    const yaml = captureScenarioToYaml(captureScenarioFromLog([]))
    expect(yaml).toMatch(/# Verification: NOT REPRODUCIBLE/)
  })
})
