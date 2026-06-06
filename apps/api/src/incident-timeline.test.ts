import { describe, expect, it } from 'vitest'
import { buildIncidentTimeline } from './incident-timeline.js'
import type { LedgerExecutor } from './mutation-tx.js'

// ---------------------------------------------------------------------------
// buildIncidentTimeline — the in-process window correlation the capture-session
// finalize path weaves into server_context.timeline (and the incident CLI
// mirrors). Verifies: merging the five source tables into ONE chronological
// timeline, error flagging on the queue tables, the window-bounded reads,
// candidate request/trace ranking by error count, the cap, and the defensive
// skip-on-failure contract (a failing query must never throw the timeline).
// ---------------------------------------------------------------------------

const COMPANY_ID = '00000000-0000-4000-8000-000000000abc'
const SINCE = '2026-06-06T00:00:00.000Z'
const UNTIL = '2026-06-06T01:00:00.000Z'

type AuditFixture = {
  company_id: string
  created_at: string
  action: string
  entity_type: string
  entity_id: string
  actor_user_id: string
  request_id: string | null
  sentry_trace: string | null
}

type QueueFixture = {
  company_id: string
  created_at: string
  status: string
  entity_type: string
  entity_id: string
  kind: string
  error: string | null
  request_id: string | null
  sentry_trace: string | null
}

type CaptureFixture = {
  company_id: string
  started_at: string
  route_path: string | null
  mode: string
  status: string
  app_build_sha: string | null
}

type WorkItemFixture = {
  company_id: string
  created_at: string
  route: string | null
  title: string
  status: string
  lane: string
  severity: string
  entity_type: string | null
  entity_id: string | null
}

class FakeTimelineClient {
  audit: AuditFixture[] = []
  outbox: QueueFixture[] = []
  syncEvents: QueueFixture[] = []
  captures: CaptureFixture[] = []
  workItems: WorkItemFixture[] = []
  /** Table names whose query should throw (exercises the defensive skip). */
  failTables = new Set<string>()

  private inWindow(at: string): boolean {
    return at >= SINCE && at <= UNTIL
  }

