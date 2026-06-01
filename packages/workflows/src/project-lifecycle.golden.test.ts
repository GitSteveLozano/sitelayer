import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  PROJECT_LIFECYCLE_WORKFLOW_NAME,
  PROJECT_LIFECYCLE_WORKFLOW_SCHEMA_VERSION,
  transitionProjectLifecycleWorkflow,
  type ProjectLifecycleWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = PROJECT_LIFECYCLE_WORKFLOW_NAME
const SCHEMA = PROJECT_LIFECYCLE_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000020'

function entry(
  state_version: number,
  event_payload: Record<string, unknown> & { type: string },
  snapshot_after: ProjectLifecycleWorkflowSnapshot,
): WorkflowEventLogEntry {
  return {
    workflow_name: NAME,
    schema_version: SCHEMA,
    entity_id: ENTITY,
    state_version,
    event_payload,
    snapshot_after: snapshot_after as unknown as WorkflowEventLogEntry['snapshot_after'],
  }
}

describe('project-lifecycle — applyEventLog replay', () => {
  it('happy path: draft → estimating → sent → accepted → in_progress → done → archived', () => {
    let snap: ProjectLifecycleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []
    const actor = 'admin-user'

    const e1 = { type: 'START_ESTIMATING' as const, actor_user_id: actor, occurred_at: '2026-04-29T10:00:00.000Z' }
    let prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e1)
    log.push(entry(1, e1, snap))

    const e2 = { type: 'SEND' as const, actor_user_id: actor, occurred_at: '2026-04-29T11:00:00.000Z' }
    prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e2)
    log.push(entry(2, e2, snap))

    const e3 = { type: 'ACCEPT' as const, actor_user_id: actor, occurred_at: '2026-04-29T12:00:00.000Z' }
    prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e3)
    log.push(entry(3, e3, snap))

    const e4 = { type: 'START_WORK' as const, actor_user_id: actor, occurred_at: '2026-04-29T13:00:00.000Z' }
    prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e4)
    log.push(entry(4, e4, snap))

    const e5 = { type: 'COMPLETE' as const, actor_user_id: actor, occurred_at: '2026-04-29T14:00:00.000Z' }
    prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e5)
    log.push(entry(5, e5, snap))

    const e6 = { type: 'ARCHIVE' as const, actor_user_id: actor, occurred_at: '2026-04-29T15:00:00.000Z' }
    prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e6)
    log.push(entry(6, e6, snap))

    const initial: ProjectLifecycleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const result = applyEventLog<ProjectLifecycleWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('archived')
  })

  it('alternate path: estimating → sent → declined → archived', () => {
    let snap: ProjectLifecycleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []
    const actor = 'sales-user'

    const e1 = { type: 'START_ESTIMATING' as const, actor_user_id: actor, occurred_at: '2026-04-29T10:00:00.000Z' }
    let prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e1)
    log.push(entry(1, e1, snap))

    const e2 = { type: 'SEND' as const, actor_user_id: actor, occurred_at: '2026-04-29T11:00:00.000Z' }
    prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e2)
    log.push(entry(2, e2, snap))

    const e3 = {
      type: 'DECLINE' as const,
      actor_user_id: actor,
      occurred_at: '2026-04-29T12:00:00.000Z',
      reason: 'over budget',
    }
    prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e3)
    log.push(entry(3, e3, snap))

    const e4 = { type: 'ARCHIVE' as const, actor_user_id: actor, occurred_at: '2026-04-29T13:00:00.000Z' }
    prev = snap
    snap = transitionProjectLifecycleWorkflow(prev, e4)
    log.push(entry(4, e4, snap))

    const initial: ProjectLifecycleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const result = applyEventLog<ProjectLifecycleWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('archived')
    expect(result.finalSnapshot?.decline_reason).toBe('over budget')
  })
})

