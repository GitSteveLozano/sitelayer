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