  query = (async (sqlRaw: string, params: unknown[] = []) => {
    const sql = sqlRaw.trim()
    const [companyId, since, until] = params as [string, string, string]
    const within = (at: string) => companyId === COMPANY_ID && at >= since && at <= until

    if (/from audit_events/i.test(sql)) {
      if (this.failTables.has('audit_events')) throw new Error('audit boom')
      return { rows: this.audit.filter((r) => r.company_id === companyId && within(r.created_at)), rowCount: 0 }
    }
    if (/from mutation_outbox/i.test(sql)) {
      if (this.failTables.has('mutation_outbox')) throw new Error('outbox boom')
      return { rows: this.outbox.filter((r) => r.company_id === companyId && within(r.created_at)), rowCount: 0 }
    }
    if (/from sync_events/i.test(sql)) {
      if (this.failTables.has('sync_events')) throw new Error('sync boom')
      return { rows: this.syncEvents.filter((r) => r.company_id === companyId && within(r.created_at)), rowCount: 0 }
    }
    if (/from capture_sessions/i.test(sql)) {
      if (this.failTables.has('capture_sessions')) throw new Error('capture boom')
      return { rows: this.captures.filter((r) => r.company_id === companyId && within(r.started_at)), rowCount: 0 }
    }
    if (/from context_work_items/i.test(sql)) {
      if (this.failTables.has('context_work_items')) throw new Error('work item boom')
      return { rows: this.workItems.filter((r) => r.company_id === companyId && within(r.created_at)), rowCount: 0 }
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 80)}`)
  }) as LedgerExecutor['query']
}

function baseClient(): FakeTimelineClient {
  const client = new FakeTimelineClient()
  client.audit = [
    {
      company_id: COMPANY_ID,
      created_at: '2026-06-06T00:10:00.000Z',
      action: 'estimate.recompute',
      entity_type: 'project',
      entity_id: 'proj-1',
      actor_user_id: 'user-1',
      request_id: 'req-A',
      sentry_trace: 'trace1-span-1',
    },
  ]
  client.outbox = [
    {
      company_id: COMPANY_ID,
      created_at: '2026-06-06T00:20:00.000Z',
      status: 'failed',
      entity_type: 'rental_billing_run',
      entity_id: 'rbr-1',
      kind: 'post_qbo_invoice',
      error: 'QBO 401 unauthorized',
      request_id: 'req-B',
      sentry_trace: 'trace2-span-2',
    },
  ]
  client.syncEvents = [
    {
      company_id: COMPANY_ID,
      created_at: '2026-06-06T00:25:00.000Z',
      status: 'pending',
      entity_type: 'invoice',
      entity_id: 'inv-1',
      kind: 'outbound',
      error: null,
      request_id: 'req-B',
      sentry_trace: null,
    },
  ]
  client.captures = [
    {
      company_id: COMPANY_ID,
      started_at: '2026-06-06T00:05:00.000Z',
      route_path: '/projects/proj-1/estimate',
      mode: 'feedback',
      status: 'open',
      app_build_sha: 'abc123',
    },
  ]
  client.workItems = [
    {
      company_id: COMPANY_ID,
      created_at: '2026-06-06T00:30:00.000Z',
      route: '/projects/proj-1/estimate',
      title: 'Estimate push failed',
      status: 'new',
      lane: 'triage',
      severity: 'high',
      entity_type: 'project',
      entity_id: 'proj-1',
    },
  ]
  return client
}

describe('buildIncidentTimeline', () => {
  it('merges the five source tables into one chronological timeline', async () => {
    const client = baseClient()
    const timeline = await buildIncidentTimeline(client, { companyId: COMPANY_ID, since: SINCE, until: UNTIL })

    expect(timeline.window).toEqual({ since: SINCE, until: UNTIL })
    expect(timeline.truncated).toBe(false)
    // 1 capture (00:05) + 1 audit (00:10) + 1 outbox (00:20) + 1 sync (00:25) + 1 work item (00:30)
    expect(timeline.events.map((e) => e.source)).toEqual([
      'capture',
      'audit',
      'mutation_outbox',
      'sync_events',
      'work_item',
    ])
    // strictly ascending by timestamp
    const times = timeline.events.map((e) => e.at)
    expect([...times].sort()).toEqual(times)
  })

  it('flags error rows and exposes them in the errors slice', async () => {
    const client = baseClient()
    const timeline = await buildIncidentTimeline(client, { companyId: COMPANY_ID, since: SINCE, until: UNTIL })

    const outbox = timeline.events.find((e) => e.source === 'mutation_outbox')
    expect(outbox?.is_error).toBe(true)
    expect(outbox?.error).toBe('QBO 401 unauthorized')

    // a pending sync row with no error is NOT flagged
    const sync = timeline.events.find((e) => e.source === 'sync_events')
    expect(sync?.is_error).toBe(false)

    expect(timeline.errors).toHaveLength(1)
    expect(timeline.errors[0]?.source).toBe('mutation_outbox')
  })

  it('flags failed-status rows with no error text', async () => {
    const client = baseClient()
    client.outbox = [
      {
        company_id: COMPANY_ID,
        created_at: '2026-06-06T00:20:00.000Z',
        status: 'failed',
        entity_type: 'rental_billing_run',
        entity_id: 'rbr-2',
        kind: 'post_qbo_invoice',
        error: null,
        request_id: 'req-C',
        sentry_trace: null,
      },
    ]
    const timeline = await buildIncidentTimeline(client, { companyId: COMPANY_ID, since: SINCE, until: UNTIL })
    const outbox = timeline.events.find((e) => e.source === 'mutation_outbox')
    expect(outbox?.is_error).toBe(true)
    expect(outbox?.error).toBe('(status failed)')
  })

  it('excludes rows outside the window', async () => {
    const client = baseClient()
    client.audit.push({
      company_id: COMPANY_ID,
      created_at: '2026-06-06T05:00:00.000Z', // after UNTIL
      action: 'late.action',
      entity_type: 'project',
      entity_id: 'proj-late',
      actor_user_id: 'user-1',
      request_id: 'req-LATE',
      sentry_trace: null,
    })
    const timeline = await buildIncidentTimeline(client, { companyId: COMPANY_ID, since: SINCE, until: UNTIL })
    expect(timeline.events.some((e) => e.line.includes('late.action'))).toBe(false)
    expect(timeline.candidate_request_ids).not.toContain('req-LATE')
  })

  it('ranks candidate request_ids by error count and surfaces trace ids', async () => {
    const client = baseClient()
    const timeline = await buildIncidentTimeline(client, { companyId: COMPANY_ID, since: SINCE, until: UNTIL })
    // req-B carries the failed outbox row -> ranks ahead of the clean req-A
    expect(timeline.candidate_request_ids[0]).toBe('req-B')
    expect(timeline.candidate_request_ids).toContain('req-A')
    expect(timeline.candidate_trace_ids).toEqual(expect.arrayContaining(['trace1', 'trace2']))
  })

  it('prefers explicitly focused request ids over error-count ranking', async () => {
    const client = baseClient()
    const timeline = await buildIncidentTimeline(client, {
      companyId: COMPANY_ID,
      since: SINCE,
      until: UNTIL,
      requestIds: ['req-A'],
    })
    expect(timeline.candidate_request_ids[0]).toBe('req-A')
  })

  it('caps the merged event count at the limit', async () => {
    const client = baseClient()
    client.audit = Array.from({ length: 50 }, (_, i) => ({
      company_id: COMPANY_ID,
      created_at: `2026-06-06T00:${String(i % 60).padStart(2, '0')}:00.000Z`,
      action: `action-${i}`,
      entity_type: 'project',
      entity_id: `proj-${i}`,
      actor_user_id: 'user-1',
      request_id: `req-${i}`,
      sentry_trace: null,
    }))
    const timeline = await buildIncidentTimeline(client, {
      companyId: COMPANY_ID,
      since: SINCE,
      until: UNTIL,
      limit: 5,
    })
    expect(timeline.events).toHaveLength(5)
  })

  it('skips a failing source query and flags the timeline truncated, never throwing', async () => {
    const client = baseClient()
    client.failTables.add('mutation_outbox')
    const timeline = await buildIncidentTimeline(client, { companyId: COMPANY_ID, since: SINCE, until: UNTIL })
    expect(timeline.truncated).toBe(true)
    // the failed outbox read contributes no rows, but the rest still merge
    expect(timeline.events.some((e) => e.source === 'mutation_outbox')).toBe(false)
    expect(timeline.events.some((e) => e.source === 'audit')).toBe(true)
    expect(timeline.errors).toHaveLength(0)
  })
})
