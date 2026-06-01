import { describe, expect, it } from 'vitest'
import {
  buildWorkflowEventLogInsert,
  WORKFLOW_EVENT_LOG_COLUMNS,
  type WorkflowEventLogInsertArgs,
} from './event-log-insert.js'

const ARGS: WorkflowEventLogInsertArgs = {
  companyId: 'co-1',
  workflowName: 'rental',
  schemaVersion: 1,
  entityType: 'rental',
  entityId: 'ent-1',
  stateVersion: 3,
  eventType: 'CLOSE',
  eventPayload: { type: 'CLOSE', closed_by: 'u-1' },
  snapshotAfter: { state: 'closed', state_version: 4 },
  actorUserId: 'u-1',
  requestId: 'req-1',
  sentryTrace: 'trace-1',
  sentryBaggage: 'baggage-1',
  captureSessionId: '6f4a4c6e-7fd0-4a1c-befe-d1a8ddf9272a',
}

describe('buildWorkflowEventLogInsert', () => {
  it('emits the documented columns in order', () => {
    expect(WORKFLOW_EVENT_LOG_COLUMNS).toHaveLength(14)
    const { text } = buildWorkflowEventLogInsert(ARGS, { onConflict: 'throw' })
    for (const col of WORKFLOW_EVENT_LOG_COLUMNS) {
      expect(text).toContain(col)
    }
    // Column order is the contract the worker + API both rely on.
    expect(text).toContain(WORKFLOW_EVENT_LOG_COLUMNS.join(', '))
  })

  it('produces 14 values with placeholders $1..$14', () => {
    const { text, values } = buildWorkflowEventLogInsert(ARGS, { onConflict: 'throw' })
    expect(values).toHaveLength(14)
    expect(text).toContain('values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)')
  })

  it('serializes the two jsonb columns to strings', () => {
    const { values } = buildWorkflowEventLogInsert(ARGS, { onConflict: 'throw' })
    expect(values[7]).toBe(JSON.stringify(ARGS.eventPayload))
    expect(values[8]).toBe(JSON.stringify(ARGS.snapshotAfter))
  })

  it("appends the conflict clause for onConflict:'do_nothing'", () => {
    const { text } = buildWorkflowEventLogInsert(ARGS, { onConflict: 'do_nothing' })
    expect(text).toContain('on conflict (entity_id, workflow_name, state_version) do nothing')
  })

  it("omits the conflict clause for onConflict:'throw'", () => {
    const { text } = buildWorkflowEventLogInsert(ARGS, { onConflict: 'throw' })
    expect(text).not.toContain('on conflict')
  })

  it('defaults the nullable trace/actor fields to null', () => {
    const { values } = buildWorkflowEventLogInsert(
      {
        companyId: 'co-1',
        workflowName: 'rental',
        schemaVersion: 1,
        entityType: 'rental',
        entityId: 'ent-1',
        stateVersion: 3,
        eventType: 'CLOSE',
        eventPayload: {},
        snapshotAfter: {},
      },
      { onConflict: 'throw' },
    )
    // actor_user_id, request_id, sentry_trace, sentry_baggage, capture_session_id → null.
    expect(values[9]).toBeNull()
    expect(values[10]).toBeNull()
    expect(values[11]).toBeNull()
    expect(values[12]).toBeNull()
    expect(values[13]).toBeNull()
  })
})
