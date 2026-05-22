// Worker tests for the audit-escrow-tick runner. Verifies:
//   - First-ever tick anchors all newly-created audit_events.
//   - Returned `escrow_anchor_id` is back-filled on the source rows.
//   - The created entry's signature verifies in-process.
//   - The S3/OTS env-gates are off-by-default and the runner doesn't
//     crash when they're unset.
//   - A repeat tick within the interval is a no-op (cadence gate).

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import {
  canonicalizeAuditEscrowJSON,
  hashAuditEscrowSHA256,
  verifyAuditEscrowEd25519,
} from '@sitelayer/queue'
import { createAuditEscrowTickRunner } from './audit-escrow-tick.js'

const COMPANY_ID = '00000000-0000-4000-8000-000000000099'

interface FakeAuditEventRow {
  id: string
  created_at: Date
  action: string
  entity_type: string
  entity_id: string
  actor_user_id: string
  actor_role: string | null
  sentry_trace: string | null
  request_id: string | null
  escrow_anchor_id: number | null
}

interface StoredEntry {
  id: number
  entry_hash: string
  previous_entry_hash: string
  action: string
  company_id: string | null
  window_start: Date
  window_end: Date
  source_count: number
  payload_hash: string
  context_hash: string
  key_id: string
  signature_b64: string
  material_json: string
  payload_json: string
  s3_bucket: string
  s3_key: string
  s3_version_id: string
  s3_object_locked: boolean
  ots_proof_path: string
  ots_status: string
  created_at: Date
}

interface StoredKey {
  key_id: string
  host_id: string
  public_key_b64: string
  private_key_b64: string
  created_at: Date
  retired_at: Date | null
}

function buildResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as never
}

interface PoolFixture {
  pool: Pool
  auditEvents: FakeAuditEventRow[]
  entries: StoredEntry[]
  keys: StoredKey[]
}

