import { describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { createFieldEventsRunner } from './field-events.js'

// Unit tests for the field-events runner. Two surfaces:
//
//   drainNotifications  → wraps processFieldEventNotifications. Claims
//                         notify_worker_resolution / notify_estimator_escalation /
//                         notify_foreman_assignment / notify_field_request_denied
//                         outbox rows and inserts per-recipient
//                         `notifications` rows.
//
//   runAutoEscalation   → wraps processFieldEventAutoEscalation. Periodic-timer
//                         claim of severity='stopped' worker_issues that have
//                         been open beyond the threshold; runs the ESCALATE
//                         reducer and persists the transition.

const testLogger = createLogger('field-events-runner-test', { level: 'silent' })

type FakeRow = QueryResultRow

interface FakeCall {
  sql: string
  params: ReadonlyArray<unknown>
}

type Responder = (sql: string, params: ReadonlyArray<unknown>) => Partial<QueryResult<FakeRow>> | Error | undefined

function buildResponse(r: Partial<QueryResult<FakeRow>>): QueryResult<FakeRow> {
  return {
    rows: r.rows ?? [],
    rowCount: r.rowCount ?? r.rows?.length ?? 0,
    command: r.command ?? '',
    oid: r.oid ?? 0,
    fields: r.fields ?? [],
  }
}

function makePool(responder: Responder): { pool: Pool; calls: FakeCall[]; released: boolean[] } {
  const calls: FakeCall[] = []
  const released: boolean[] = []
  function makeClient(): PoolClient {
    const idx = released.length
    released.push(false)
    const client: Partial<PoolClient> = {
      query: vi.fn(async (sql: string, params?: ReadonlyArray<unknown>) => {
        calls.push({ sql, params: params ?? [] })
        const r = responder(sql, params ?? [])
        if (r instanceof Error) throw r
        return buildResponse(r ?? {})
      }) as unknown as PoolClient['query'],
      release: vi.fn(() => {
        released[idx] = true
      }) as unknown as PoolClient['release'],
    }
    return client as PoolClient
  }
  const pool: Partial<Pool> = {
    connect: vi.fn(async () => makeClient()) as unknown as Pool['connect'],
  }
  return { pool: pool as Pool, calls, released }
}

describe('createFieldEventsRunner — drainNotifications', () => {
  it('empty pass — no claimed outbox rows → zero summary', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox')) return { rows: [], rowCount: 0 }
      return { rows: [] }
    }
    const { pool, released } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    const summary = await runner.drainNotifications('co-1')
    expect(summary).toEqual({ processed: 0, notified: 0, skipped: 0, failed: 0 })
    expect(released[0]).toBe(true)
  })

  it('happy path — notify_worker_resolution inserts a notification for the reporter', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'issue-1',
      mutation_type: 'notify_worker_resolution',
      payload: {
        reporter_clerk_user_id: 'user_reporter',
        message_to_worker: 'Fixed the leak',
        action: 'resolved',
      },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('insert into notifications')) return { rows: [], rowCount: 1 }
      if (sql.includes('update mutation_outbox') && sql.includes("'applied'")) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    const summary = await runner.drainNotifications('co-1')
    expect(summary).toEqual({ processed: 1, notified: 1, skipped: 0, failed: 0 })

    const insert = calls.find((c) => c.sql.includes('insert into notifications'))
    expect(insert).toBeDefined()
    // params: companyId, recipientUserId, kind, subject, text, payload
    expect(insert!.params[1]).toBe('user_reporter')
    expect(insert!.params[2]).toBe('worker_issue_resolved')
    expect(String(insert!.params[4])).toMatch(/Fixed the leak/)

    const applied = calls.find((c) => c.sql.includes('update mutation_outbox') && c.sql.includes("'applied'"))
    expect(applied).toBeDefined()
  })

  it('happy path — notify_estimator_escalation fans out one notification per estimator', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'issue-1',
      mutation_type: 'notify_estimator_escalation',
      payload: {
        reason: 'Crane broke',
        kind: 'equipment',
        severity: 'stopped',
      },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('from company_memberships cm')) {
        // Two admin members → two notifications.
        return {
          rows: [{ clerk_user_id: 'user_admin1' }, { clerk_user_id: 'user_admin2' }],
          rowCount: 2,
        }
      }
      if (sql.includes('insert into notifications')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    const summary = await runner.drainNotifications('co-1')
    expect(summary.notified).toBe(1)
    const inserts = calls.filter((c) => c.sql.includes('insert into notifications'))
    expect(inserts).toHaveLength(2)
    expect(inserts[0]!.params[1]).toBe('user_admin1')
    expect(inserts[1]!.params[1]).toBe('user_admin2')
    expect(inserts[0]!.params[2]).toBe('field_event_escalation')
  })

  it('happy path — notify_field_request_denied inserts a deep-linked notification for the filing foreman', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'work-item-9',
      mutation_type: 'notify_field_request_denied',
      payload: {
        work_item_id: 'work-item-9',
        title: '$510 EPS order',
        denial_message: 'Aspen is already over budget. Pull what you can from yard.',
        denied_by_user_id: 'user_owner',
        recipient_user_id: 'user_foreman',
        route: '/foreman/denied/work-item-9',
      },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('insert into notifications')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    const summary = await runner.drainNotifications('co-1')
    expect(summary).toEqual({ processed: 1, notified: 1, skipped: 0, failed: 0 })

    const insert = calls.find((c) => c.sql.includes('insert into notifications'))
    expect(insert).toBeDefined()
    // params: companyId, recipientUserId, kind, subject, text, payload
    expect(insert!.params[1]).toBe('user_foreman')
    expect(insert!.params[2]).toBe('field_request_denied')
    expect(String(insert!.params[3])).toMatch(/\$510 EPS order/)
    expect(String(insert!.params[4])).toMatch(/over budget/)
    const payload = JSON.parse(String(insert!.params[5])) as Record<string, unknown>
    expect(payload.route).toBe('/foreman/denied/work-item-9')
  })

  it('skip path — notify_field_request_denied with no creator id → marks outbox applied, no insert', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'work-item-9',
      mutation_type: 'notify_field_request_denied',
      payload: { title: 'Orphan request', denial_message: 'no creator on row' },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    const summary = await runner.drainNotifications('co-1')
    expect(summary).toEqual({ processed: 1, notified: 0, skipped: 1, failed: 0 })
    expect(calls.find((c) => c.sql.includes('insert into notifications'))).toBeUndefined()
  })

  it('skip path — notify_worker_resolution with no reporter id → marks outbox applied, no insert', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'issue-1',
      mutation_type: 'notify_worker_resolution',
      payload: { message_to_worker: 'orphan message' },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    const summary = await runner.drainNotifications('co-1')
    expect(summary).toEqual({ processed: 1, notified: 0, skipped: 1, failed: 0 })
    // No notifications insert — went through the no-recipient fast-skip.
    expect(calls.find((c) => c.sql.includes('insert into notifications'))).toBeUndefined()
  })

  it('failure path — DB error on insert → outbox stays pending (retry), failed counter increments', async () => {
    const claimedRow = {
      id: 'outbox-1',
      entity_id: 'issue-1',
      mutation_type: 'notify_worker_resolution',
      payload: { reporter_clerk_user_id: 'user_x' },
      attempt_count: 1,
    }
    const responder: Responder = (sql) => {
      if (sql.includes('update mutation_outbox') && sql.includes("'processing'")) {
        return { rows: [claimedRow], rowCount: 1 }
      }
      if (sql.includes('insert into notifications')) {
        return new Error('database connection lost')
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    const summary = await runner.drainNotifications('co-1')
    expect(summary.failed).toBe(1)
    // Error captured in a recovery UPDATE on mutation_outbox.
    const recovery = calls.find(
      (c) => c.sql.includes('update mutation_outbox') && c.sql.includes('next_attempt_at') && c.sql.includes('error'),
    )
    expect(recovery).toBeDefined()
  })
})

