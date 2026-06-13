import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  DAILY_LOG_ALL_STATES,
  DAILY_LOG_WORKFLOW_NAME,
  DAILY_LOG_WORKFLOW_SCHEMA_VERSION,
  nextDailyLogEvents,
  transitionDailyLogWorkflow,
  type DailyLogWorkflowEvent,
  type DailyLogWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = DAILY_LOG_WORKFLOW_NAME
const SCHEMA = DAILY_LOG_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000082'

function entry(
  state_version: number,
  event: DailyLogWorkflowEvent,
  snapshot_after: DailyLogWorkflowSnapshot,
): WorkflowEventLogEntry {
  return {
    workflow_name: NAME,
    schema_version: SCHEMA,
    entity_id: ENTITY,
    state_version,
    event_payload: event,
    snapshot_after: snapshot_after as unknown as WorkflowEventLogEntry['snapshot_after'],
  }
}

describe('daily-log — golden next_events map', () => {
  it('freezes the per-state next_events affordance set', () => {
    const map = Object.fromEntries(DAILY_LOG_ALL_STATES.map((s) => [s, nextDailyLogEvents(s)]))
    expect(map).toMatchInlineSnapshot(`
      {
        "draft": [
          {
            "label": "Submit daily log",
            "type": "SUBMIT",
          },
        ],
        "submitted": [],
      }
    `)
  })
})

describe('daily-log — applyEventLog replay', () => {
  it('happy path: draft → submitted', () => {
    const initial: DailyLogWorkflowSnapshot = { state: 'draft', state_version: 1 }

    const submitEvent: DailyLogWorkflowEvent = {
      type: 'SUBMIT',
      submitted_at: '2026-05-01T17:00:00.000Z',
      submitted_by: 'foreman-1',
    }
    const submitted = transitionDailyLogWorkflow(initial, submitEvent)

    const log: WorkflowEventLogEntry[] = [entry(1, submitEvent, submitted)]
    const result = applyEventLog<DailyLogWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('submitted')
    expect(result.finalSnapshot?.state_version).toBe(2)
    expect(result.finalSnapshot?.submitted_at).toBe('2026-05-01T17:00:00.000Z')
    expect(result.finalSnapshot?.submitted_by).toBe('foreman-1')
  })

  it('SUBMIT is rejected from the terminal submitted state', () => {
    const submitted: DailyLogWorkflowSnapshot = { state: 'submitted', state_version: 2 }
    expect(() =>
      transitionDailyLogWorkflow(submitted, {
        type: 'SUBMIT',
        submitted_at: '2026-05-01T18:00:00.000Z',
        submitted_by: 'foreman-1',
      }),
    ).toThrow()
  })
})