function makeFakePool(): PoolFixture {
  const auditEvents: FakeAuditEventRow[] = []
  const entries: StoredEntry[] = []
  const keys: StoredKey[] = []
  let nextId = 1

  const exec = async (raw: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    const sql = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (sql.startsWith('begin') || sql.startsWith('commit') || sql.startsWith('rollback')) {
      return buildResult([])
    }
    if (sql.startsWith('select set_config')) return buildResult([])
    if (sql.startsWith('select pg_advisory_xact_lock')) return buildResult([])
    if (sql.includes('from audit_escrow_keys') && sql.includes('retired_at is null')) {
      const active = keys
        .filter((k) => k.retired_at === null)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      const row = active[0]
      if (!row) return buildResult([])
      return buildResult([
        {
          key_id: row.key_id,
          host_id: row.host_id,
          public_key_b64: row.public_key_b64,
          private_key_b64: row.private_key_b64,
          created_at: row.created_at,
        } as QueryResultRow,
      ])
    }
    if (sql.startsWith('insert into audit_escrow_keys')) {
      const [keyId, hostId, , publicKeyB64, privateKeyB64] = params as [
        string,
        string,
        string,
        string,
        string,
      ]
      const existing = keys.find((k) => k.key_id === keyId)
      if (existing) {
        existing.host_id = hostId
        return buildResult([
          {
            key_id: existing.key_id,
            host_id: existing.host_id,
            public_key_b64: existing.public_key_b64,
            private_key_b64: existing.private_key_b64,
            created_at: existing.created_at,
          } as QueryResultRow,
        ])
      }
      const created: StoredKey = {
        key_id: keyId,
        host_id: hostId,
        public_key_b64: publicKeyB64,
        private_key_b64: privateKeyB64,
        created_at: new Date(),
        retired_at: null,
      }
      keys.push(created)
      return buildResult([
        {
          key_id: created.key_id,
          host_id: created.host_id,
          public_key_b64: created.public_key_b64,
          private_key_b64: created.private_key_b64,
          created_at: created.created_at,
        } as QueryResultRow,
      ])
    }
    if (sql.includes('from audit_escrow_entries') && sql.includes('select window_end')) {
      const [action, companyId] = params as [string, string | null]
      const filtered = entries
        .filter((e) => e.action === action && e.company_id === (companyId ?? null))
        .sort((a, b) => b.id - a.id)
      const row = filtered[0]
      if (!row) return buildResult([])
      return buildResult([{ window_end: row.window_end } as QueryResultRow])
    }
    if (sql.includes('from audit_escrow_entries') && sql.includes('select entry_hash')) {
      const [action, companyId] = params as [string, string | null]
      const filtered = entries
        .filter((e) => e.action === action && e.company_id === (companyId ?? null))
        .sort((a, b) => b.id - a.id)
      const row = filtered[0]
      if (!row) return buildResult([])
      return buildResult([{ entry_hash: row.entry_hash } as QueryResultRow])
    }
    if (sql.startsWith('insert into audit_escrow_entries')) {
      const [
        entryHash,
        previousEntryHash,
        action,
        companyId,
        windowStart,
        windowEnd,
        sourceCount,
        payloadHash,
        contextHash,
        keyId,
        signatureB64,
        materialJson,
        payloadJson,
        createdAt,
      ] = params as [string, string, string, string | null, Date, Date, number, string, string, string, string, string, string, Date]
      const id = nextId++
      const row: StoredEntry = {
        id,
        entry_hash: entryHash,
        previous_entry_hash: previousEntryHash,
        action,
        company_id: companyId ?? null,
        window_start: windowStart,
        window_end: windowEnd,
        source_count: sourceCount,
        payload_hash: payloadHash,
        context_hash: contextHash,
        key_id: keyId,
        signature_b64: signatureB64,
        material_json: materialJson,
        payload_json: payloadJson,
        s3_bucket: '',
        s3_key: '',
        s3_version_id: '',
        s3_object_locked: false,
        ots_proof_path: '',
        ots_status: '',
        created_at: createdAt,
      }
      entries.push(row)
      return buildResult([row as unknown as QueryResultRow])
    }
    if (sql.startsWith('select id, created_at, action, entity_type, entity_id')) {
      // SELECT from audit_events
      const [companyId, windowStart, windowEnd, limit] = params as [string, Date, Date, number]
      const filtered = auditEvents
        .filter(
          (e) =>
            e.escrow_anchor_id === null &&
            e.created_at > windowStart &&
            e.created_at <= windowEnd,
        )
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .slice(0, limit)
      void companyId
      return buildResult(filtered as unknown as QueryResultRow[])
    }
    if (sql.startsWith('select id, occurred_at, event_type, work_item_id')) {
      // SELECT from context_handoff_events (no fixture rows in these tests)
      return buildResult([])
    }
    if (sql.startsWith('update audit_events') && sql.includes('escrow_anchor_id = $1')) {
      const [entryId, , ids] = params as [number, string, string[]]
      for (const target of ids) {
        const row = auditEvents.find((e) => e.id === target)
        if (row) row.escrow_anchor_id = entryId
      }
      return buildResult([])
    }
    if (sql.startsWith('update context_handoff_events')) {
      return buildResult([])
    }
    if (sql.startsWith('update audit_escrow_entries')) {
      return buildResult([])
    }
    throw new Error(`unexpected sql: ${sql}`)
  }

  const client: PoolClient = {
    query: ((sql: unknown, params?: unknown[]) => exec(String(sql), params ?? [])) as PoolClient['query'],
    release: () => undefined,
  } as unknown as PoolClient
  const pool: Pool = {
    query: ((sql: unknown, params?: unknown[]) => exec(String(sql), params ?? [])) as Pool['query'],
    connect: async () => client,
  } as unknown as Pool
  return { pool, auditEvents, entries, keys }
}

beforeEach(() => {
  delete process.env.AUDIT_ESCROW_TICK_INTERVAL_MS
  delete process.env.AUDIT_ESCROW_S3_BUCKET
  delete process.env.AUDIT_ESCROW_OTS_ENABLED
})

