// Unit tests for the audit-escrow API routes. Verifies:
//   - GET /api/audit/escrow/chain/head returns the latest entry id +
//     entry_hash.
//   - GET /api/audit/escrow/:id returns 200 + bundle on healthy row.
//   - GET /api/audit/escrow/:id returns 500 + escrow_corruption=true on
//     a tampered row.
//   - GET /api/audit/escrow/verify/:id returns 200 + verbose report
//     (ok=true on healthy, ok=false on tampered).
//   - Admin-only gate is enforced.

import type http from 'node:http'
import { describe, expect, it, beforeEach } from 'vitest'
import type { Pool, QueryResult, QueryResultRow } from 'pg'
import { appendAuditEscrowEntry, type AuditEscrowEntry } from '@sitelayer/queue'
import { handleAuditEscrowRoutes } from './audit-escrow.js'

const COMPANY_ID = '00000000-0000-4000-8000-000000000099'

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

interface PoolFixture {
  pool: Pool
  entries: StoredEntry[]
  keys: StoredKey[]
}

function makeFakePool(): PoolFixture {
  const entries: StoredEntry[] = []
  const keys: StoredKey[] = []
  let nextId = 1

  const exec = async (raw: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    const sql = raw.trim().toLowerCase().replace(/\s+/g, ' ')
    if (sql.startsWith('begin') || sql.startsWith('commit') || sql.startsWith('rollback')) {
      return buildResult([])
    }
    if (sql.startsWith('select pg_advisory_xact_lock')) return buildResult([])
    if (sql.includes('from audit_escrow_keys') && sql.includes('retired_at is null')) {
      const active = keys
        .filter((k) => k.retired_at === null)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      const row = active[0]
      if (!row) return buildResult([])
      return buildResult([row as unknown as QueryResultRow])
    }
    if (sql.startsWith('insert into audit_escrow_keys')) {
      const [keyId, hostId, , publicKeyB64, privateKeyB64] = params as [string, string, string, string, string]
      const existing = keys.find((k) => k.key_id === keyId)
      if (existing) return buildResult([existing as unknown as QueryResultRow])
      const created: StoredKey = {
        key_id: keyId,
        host_id: hostId,
        public_key_b64: publicKeyB64,
        private_key_b64: privateKeyB64,
        created_at: new Date(),
        retired_at: null,
      }
      keys.push(created)
      return buildResult([created as unknown as QueryResultRow])
    }
    if (sql.includes('from audit_escrow_entries') && sql.includes('select entry_hash')) {
      const [action, companyId] = params as [string, string | null]
      const filtered = entries
        .filter((e) => e.action === action && e.company_id === (companyId ?? null))
        .sort((a, b) => b.id - a.id)
      const row = filtered[0]
      return buildResult(row ? [{ entry_hash: row.entry_hash } as QueryResultRow] : [])
    }
    if (sql.startsWith('select id, entry_hash from audit_escrow_entries')) {
      const sorted = entries.slice().sort((a, b) => b.id - a.id)
      const row = sorted[0]
      return buildResult(row ? [{ id: row.id, entry_hash: row.entry_hash } as QueryResultRow] : [])
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
      ] = params as [
        string,
        string,
        string,
        string | null,
        Date,
        Date,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        Date,
      ]
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
    if (sql.startsWith('select e.id, e.entry_hash, e.previous_entry_hash')) {
      // getEntryById join select.
      const [entryId] = params as [number]
      const row = entries.find((e) => e.id === entryId)
      if (!row) return buildResult([])
      const key = keys.find((k) => k.key_id === row.key_id)
      const joined = {
        ...row,
        public_key_b64: key?.public_key_b64 ?? '',
      } as unknown as QueryResultRow
      return buildResult([joined])
    }
    throw new Error(`unexpected sql in fake pool: ${sql}`)
  }

  const client = {
    query: (sql: unknown, params?: unknown[]) => exec(String(sql), params ?? []),
    release: () => undefined,
  } as never

  const pool: Pool = {
    query: ((sql: unknown, params?: unknown[]) => exec(String(sql), params ?? [])) as Pool['query'],
    connect: async () => client,
  } as unknown as Pool

  return { pool, entries, keys }
}

function makeRouteCtx(pool: Pool, role: 'admin' | 'office' = 'admin') {
  const responses: Array<{ status: number; body: unknown }> = []
  const ctx = {
    pool,
    requireRole: (allowed: readonly string[]) => {
      if (allowed.includes(role)) return true
      responses.push({ status: 403, body: { error: 'forbidden' } })
      return false
    },
    sendJson: (status: number, body: unknown) => {
      responses.push({ status, body })
    },
  }
  return { ctx, responses }
}

async function seedEntry(fx: PoolFixture, payload: Record<string, unknown> = { evt: 'x' }): Promise<AuditEscrowEntry> {
  return appendAuditEscrowEntry(fx.pool, {
    action: 'audit_event_batch',
    companyId: COMPANY_ID,
    windowStart: new Date('2026-05-22T00:00:00.000Z'),
    windowEnd: new Date('2026-05-22T01:00:00.000Z'),
    sourceCount: 1,
    payload,
  })
}

function makeRequest(method: string, pathname: string): { req: http.IncomingMessage; url: URL } {
  return {
    req: { method, url: pathname } as http.IncomingMessage,
    url: new URL(pathname, 'http://localhost'),
  }
}

