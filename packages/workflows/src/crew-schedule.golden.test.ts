import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  CREW_SCHEDULE_WORKFLOW_NAME,
  CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION,
  transitionCrewScheduleWorkflow,
  type CrewScheduleWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = CREW_SCHEDULE_WORKFLOW_NAME
const SCHEMA = CREW_SCHEDULE_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000070'

describe('crew-schedule — applyEventLog replay', () => {
  it('happy path: draft → confirmed', () => {
    const initial: CrewScheduleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const confirmEvent = {
      type: 'CONFIRM' as const,
      confirmed_at: '2026-04-29T15:00:00.000Z',
      confirmed_by: 'foreman-1',
    }
    const confirmed = transitionCrewScheduleWorkflow(initial, confirmEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: confirmEvent,
        snapshot_after: confirmed as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]

    const result = applyEventLog<CrewScheduleWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('confirmed')
    expect(result.finalSnapshot?.confirmed_by).toBe('foreman-1')
  })

  it('corpus: [CREATE, CONFIRM] replays to confirmed', () => {
    const seed: CrewScheduleWorkflowSnapshot = { state: 'draft', state_version: 0 }
    const createEvent = { type: 'CREATE' as const, created_by: 'office-1' }
    const created = transitionCrewScheduleWorkflow(seed, createEvent)
    const confirmEvent = { type: 'CONFIRM' as const, confirmed_at: '2026-04-29T15:00:00.000Z', confirmed_by: 'fm-1' }
    const confirmed = transitionCrewScheduleWorkflow(created, confirmEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        // CREATE is the genesis row: dispatched against the draft@0 seed
        // (state_version 0) and advancing to draft@1.
        state_version: 0,
        event_payload: createEvent,
        snapshot_after: created as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: confirmEvent,
        snapshot_after: confirmed as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]

    const result = applyEventLog<CrewScheduleWorkflowSnapshot>(seed, log)
    expect(result.ok, JSON.stringify(result.issues)).toBe(true)
    expect(result.finalSnapshot?.state).toBe('confirmed')
    expect(result.finalSnapshot?.created_by).toBe('office-1')
  })

  it('corpus: [CREATE, DECLINE, REASSIGN, CONFIRM] replays to confirmed', () => {
    const seed: CrewScheduleWorkflowSnapshot = { state: 'draft', state_version: 0 }
    const createEvent = { type: 'CREATE' as const, created_by: 'office-1' }
    const created = transitionCrewScheduleWorkflow(seed, createEvent)
    const declineEvent = {
      type: 'DECLINE' as const,
      declined_at: '2026-04-29T15:00:00.000Z',
      declined_by: 'worker-1',
      reason: 'double-booked',
    }
    const declined = transitionCrewScheduleWorkflow(created, declineEvent)
    const reassignEvent = { type: 'REASSIGN' as const }
    const reassigned = transitionCrewScheduleWorkflow(declined, reassignEvent)
    const confirmEvent = { type: 'CONFIRM' as const, confirmed_at: '2026-04-30T15:00:00.000Z', confirmed_by: 'fm-1' }
    const confirmed = transitionCrewScheduleWorkflow(reassigned, confirmEvent)

    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        // Genesis CREATE: draft@0 seed → draft@1.
        state_version: 0,
        event_payload: createEvent,
        snapshot_after: created as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: declineEvent,
        snapshot_after: declined as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 2,
        event_payload: reassignEvent,
        snapshot_after: reassigned as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
      {
        workflow_name: NAME,
        schema_version: SCHEMA,
        entity_id: ENTITY,
        state_version: 3,
        event_payload: confirmEvent,
        snapshot_after: confirmed as unknown as WorkflowEventLogEntry['snapshot_after'],
      },
    ]

    const result = applyEventLog<CrewScheduleWorkflowSnapshot>(seed, log)
    expect(result.ok, JSON.stringify(result.issues)).toBe(true)
    expect(result.finalSnapshot?.state).toBe('confirmed')
    expect(result.finalSnapshot?.decline_reason).toBeNull()
  })

  it('alternate path: replay detects schema_version_mismatch', () => {
    // Crew-schedule has only one happy path, so the alternate fixture
    // exercises the harness divergence-detection branch.
    const initial: CrewScheduleWorkflowSnapshot = { state: 'draft', state_version: 1 }
    const log: WorkflowEventLogEntry[] = [
      {
        workflow_name: NAME,
        schema_version: 999,
        entity_id: ENTITY,
        state_version: 1,
        event_payload: { type: 'CONFIRM' },
        snapshot_after: { state: 'confirmed', state_version: 2 },
      },
    ]
    const result = applyEventLog<CrewScheduleWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.reason).toBe('schema_version_mismatch')
  })
})
