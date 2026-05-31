import { describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import {
  FIELD_EVENT_WORKFLOW_NAME,
  FIELD_EVENT_WORKFLOW_SCHEMA_VERSION,
  transitionFieldEventWorkflow,
  type FieldEventWorkflowSnapshot,
} from '@sitelayer/workflows'
import { processFieldEventAutoEscalation } from './field-event-escalation.js'

/**
 * Lock the contract this module relies on: the reducer accepts a
 * minimal snapshot and an ESCALATE event with the system-actor id, and
 * advances the state machine without throwing. The actual DB-driven
 * `processFieldEventAutoEscalation` is gated on integration tests
 * (RUN_API_INTEGRATION=1); this test runs at the reducer boundary.
 */
describe('field-event auto-escalation contract', () => {
  it('reducer accepts a minimal snapshot + ESCALATE event with system actor', () => {
    const snapshot: FieldEventWorkflowSnapshot = { state: 'open', state_version: 1 }
    const next = transitionFieldEventWorkflow(snapshot, {
      type: 'ESCALATE',
      escalated_at: '2026-05-16T12:00:00.000Z',
      escalator_user_id: 'system:auto-escalation',
      reason: 'auto_15min_stopped',
    })
    expect(next.state).toBe('escalated')
    expect(next.state_version).toBe(2)
    expect(next.escalated_to_estimator_at).toBe('2026-05-16T12:00:00.000Z')
    expect(next.escalation_reason).toBe('auto_15min_stopped')
    expect(next.last_actor_user_id).toBe('system:auto-escalation')
  })

  it('refuses ESCALATE from a non-open state (the worker query filters but defense-in-depth holds)', () => {
    const snapshot: FieldEventWorkflowSnapshot = { state: 'resolved', state_version: 5 }
    expect(() =>
      transitionFieldEventWorkflow(snapshot, {
        type: 'ESCALATE',
        escalated_at: '2026-05-16T12:00:00.000Z',
        escalator_user_id: 'system:auto-escalation',
        reason: 'auto_15min_stopped',
      }),
    ).toThrow(/not allowed/)
  })

  it('exposes the workflow constants the worker uses for event-log writes', () => {
    expect(FIELD_EVENT_WORKFLOW_NAME).toBe('field_event')
    expect(FIELD_EVENT_WORKFLOW_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Claim + transition against a fake PoolClient. This is the regression test
// that the severity-column wiring (apps/api create path) was load-bearing:
// a UI-shaped row with the typed `severity='stopped'` column and `state='open'`
// is claimed and escalated; a row that only carried severity in the message
// body (state defaulting, severity='slowing') is NOT.
// ---------------------------------------------------------------------------

type StoredIssue = {
  id: string
  company_id: string
  state: string
  severity: string
  state_version: number
  escalated_to_estimator_at: string | null
  escalation_reason: string | null
  aged: boolean
}

class FakeClient {
  issues: StoredIssue[] = []
  eventLog: unknown[][] = []

  async query(sqlRaw: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = sqlRaw.trim()
    // Claim: select open + stopped + aged rows. The age predicate is
    // `created_at <= now() - interval`; modeled here by the `aged` flag.
    if (/^select\s+id,\s*company_id,\s*state_version\s+from\s+worker_issues/i.test(sql)) {
      expect(sql).toMatch(/state\s*=\s*'open'/i)
      expect(sql).toMatch(/severity\s*=\s*'stopped'/i)
      const companyId = params[0] as string
      const rows = this.issues
        .filter((r) => r.company_id === companyId && r.state === 'open' && r.severity === 'stopped' && r.aged)
        .map((r) => ({ id: r.id, company_id: r.company_id, state_version: r.state_version }))
      return { rows, rowCount: rows.length }
    }
    if (/^update\s+worker_issues/i.test(sql)) {
      // [id, state_version, escalated_at, reason, state]
      const [id, version, escalatedAt, reason, state] = params as [string, number, string, string, string]
      const row = this.issues.find((r) => r.id === id)
      if (row) {
        row.state = state
        row.state_version = version
        row.escalated_to_estimator_at = escalatedAt
        row.escalation_reason = reason
      }
      return { rows: [], rowCount: row ? 1 : 0 }
    }
    if (/^insert\s+into\s+workflow_event_log/i.test(sql)) {
      this.eventLog.push(params)
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 120)}`)
  }
}

describe('processFieldEventAutoEscalation — severity-column claim', () => {
  it('escalates a UI-shaped open + stopped + aged row', async () => {
    const client = new FakeClient()
    client.issues.push({
      id: 'wi-1',
      company_id: 'co-1',
      state: 'open',
      severity: 'stopped',
      state_version: 1,
      escalated_to_estimator_at: null,
      escalation_reason: null,
      aged: true,
    })
    const summary = await processFieldEventAutoEscalation(client as unknown as PoolClient, 'co-1')
    expect(summary).toEqual({ processed: 1, escalated: 1, failed: 0 })
    const row = client.issues[0]!
    expect(row.state).toBe('escalated')
    expect(row.state_version).toBe(2)
    expect(row.escalation_reason).toBe('auto_15min_stopped')
    expect(client.eventLog).toHaveLength(1)
  })

  it('does NOT escalate a slowing row (the pre-fix UI-tag bug: severity never reached the column)', async () => {
    const client = new FakeClient()
    client.issues.push({
      id: 'wi-2',
      company_id: 'co-1',
      state: 'open',
      severity: 'slowing',
      state_version: 1,
      escalated_to_estimator_at: null,
      escalation_reason: null,
      aged: true,
    })
    const summary = await processFieldEventAutoEscalation(client as unknown as PoolClient, 'co-1')
    expect(summary).toEqual({ processed: 0, escalated: 0, failed: 0 })
    expect(client.issues[0]!.state).toBe('open')
  })
})
