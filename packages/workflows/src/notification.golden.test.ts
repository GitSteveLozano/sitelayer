import { describe, it, expect } from 'vitest'
import {
  applyEventLog,
  NOTIFICATION_ALL_STATES,
  NOTIFICATION_WORKFLOW_NAME,
  NOTIFICATION_WORKFLOW_SCHEMA_VERSION,
  nextNotificationEvents,
  transitionNotificationWorkflow,
  type NotificationWorkflowEvent,
  type NotificationWorkflowSnapshot,
  type WorkflowEventLogEntry,
} from './index.js'

const NAME = NOTIFICATION_WORKFLOW_NAME
const SCHEMA = NOTIFICATION_WORKFLOW_SCHEMA_VERSION
const ENTITY = '00000000-0000-0000-0000-000000000081'

function entry(
  state_version: number,
  event: NotificationWorkflowEvent,
  snapshot_after: NotificationWorkflowSnapshot,
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

describe('notification — golden next_events map', () => {
  it('freezes the per-state next_events affordance set', () => {
    const map = Object.fromEntries(NOTIFICATION_ALL_STATES.map((s) => [s, nextNotificationEvents(s)]))
    expect(map).toMatchInlineSnapshot(`
      {
        "failed_clerk_not_found": [],
        "failed_clerk_unreachable": [
          {
            "label": "Retry delivery",
            "type": "RETRY",
          },
          {
            "label": "Cancel notification",
            "type": "VOID",
          },
        ],
        "failed_provider": [
          {
            "label": "Retry delivery",
            "type": "RETRY",
          },
          {
            "label": "Cancel notification",
            "type": "VOID",
          },
        ],
        "hydrating": [
          {
            "label": "Cancel notification",
            "type": "VOID",
          },
        ],
        "pending": [
          {
            "label": "Cancel notification",
            "type": "VOID",
          },
        ],
        "sending": [],
        "sent": [],
        "voided": [],
      }
    `)
  })
})

describe('notification — applyEventLog replay', () => {
  it('happy path: pending → hydrating → sending → sent', () => {
    let snap: NotificationWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const hydrateEvent: NotificationWorkflowEvent = {
      type: 'HYDRATE',
      hydrated_at: '2026-05-01T09:00:00.000Z',
      recipient_email: 'foreman@example.com',
    }
    snap = transitionNotificationWorkflow(snap, hydrateEvent)
    log.push(entry(1, hydrateEvent, snap))

    const requestEvent: NotificationWorkflowEvent = {
      type: 'SEND_REQUESTED',
      requested_at: '2026-05-01T09:00:05.000Z',
    }
    snap = transitionNotificationWorkflow(snap, requestEvent)
    log.push(entry(2, requestEvent, snap))

    const succeededEvent: NotificationWorkflowEvent = {
      type: 'SEND_SUCCEEDED',
      sent_at: '2026-05-01T09:00:10.000Z',
      channel: 'email',
    }
    snap = transitionNotificationWorkflow(snap, succeededEvent)
    log.push(entry(3, succeededEvent, snap))

    const initial: NotificationWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const result = applyEventLog<NotificationWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('sent')
    expect(result.finalSnapshot?.state_version).toBe(4)
    expect(result.finalSnapshot?.recipient_email).toBe('foreman@example.com')
    expect(result.finalSnapshot?.channel).toBe('email')
  })

  it('retry path: provider failure → retry → pending → sending → sent', () => {
    let snap: NotificationWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const log: WorkflowEventLogEntry[] = []

    const requestEvent: NotificationWorkflowEvent = {
      type: 'SEND_REQUESTED',
      requested_at: '2026-05-01T09:00:00.000Z',
    }
    snap = transitionNotificationWorkflow(snap, requestEvent)
    log.push(entry(1, requestEvent, snap))

    const failEvent: NotificationWorkflowEvent = {
      type: 'SEND_FAILED',
      failed_at: '2026-05-01T09:00:05.000Z',
      error: 'smtp 5xx',
      kind: 'provider',
    }
    snap = transitionNotificationWorkflow(snap, failEvent)
    log.push(entry(2, failEvent, snap))
    expect(snap.state).toBe('failed_provider')

    const retryEvent: NotificationWorkflowEvent = {
      type: 'RETRY',
      retried_at: '2026-05-01T09:01:00.000Z',
    }
    snap = transitionNotificationWorkflow(snap, retryEvent)
    log.push(entry(3, retryEvent, snap))
    expect(snap.state).toBe('pending')

    const reRequestEvent: NotificationWorkflowEvent = {
      type: 'SEND_REQUESTED',
      requested_at: '2026-05-01T09:01:05.000Z',
    }
    snap = transitionNotificationWorkflow(snap, reRequestEvent)
    log.push(entry(4, reRequestEvent, snap))

    const succeededEvent: NotificationWorkflowEvent = {
      type: 'SEND_SUCCEEDED',
      sent_at: '2026-05-01T09:01:10.000Z',
      channel: 'push',
    }
    snap = transitionNotificationWorkflow(snap, succeededEvent)
    log.push(entry(5, succeededEvent, snap))

    const initial: NotificationWorkflowSnapshot = { state: 'pending', state_version: 1 }
    const result = applyEventLog<NotificationWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    expect(result.finalSnapshot?.state).toBe('sent')
    expect(result.finalSnapshot?.error).toBeNull()
  })

  it('terminal failure path: hydrating → clerk-not-found (no recovery)', () => {
    const initial: NotificationWorkflowSnapshot = { state: 'pending', state_version: 1 }

    const hydrateEvent: NotificationWorkflowEvent = {
      type: 'HYDRATE',
      hydrated_at: '2026-05-01T09:00:00.000Z',
      recipient_email: 'ghost@example.com',
    }
    const hydrating = transitionNotificationWorkflow(initial, hydrateEvent)

    const failEvent: NotificationWorkflowEvent = {
      type: 'SEND_FAILED',
      failed_at: '2026-05-01T09:00:05.000Z',
      error: 'user not found',
      kind: 'clerk_not_found',
    }
    const failed = transitionNotificationWorkflow(hydrating, failEvent)

    const log: WorkflowEventLogEntry[] = [entry(1, hydrateEvent, hydrating), entry(2, failEvent, failed)]
    const result = applyEventLog<NotificationWorkflowSnapshot>(initial, log)
    expect(result.ok).toBe(true)
    expect(result.finalSnapshot?.state).toBe('failed_clerk_not_found')
    expect(result.finalSnapshot?.failure_kind).toBe('clerk_not_found')
  })
})
