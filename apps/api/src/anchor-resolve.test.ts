import { describe, expect, it } from 'vitest'
import {
  RENTAL_BILLING_WORKFLOW_NAME,
  RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
  workflowEventRef,
} from '@sitelayer/workflows'
import { buildCaptureSessionAnchors } from './anchor-resolve.js'
import type { LedgerExecutor } from './mutation-tx.js'

// ---------------------------------------------------------------------------
// buildCaptureSessionAnchors — the in-process anchor + deterministic-replay
// weave the capture-session finalize path runs on its own tx client. Verifies:
// resolving the workflow.transition marks of a session, the replay first
// divergence surfacing, recency ordering, the cap, and defensive skipping of
// anchors that can't resolve (finalize must never throw on a bad anchor).
// ---------------------------------------------------------------------------

const COMPANY_ID = '00000000-0000-4000-8000-000000000abc'
const ENTITY_ID = '11111111-2222-3333-4444-555555555555'
const CAPTURE_SESSION_ID = '99999999-8888-7777-6666-555555555555'

type EventLogFixture = {
  company_id: string
  workflow_name: string
  schema_version: number
  entity_type: string
  entity_id: string
  state_version: number
  event_type: string
  event_payload: Record<string, unknown>
  snapshot_after: Record<string, unknown>
  applied_at: string
  sentry_trace: string | null
}

type MarkFixture = {
  company_id: string
  capture_session_id: string
  event_type: string
  occurred_at: string
  event_ref: string | null
}

class FakeClient {
  eventLog: EventLogFixture[] = []
  marks: MarkFixture[] = []