describe('project-lifecycle — REOPEN nulls in-row terminal timestamps, history survives in the log', () => {
  // Gap 6 invariant guard. terminalStates: [] is intentional: REOPEN lets
  // done/archived re-enter in_progress and clears lifecycle_completed_at /
  // lifecycle_archived_at on the row. The contract is "in-row = current
  // pass, log = history" — replaying the log must still surface the prior
  // COMPLETE's completed_at, even though the final row nulls it.
  it('… → COMPLETE → REOPEN: final snapshot nulls completed_at/archived_at but the COMPLETE event survives in the log', () => {
    let snap: ProjectLifecycleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []
    const actor = 'admin-user'

    const seq = [
      { type: 'START_ESTIMATING' as const, occurred_at: '2026-04-29T10:00:00.000Z' },
      { type: 'SEND' as const, occurred_at: '2026-04-29T11:00:00.000Z' },
      { type: 'ACCEPT' as const, occurred_at: '2026-04-29T12:00:00.000Z' },
      { type: 'START_WORK' as const, occurred_at: '2026-04-29T13:00:00.000Z' },
      { type: 'COMPLETE' as const, occurred_at: '2026-04-29T14:00:00.000Z' },
      { type: 'REOPEN' as const, occurred_at: '2026-04-29T15:00:00.000Z' },
    ]
    let version = 1
    for (const e of seq) {
      const event = { ...e, actor_user_id: actor }
      const prev = snap
      snap = transitionProjectLifecycleWorkflow(prev, event)
      log.push(entry(version, event, snap))
      version += 1
    }

    // (a) the in-row final snapshot reflects the CURRENT pass only.
    expect(snap.state).toBe('in_progress')
    expect(snap.completed_at).toBeNull()
    expect(snap.archived_at).toBeNull()

    // (b) replaying the log still surfaces the historical COMPLETE's
    //     completed_at — history is recoverable even though the row nulls it.
    const completeEntry = log.find((l) => (l.event_payload as { type: string }).type === 'COMPLETE')
    expect(completeEntry).toBeDefined()
    expect((completeEntry?.snapshot_after as unknown as ProjectLifecycleWorkflowSnapshot).completed_at).toBe(
      '2026-04-29T14:00:00.000Z',
    )

    // (c) the replay harness agrees the log is internally consistent.
    const initial: ProjectLifecycleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const result = applyEventLog<ProjectLifecycleWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('in_progress')
    expect(result.finalSnapshot?.completed_at).toBeNull()
  })

  it('property: any sequence ending in REOPEN nulls both completed_at and archived_at in-row', () => {
    // Enumerate the two reachable REOPEN entry paths (from done, from
    // archived) plus an ARCHIVE-then-REOPEN; assert the post-REOPEN
    // in-row contract holds regardless of how the terminal state was reached.
    const paths: Array<Array<{ type: string; occurred_at: string }>> = [
      // done → REOPEN
      [
        { type: 'START_ESTIMATING', occurred_at: '2026-01-01T00:00:00.000Z' },
        { type: 'SEND', occurred_at: '2026-01-01T01:00:00.000Z' },
        { type: 'ACCEPT', occurred_at: '2026-01-01T02:00:00.000Z' },
        { type: 'START_WORK', occurred_at: '2026-01-01T03:00:00.000Z' },
        { type: 'COMPLETE', occurred_at: '2026-01-01T04:00:00.000Z' },
        { type: 'REOPEN', occurred_at: '2026-01-01T05:00:00.000Z' },
      ],
      // done → archived → REOPEN
      [
        { type: 'START_ESTIMATING', occurred_at: '2026-02-01T00:00:00.000Z' },
        { type: 'SEND', occurred_at: '2026-02-01T01:00:00.000Z' },
        { type: 'ACCEPT', occurred_at: '2026-02-01T02:00:00.000Z' },
        { type: 'START_WORK', occurred_at: '2026-02-01T03:00:00.000Z' },
        { type: 'COMPLETE', occurred_at: '2026-02-01T04:00:00.000Z' },
        { type: 'ARCHIVE', occurred_at: '2026-02-01T05:00:00.000Z' },
        { type: 'REOPEN', occurred_at: '2026-02-01T06:00:00.000Z' },
      ],
    ]

    for (const path of paths) {
      let snap: ProjectLifecycleWorkflowSnapshot = { state: 'draft', state_version: 1 }
      for (const e of path) {
        snap = transitionProjectLifecycleWorkflow(snap, { ...e, actor_user_id: 'u' } as never)
      }
      expect(snap.state).toBe('in_progress')
      expect(snap.completed_at).toBeNull()
      expect(snap.archived_at).toBeNull()
    }
  })
})