describe('createFieldEventsRunner — runAutoEscalation', () => {
  it('empty pass — no severity=stopped rows due → no-op, no error thrown', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('from worker_issues')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls, released } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    await runner.runAutoEscalation('co-1')
    // begin + claim + commit (no rows to process).
    expect(calls.find((c) => c.sql === 'begin')).toBeDefined()
    expect(calls.find((c) => c.sql === 'commit')).toBeDefined()
    expect(released[0]).toBe(true)
  })

  it('happy path — claims a stuck worker_issue and applies ESCALATE transition', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('from worker_issues')) {
        return {
          rows: [{ id: 'issue-1', company_id: 'co-1', state_version: 1 }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    await runner.runAutoEscalation('co-1')
    // State update + workflow_event_log insert.
    const stateUpdate = calls.find((c) => c.sql.includes('update worker_issues'))
    expect(stateUpdate).toBeDefined()
    expect(stateUpdate!.params[1]).toBe(2) // state_version bumped from 1 → 2
    expect(stateUpdate!.params[3]).toBe('auto_15min_stopped')
    const eventInsert = calls.find((c) => c.sql.includes('insert into workflow_event_log'))
    expect(eventInsert).toBeDefined()
    expect(eventInsert!.params[6]).toBe('system:auto-escalation') // actor
  })

  it('rolls back on outer error and releases the client', async () => {
    const responder: Responder = (sql) => {
      if (sql.includes('from worker_issues')) return new Error('catastrophic DB failure')
      return { rows: [], rowCount: 1 }
    }
    const { pool, calls, released } = makePool(responder)
    const runner = createFieldEventsRunner({ pool, logger: testLogger })
    // The runner swallows the error via captureWithEntityContext + logger.error,
    // so the promise should resolve.
    await expect(runner.runAutoEscalation('co-1')).resolves.toBeUndefined()
    expect(calls.find((c) => c.sql === 'rollback')).toBeDefined()
    expect(released[0]).toBe(true)
  })
})
