import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import { createLogger } from '@sitelayer/logger'
import { createNotificationRunner } from './notification.js'

// Unit tests for the workflow-driven notification runner.
//
// The runner opens a pg tx, calls drainNotifications (notifications.ts) with
// a dispatcher built from env, then commits. We focus on the runner's three
// observable behaviours:
//
//   - Empty pass:  no claimed rows → returns zero summary, releases client.
//   - Happy path:  a row with recipient_email pre-set sends through the
//                  email channel and walks SEND_REQUESTED → SEND_SUCCEEDED.
//   - Defer path:  a row needing Clerk hydration with no resolver wired
//                  (NOTIFICATIONS_ENABLED=0) defers without burning attempts.
//
// We force NOTIFICATIONS_ENABLED=0 in beforeEach so the runner skips Clerk
// client setup (which would otherwise process.exit(1) on missing key).
// Twilio + VAPID configs return null when env is unset, so the dispatcher
// only has the email + console channels.

const testLogger = createLogger('notification-runner-test', { level: 'silent' })

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
    query: vi.fn(async () => buildResponse({})) as unknown as Pool['query'],
  }
  return { pool: pool as Pool, calls, released }
}

describe('createNotificationRunner', () => {
  // Preserve the surrounding env so tests don't leak.
  const original: Record<string, string | undefined> = {}
  const KEYS = [
    'NOTIFICATIONS_ENABLED',
    'CLERK_SECRET_KEY',
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_FROM_NUMBER',
    'VAPID_PUBLIC_KEY',
    'VAPID_PRIVATE_KEY',
    'VAPID_SUBJECT',
    'EMAIL_PROVIDER',
  ]

  beforeEach(() => {
    for (const k of KEYS) original[k] = process.env[k]
    // NOTIFICATIONS_ENABLED=0 → skip Clerk client setup (avoids process.exit).
    process.env.NOTIFICATIONS_ENABLED = '0'
    // Strip Twilio + VAPID so their configs come back null.
    delete process.env.TWILIO_ACCOUNT_SID
    delete process.env.TWILIO_AUTH_TOKEN
    delete process.env.TWILIO_FROM_NUMBER
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
    delete process.env.VAPID_SUBJECT
    // Force console email provider (no SMTP/SES env required).
    process.env.EMAIL_PROVIDER = 'console'
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (original[k] === undefined) delete process.env[k]
      else process.env[k] = original[k]
    }
  })

  describe('empty pass', () => {
    it('returns zero counters when the claim query returns no rows', async () => {
      const responder: Responder = (sql) => {
        if (sql.trim().startsWith('select id, company_id, recipient_clerk_user_id')) {
          return { rows: [], rowCount: 0 }
        }
        return { rows: [] }
      }
      const { pool, calls, released } = makePool(responder)
      const runner = createNotificationRunner({ pool, logger: testLogger })
      const result = await runner.drain()
      expect(result).toEqual({
        processed: 0,
        sent: 0,
        failed: 0,
        shortCircuited: false,
        deferred: 0,
        hydrated: 0,
      })
      // tx wraps the drain.
      expect(calls.find((c) => c.sql === 'begin')).toBeDefined()
      expect(calls.find((c) => c.sql === 'commit')).toBeDefined()
      expect(released[0]).toBe(true)
    })
  })

  describe('happy path', () => {
    it('sends a pre-hydrated row via the console-routed email channel and walks SEND_REQUESTED → SEND_SUCCEEDED', async () => {
      const row = {
        id: 'r-1',
        company_id: 'co-1',
        recipient_clerk_user_id: null,
        recipient_email: 'alice@example.com',
        kind: 'rental_billing.posted',
        subject: 'Invoice posted',
        body_text: 'plain body',
        body_html: null,
        payload: null,
        attempt_count: 0,
        delivery_attempts: 0,
        state_version: 1,
      }
      const responder: Responder = (sql) => {
        if (sql.trim().startsWith('select id, company_id, recipient_clerk_user_id')) {
          return { rows: [row], rowCount: 1 }
        }
        // dispatcher loadPreferences — no row → defaults.
        if (sql.includes('from notification_preferences')) return { rows: [], rowCount: 0 }
        // dispatcher countPushSubscriptions — recipient_clerk_user_id is null
        // so this shouldn't be called, but be safe.
        if (sql.includes('from push_subscriptions')) return { rows: [{ n: '0' }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const runner = createNotificationRunner({ pool, logger: testLogger })
      const result = await runner.drain()
      expect(result.processed).toBe(1)
      expect(result.sent).toBe(1)
      expect(result.failed).toBe(0)
      expect(result.deferred).toBe(0)

      // SEND_REQUESTED → SEND_SUCCEEDED both projected into legacy status.
      const updates = calls.filter((c) => c.sql.includes('update notifications'))
      // Two transitions (sending → sent).
      expect(updates.length).toBeGreaterThanOrEqual(2)
      const states = updates.map((u) => u.params[1])
      expect(states).toContain('sending')
      expect(states).toContain('sent')
      // workflow_event_log rows for both transitions.
      const events = calls.filter((c) => c.sql.includes('insert into workflow_event_log'))
      const eventTypes = events.map((e) => e.params[5])
      expect(eventTypes).toContain('SEND_REQUESTED')
      expect(eventTypes).toContain('SEND_SUCCEEDED')
    })
  })

  describe('defer path', () => {
    it('defers a row needing Clerk hydration when NOTIFICATIONS_ENABLED=0 (no resolver wired)', async () => {
      const row = {
        id: 'r-defer',
        company_id: 'co-1',
        recipient_clerk_user_id: 'user_pending_hydrate',
        recipient_email: null,
        kind: 'rental_billing.posted',
        subject: 'Hi',
        body_text: 'pls hydrate',
        body_html: null,
        payload: null,
        attempt_count: 0,
        delivery_attempts: 0,
        state_version: 1,
      }
      const responder: Responder = (sql) => {
        if (sql.trim().startsWith('select id, company_id, recipient_clerk_user_id')) {
          return { rows: [row], rowCount: 1 }
        }
        if (sql.includes('from notification_preferences')) return { rows: [], rowCount: 0 }
        if (sql.includes('from push_subscriptions')) return { rows: [{ n: '0' }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls } = makePool(responder)
      const runner = createNotificationRunner({ pool, logger: testLogger })
      const result = await runner.drain()
      expect(result.processed).toBe(1)
      expect(result.deferred).toBe(1)
      expect(result.sent).toBe(0)
      expect(result.failed).toBe(0)
      // Defer path → no workflow_event_log row (procedural deferral by design).
      // status stays 'pending' on the notifications row.
      const updates = calls.filter((c) => c.sql.includes('update notifications'))
      expect(updates.length).toBeGreaterThanOrEqual(1)
      expect(updates.some((u) => String(u.sql).includes("status = 'pending'"))).toBe(true)
    })
  })

  describe('error path', () => {
    it('rolls back the tx and rethrows when the claim query fails', async () => {
      const responder: Responder = (sql) => {
        if (sql.trim().startsWith('select id, company_id, recipient_clerk_user_id')) {
          return new Error('connection terminated')
        }
        return { rows: [], rowCount: 1 }
      }
      const { pool, calls, released } = makePool(responder)
      const runner = createNotificationRunner({ pool, logger: testLogger })
      await expect(runner.drain()).rejects.toThrow(/connection terminated/)
      expect(calls.find((c) => c.sql === 'rollback')).toBeDefined()
      expect(released[0]).toBe(true)
    })
  })
})