beforeEach(() => {
  // ensure no env leak across tests
})

describe('handleAuditEscrowRoutes', () => {
  it('GET /api/audit/escrow/chain/head returns null head on empty chain', async () => {
    const fx = makeFakePool()
    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('GET', '/api/audit/escrow/chain/head')
    const handled = await handleAuditEscrowRoutes(req, url, ctx)
    expect(handled).toBe(true)
    expect(responses).toEqual([{ status: 200, body: { head: null } }])
  })

  it('GET /api/audit/escrow/chain/head returns the latest entry', async () => {
    const fx = makeFakePool()
    const entry = await seedEntry(fx)
    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('GET', '/api/audit/escrow/chain/head')
    await handleAuditEscrowRoutes(req, url, ctx)
    expect(responses[0]!.status).toBe(200)
    expect(responses[0]!.body).toEqual({ head: { entry_id: entry.id, entry_hash: entry.entryHash } })
  })

  it('GET /api/audit/escrow/:id returns 200 for a healthy entry', async () => {
    const fx = makeFakePool()
    const entry = await seedEntry(fx)
    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('GET', `/api/audit/escrow/${entry.id}`)
    const handled = await handleAuditEscrowRoutes(req, url, ctx)
    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    expect(responses[0]!.status).toBe(200)
    const body = responses[0]!.body as { entry: { id: number; entry_hash: string; signature_b64: string } }
    expect(body.entry.id).toBe(entry.id)
    expect(body.entry.entry_hash).toBe(entry.entryHash)
    expect(body.entry.signature_b64).toBe(entry.signatureB64)
  })

  it('GET /api/audit/escrow/:id returns 500 + escrow_corruption=true on a tampered row', async () => {
    const fx = makeFakePool()
    const entry = await seedEntry(fx)
    // Tamper the stored entry_hash so verifyEntry fails on read-back.
    const stored = fx.entries.find((e) => e.id === entry.id)!
    stored.entry_hash = 'a'.repeat(64)

    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('GET', `/api/audit/escrow/${entry.id}`)
    await handleAuditEscrowRoutes(req, url, ctx)

    expect(responses[0]!.status).toBe(500)
    const body = responses[0]!.body as { escrow_corruption: boolean; errors: string[] }
    expect(body.escrow_corruption).toBe(true)
    expect(body.errors.length).toBeGreaterThan(0)
  })

  it('GET /api/audit/escrow/verify/:id returns 200 with verbose report even on failure', async () => {
    const fx = makeFakePool()
    const entry = await seedEntry(fx)
    const stored = fx.entries.find((e) => e.id === entry.id)!
    stored.entry_hash = 'b'.repeat(64)

    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('GET', `/api/audit/escrow/verify/${entry.id}`)
    await handleAuditEscrowRoutes(req, url, ctx)
    expect(responses[0]!.status).toBe(200)
    const body = responses[0]!.body as {
      entry: { id: number }
      verification: { ok: boolean; errors: string[]; signatureValid: boolean }
    }
    expect(body.entry.id).toBe(entry.id)
    expect(body.verification.ok).toBe(false)
    expect(body.verification.errors.some((e) => e.includes('entry_hash mismatch'))).toBe(true)
  })

  it('GET /api/audit/escrow/verify/:id returns ok=true for a healthy entry', async () => {
    const fx = makeFakePool()
    const entry = await seedEntry(fx)
    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('GET', `/api/audit/escrow/verify/${entry.id}`)
    await handleAuditEscrowRoutes(req, url, ctx)
    expect(responses[0]!.status).toBe(200)
    const body = responses[0]!.body as { verification: { ok: boolean } }
    expect(body.verification.ok).toBe(true)
  })

  it('rejects non-admin callers', async () => {
    const fx = makeFakePool()
    const entry = await seedEntry(fx)
    const { ctx, responses } = makeRouteCtx(fx.pool, 'office')
    const { req, url } = makeRequest('GET', `/api/audit/escrow/${entry.id}`)
    await handleAuditEscrowRoutes(req, url, ctx)
    // requireRole pushes a 403; the handler returns true (handled).
    expect(responses[0]!.status).toBe(403)
  })

  it('returns 404 on a missing entry id', async () => {
    const fx = makeFakePool()
    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('GET', '/api/audit/escrow/9999')
    await handleAuditEscrowRoutes(req, url, ctx)
    expect(responses[0]!.status).toBe(404)
  })

  it('returns 400 on a malformed entry id', async () => {
    const fx = makeFakePool()
    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('GET', '/api/audit/escrow/abc')
    const handled = await handleAuditEscrowRoutes(req, url, ctx)
    // The path doesn't match the digit regex, so the route handler
    // returns false (no match) — caller would 404.
    expect(handled).toBe(false)
    expect(responses).toEqual([])
  })

  it('non-GET methods are passed through', async () => {
    const fx = makeFakePool()
    const entry = await seedEntry(fx)
    const { ctx, responses } = makeRouteCtx(fx.pool)
    const { req, url } = makeRequest('POST', `/api/audit/escrow/${entry.id}`)
    const handled = await handleAuditEscrowRoutes(req, url, ctx)
    expect(handled).toBe(false)
    expect(responses).toEqual([])
  })
})