describe('createAuditEscrowTickRunner', () => {
  it('forceTick anchors recent audit_events and back-fills escrow_anchor_id', async () => {
    const fx = makeFakePool()
    // Seed two audit_events created in the last hour.
    const recent = new Date(Date.now() - 5 * 60 * 1000)
    fx.auditEvents.push(
      {
        id: '00000000-0000-4000-8000-000000000a01',
        created_at: recent,
        action: 'crew_schedule.updated',
        entity_type: 'crew_schedule',
        entity_id: '1',
        actor_user_id: 'user_1',
        actor_role: 'office',
        sentry_trace: null,
        request_id: 'req-1',
        escrow_anchor_id: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000a02',
        created_at: new Date(recent.getTime() + 1000),
        action: 'estimate_push.posted',
        entity_type: 'estimate_push',
        entity_id: '2',
        actor_user_id: 'user_2',
        actor_role: 'admin',
        sentry_trace: 'trace-xyz',
        request_id: 'req-2',
        escrow_anchor_id: null,
      },
    )

    const runner = createAuditEscrowTickRunner({ pool: fx.pool, logger: makeLogger() })
    const summary = await runner.forceTick(COMPANY_ID)

    expect(summary.ran).toBe(true)
    expect(summary.failed).toBe(0)
    expect(summary.audit_event_entries_created).toBe(1)
    expect(summary.audit_events_anchored).toBe(2)
    expect(fx.entries.length).toBe(1)

    const entry = fx.entries[0]!
    expect(entry.action).toBe('audit_event_batch')
    expect(entry.company_id).toBe(COMPANY_ID)
    expect(entry.source_count).toBe(2)

    // Source rows now reference the new escrow entry.
    expect(fx.auditEvents[0]!.escrow_anchor_id).toBe(entry.id)
    expect(fx.auditEvents[1]!.escrow_anchor_id).toBe(entry.id)
  })

  it('produced entry verifies against the stored key', async () => {
    const fx = makeFakePool()
    fx.auditEvents.push({
      id: '00000000-0000-4000-8000-000000000b01',
      created_at: new Date(Date.now() - 60_000),
      action: 'crew_schedule.updated',
      entity_type: 'crew_schedule',
      entity_id: '1',
      actor_user_id: 'user_1',
      actor_role: 'office',
      sentry_trace: null,
      request_id: null,
      escrow_anchor_id: null,
    })

    const runner = createAuditEscrowTickRunner({ pool: fx.pool, logger: makeLogger() })
    await runner.forceTick(COMPANY_ID)

    const entry = fx.entries[0]!
    const key = fx.keys[0]!
    // The stored material_json is the canonical bytes — recompute the
    // hash and verify with the stored public key.
    const recomputedHash = hashAuditEscrowSHA256(entry.material_json)
    expect(recomputedHash).toBe(entry.entry_hash)
    const ok = verifyAuditEscrowEd25519(key.public_key_b64, entry.material_json, entry.signature_b64)
    expect(ok).toBe(true)

    // And the payload bytes round-trip through canonicalization.
    const parsed = JSON.parse(entry.payload_json)
    const recomputedPayloadHash = hashAuditEscrowSHA256(canonicalizeAuditEscrowJSON(parsed))
    expect(recomputedPayloadHash).toBe(entry.payload_hash)
  })

  it('skips the tick within the cadence interval', async () => {
    const fx = makeFakePool()
    const runner = createAuditEscrowTickRunner({ pool: fx.pool, logger: makeLogger() })
    // First call has no events; runs and resets lastRunAt.
    const a = await runner.maybeTick(COMPANY_ID)
    expect(a.ran).toBe(true)
    // Subsequent call within the default 1h cadence is a no-op.
    const b = await runner.maybeTick(COMPANY_ID)
    expect(b.ran).toBe(false)
  })

  it('does not crash when S3 + OTS env vars are unset', async () => {
    const fx = makeFakePool()
    fx.auditEvents.push({
      id: '00000000-0000-4000-8000-000000000c01',
      created_at: new Date(Date.now() - 60_000),
      action: 'crew_schedule.updated',
      entity_type: 'crew_schedule',
      entity_id: '1',
      actor_user_id: 'user_1',
      actor_role: null,
      sentry_trace: null,
      request_id: null,
      escrow_anchor_id: null,
    })
    const runner = createAuditEscrowTickRunner({ pool: fx.pool, logger: makeLogger() })
    const summary = await runner.forceTick(COMPANY_ID)
    expect(summary.failed).toBe(0)
    // s3_bucket stays empty because AUDIT_ESCROW_S3_BUCKET is unset.
    expect(fx.entries[0]!.s3_bucket).toBe('')
  })
})

// Reference the import to placate noUnusedLocals when running in
// non-test builds (createHash is used implicitly by the production path
// but referenced here for clarity).
void createHash