  query = (async (sqlRaw: string, params: unknown[] = []) => {
    const sql = sqlRaw.trim()
    // The transition-mark scan (distinct on payload->>'event_ref').
    if (/from capture_session_events/i.test(sql) && /workflow\.transition/i.test(sql)) {
      const [companyId, sessionId] = params as [string, string]
      const seen = new Set<string>()
      const rows: { event_ref: string }[] = []
      for (const m of this.marks) {
        if (m.company_id !== companyId || m.capture_session_id !== sessionId) continue
        if (m.event_type !== 'workflow.transition' || !m.event_ref) continue
        if (seen.has(m.event_ref)) continue
        seen.add(m.event_ref)
        rows.push({ event_ref: m.event_ref })
      }
      return { rows, rowCount: rows.length }
    }
    // Anchor resolve by (workflow_name, state_version).
    if (/from workflow_event_log/i.test(sql) && /and state_version = \$3/i.test(sql)) {
      const [companyId, workflowName, stateVersion] = params as [string, string, number]
      const rows = this.eventLog.filter(
        (r) => r.company_id === companyId && r.workflow_name === workflowName && r.state_version === stateVersion,
      )
      return { rows, rowCount: rows.length }
    }
    // Entity bracket by (workflow_name, entity_type, entity_id).
    if (/from workflow_event_log/i.test(sql) && /entity_id = \$4::uuid/i.test(sql)) {
      const [companyId, workflowName, entityType, entityId] = params as [string, string, string, string]
      const rows = this.eventLog
        .filter(
          (r) =>
            r.company_id === companyId &&
            r.workflow_name === workflowName &&
            r.entity_type === entityType &&
            r.entity_id === entityId,
        )
        .sort((a, b) => a.state_version - b.state_version)
      return { rows, rowCount: rows.length }
    }
    // Capture session / artifact lookups inside resolveAnchor — no fixtures.
    if (/from capture_sessions/i.test(sql) || /from capture_artifacts/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    // The mark lookup inside resolveAnchor (loadAnchorMarks).
    if (/from capture_session_events/i.test(sql)) {
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected SQL in anchor-resolve test: ${sql.slice(0, 80)}`)
  }) as LedgerExecutor['query']
}

function approveRow(stateVersion: number, appliedAt: string): EventLogFixture {
  return {
    company_id: COMPANY_ID,
    workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
    schema_version: RENTAL_BILLING_WORKFLOW_SCHEMA_VERSION,
    entity_type: 'rental_billing_run',
    entity_id: ENTITY_ID,
    state_version: stateVersion,
    event_type: 'APPROVE',
    event_payload: { type: 'APPROVE', approved_at: appliedAt, approved_by: 'u-1' },
    snapshot_after: {
      state: 'approved',
      state_version: stateVersion + 1,
      approved_at: appliedAt,
      approved_by: 'u-1',
      error: null,
      failed_at: null,
    },
    applied_at: appliedAt,
    sentry_trace: 'trace-1',
  }
}

function ref(stateVersion: number): string {
  return workflowEventRef({
    workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
    entity_id: ENTITY_ID,
    state_version: stateVersion,
  })
}

describe('buildCaptureSessionAnchors', () => {
  it('resolves a captured transition mark and replays the bracket clean', async () => {
    const client = new FakeClient()
    client.eventLog.push(approveRow(0, '2026-06-06T00:00:01.000Z'))
    client.marks.push({
      company_id: COMPANY_ID,
      capture_session_id: CAPTURE_SESSION_ID,
      event_type: 'workflow.transition',
      occurred_at: '2026-06-06T00:00:02.000Z',
      event_ref: ref(0),
    })
    const anchors = await buildCaptureSessionAnchors(
      client as unknown as LedgerExecutor,
      COMPANY_ID,
      CAPTURE_SESSION_ID,
    )
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({
      event_ref: ref(0),
      workflow_name: RENTAL_BILLING_WORKFLOW_NAME,
      entity_id: ENTITY_ID,
      state_version: 0,
      event_type: 'APPROVE',
      to_state: 'approved',
      replay_available: true,
      replay_ok: true,
      first_divergence: null,
    })
  })

  it('orders by recency and caps the persisted anchor count', async () => {
    const client = new FakeClient()
    // Two transitions on the same entity; later state_version is more recent.
    client.eventLog.push(approveRow(0, '2026-06-06T00:00:01.000Z'))
    client.eventLog.push({
      ...approveRow(1, '2026-06-06T00:00:05.000Z'),
      event_type: 'POST_REQUESTED',
      event_payload: { type: 'POST_REQUESTED' },
      snapshot_after: { state: 'posting', state_version: 2, error: null, failed_at: null },
    })
    client.marks.push(
      {
        company_id: COMPANY_ID,
        capture_session_id: CAPTURE_SESSION_ID,
        event_type: 'workflow.transition',
        occurred_at: '2026-06-06T00:00:02.000Z',
        event_ref: ref(0),
      },
      {
        company_id: COMPANY_ID,
        capture_session_id: CAPTURE_SESSION_ID,
        event_type: 'workflow.transition',
        occurred_at: '2026-06-06T00:00:06.000Z',
        event_ref: ref(1),
      },
    )
    const anchors = await buildCaptureSessionAnchors(
      client as unknown as LedgerExecutor,
      COMPANY_ID,
      CAPTURE_SESSION_ID,
      1,
    )
    expect(anchors).toHaveLength(1)
    // Most recent (state_version 1, applied later) wins under the cap.
    expect(anchors[0]?.state_version).toBe(1)
  })

  it('skips marks whose anchor does not resolve, never throwing', async () => {
    const client = new FakeClient()
    // A mark for a state_version with no matching event-log row → unresolved.
    client.marks.push(
      {
        company_id: COMPANY_ID,
        capture_session_id: CAPTURE_SESSION_ID,
        event_type: 'workflow.transition',
        occurred_at: '2026-06-06T00:00:02.000Z',
        event_ref: ref(7),
      },
      {
        company_id: COMPANY_ID,
        capture_session_id: CAPTURE_SESSION_ID,
        event_type: 'workflow.transition',
        occurred_at: '2026-06-06T00:00:03.000Z',
        event_ref: 'not-an-anchor',
      },
    )
    const anchors = await buildCaptureSessionAnchors(
      client as unknown as LedgerExecutor,
      COMPANY_ID,
      CAPTURE_SESSION_ID,
    )
    expect(anchors).toEqual([])
  })
})
