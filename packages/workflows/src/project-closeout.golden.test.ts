import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  PROJECT_CLOSEOUT_WORKFLOW_NAME,
  PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION,
  transitionProjectCloseoutWorkflow,
  type ProjectCloseoutWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = PROJECT_CLOSEOUT_WORKFLOW_NAME
const SCHEMA = PROJECT_CLOSEOUT_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000130'

describe('project-closeout — applyEventLog replay', () => {
  it('happy path: active → completed', () => {
    const initial: ProjectCloseoutWorkflowSnapshot = { state: 'active', state_version: 1 }
    const closeoutEvent = {
      type: 'CLOSEOUT' as const,
      closed_at: '2026-04-29T15:00:00.000Z',
      closed_by: 'office-user',
    }
    const completed = transitionProjectCloseoutWorkflow(initial, closeoutEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: closeoutEvent,
        snapshot_after: completed as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]
    const result = applyEventLog<ProjectCloseoutWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('completed')
  })

  it('alternate path: detects state_version gap when log skips ahead', () => {
    // Project closeout has only one transition. The alternate fixture
    // exercises the harness's gap-detection branch.
    const initial: ProjectCloseoutWorkflowSnapshot = { state: 'active', state_version: 1 }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        // skips state_version=1
        state_version: 5,
        event_payload: {
          type: 'CLOSEOUT',
          closed_at: '2026-04-29T15:00:00.000Z',
          closed_by: 'office',
        },
        snapshot_after: { state: 'completed', state_version: 6 },
      },
    ]
    const result = applyEventLog<ProjectCloseoutWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('gap')
  })
})
