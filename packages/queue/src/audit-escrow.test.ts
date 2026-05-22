// Unit tests for the audit-escrow primitive. Coverage:
//   - canonicalizeJSON (sort order, nested objects, arrays, special chars)
//   - hashSHA256 + hashCanonicalJSON byte-stability
//   - Ed25519 sign + verify roundtrip with known-good / known-bad
//     signatures
//   - appendEntry chain linkage against a fake pool
//   - verifyEntry catches tampered rows
//
// The fake pool implements just enough of the pg Pool/PoolClient surface
// (connect → query for begin/commit/rollback + select/insert) to exercise
// the runner's actual SQL paths. Mirrors the pattern used by
// circuit-breaker.test.ts and the worker runner tests.

import { describe, expect, it } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'
import {
  AUDIT_ESCROW_VERSION,
  appendEntry,
  canonicalizeJSON,
  getOrCreateActiveSigningKey,
  hashCanonicalJSON,
  hashSHA256,
  signEd25519,
  verifyEd25519,
  verifyEntry,
  type AuditEscrowEntry,
} from './audit-escrow.js'

// -----------------------------------------------------------------------------
// canonicalizeJSON
// -----------------------------------------------------------------------------

describe('canonicalizeJSON', () => {
  it('serializes primitives the same way JSON.stringify does', () => {
    expect(canonicalizeJSON(null)).toBe('null')
    expect(canonicalizeJSON('hi')).toBe('"hi"')
    expect(canonicalizeJSON(42)).toBe('42')
    expect(canonicalizeJSON(true)).toBe('true')
    expect(canonicalizeJSON(false)).toBe('false')
  })

  it('sorts object keys lexicographically and is order-invariant', () => {
    const a = canonicalizeJSON({ b: 1, a: 2, c: 3 })
    const b = canonicalizeJSON({ a: 2, c: 3, b: 1 })
    expect(a).toBe(b)
    expect(a).toBe('{"a":2,"b":1,"c":3}')
  })

  it('recursively sorts nested objects', () => {
    const a = canonicalizeJSON({ outer: { z: 1, a: 2 }, alpha: { y: 9, x: 8 } })
    expect(a).toBe('{"alpha":{"x":8,"y":9},"outer":{"a":2,"z":1}}')
  })

  it('preserves array order', () => {
    expect(canonicalizeJSON([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalizeJSON([{ b: 1, a: 2 }, { b: 3, a: 4 }])).toBe('[{"a":2,"b":1},{"a":4,"b":3}]')
  })

  it('handles unicode + escapes the same way JSON.stringify does', () => {
    expect(canonicalizeJSON('hello "world"')).toBe('"hello \\"world\\""')
    expect(canonicalizeJSON('emoji 🚀')).toBe('"emoji 🚀"')
    expect(canonicalizeJSON('\n\t')).toBe('"\\n\\t"')
  })

  it('drops undefined fields (matches JSON.stringify behaviour)', () => {
    expect(canonicalizeJSON({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}')
  })

  it('coerces Date instances to ISO strings', () => {
    const d = new Date('2026-05-22T12:00:00.000Z')
    expect(canonicalizeJSON({ at: d })).toBe('{"at":"2026-05-22T12:00:00.000Z"}')
  })

  it('throws on non-finite numbers (chain hash inputs must be finite)', () => {
    expect(() => canonicalizeJSON({ x: NaN })).toThrow(/non-finite/)
    expect(() => canonicalizeJSON({ x: Infinity })).toThrow(/non-finite/)
  })

  it('refuses functions and symbols', () => {
    expect(() => canonicalizeJSON({ fn: () => 1 })).toThrow(/unsupported/)
    expect(() => canonicalizeJSON({ s: Symbol('x') })).toThrow(/unsupported/)
  })
})

// -----------------------------------------------------------------------------
// hashSHA256 + hashCanonicalJSON
// -----------------------------------------------------------------------------

describe('hashSHA256', () => {
  it('matches the standard SHA-256 spec', () => {
    // Known vector: sha256("abc") = ba7816bf...
    expect(hashSHA256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('hashCanonicalJSON produces the same hash regardless of input key order', () => {
    const a = hashCanonicalJSON({ a: 1, b: 2 })
    const b = hashCanonicalJSON({ b: 2, a: 1 })
    expect(a).toBe(b)
  })
})

// -----------------------------------------------------------------------------
// signEd25519 / verifyEd25519 roundtrip
// -----------------------------------------------------------------------------

describe('signEd25519 / verifyEd25519', () => {
  function makeRawKeyPair(): { privateB64: string; publicB64: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const priv = privateKey.export({ format: 'jwk' }) as { d?: string }
    const pub = publicKey.export({ format: 'jwk' }) as { x?: string }
    const toB64 = (s: string) => {
      let normalized = s.replace(/-/g, '+').replace(/_/g, '/')
      while (normalized.length % 4 !== 0) normalized += '='
      return Buffer.from(normalized, 'base64').toString('base64')
    }
    return { privateB64: toB64(priv.d!), publicB64: toB64(pub.x!) }
  }

  it('a signed message verifies with the matching public key', () => {
    const { privateB64, publicB64 } = makeRawKeyPair()
    const message = '{"hello":"escrow"}'
    const signature = signEd25519(privateB64, message)
    expect(verifyEd25519(publicB64, message, signature)).toBe(true)
  })

  it('returns false for a tampered message', () => {
    const { privateB64, publicB64 } = makeRawKeyPair()
    const signature = signEd25519(privateB64, '{"a":1}')
    expect(verifyEd25519(publicB64, '{"a":2}', signature)).toBe(false)
  })

  it('returns false for a foreign public key', () => {
    const { privateB64 } = makeRawKeyPair()
    const { publicB64: otherPub } = makeRawKeyPair()
    const sig = signEd25519(privateB64, 'msg')
    expect(verifyEd25519(otherPub, 'msg', sig)).toBe(false)
  })

  it('rejects keys of the wrong length', () => {
    expect(() => signEd25519('aaaa', 'msg')).toThrow(/32 bytes/)
    expect(verifyEd25519('aaaa', 'msg', '')).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Fake pg Pool for appendEntry + verifyEntry tests
// -----------------------------------------------------------------------------

interface StoredKey {
  key_id: string
  host_id: string
  algorithm: string
  public_key_b64: string
  private_key_b64: string
  created_at: Date
  retired_at: Date | null
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

function buildResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] }
}

function makeFakePool(): {
  pool: Pool
  keys: StoredKey[]
  entries: StoredEntry[]
} {
  const keys: StoredKey[] = []
  const entries: StoredEntry[] = []
  let nextId = 1

  const exec = async (rawSql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    const sql = rawSql.trim().toLowerCase().replace(/\s+/g, ' ')
    if (sql.startsWith('begin') || sql.startsWith('commit') || sql.startsWith('rollback')) {
      return buildResult([])
    }
    if (sql.startsWith('select pg_advisory_xact_lock')) {
      return buildResult([])
    }
    if (sql.includes('from audit_escrow_keys') && sql.includes('retired_at is null')) {
      const active = keys.filter((k) => k.retired_at === null).sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
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
      const [keyId, hostId, algorithm, publicKeyB64, privateKeyB64] = params as [
        string,
        string,
        string,
        string,
        string,
      ]
      let existing = keys.find((k) => k.key_id === keyId)
      if (existing) {
        existing.host_id = hostId
      } else {
        existing = {
          key_id: keyId,
          host_id: hostId,
          algorithm,
          public_key_b64: publicKeyB64,
          private_key_b64: privateKeyB64,
          created_at: new Date(),
          retired_at: null,
        }
        keys.push(existing)
      }
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
    if (
      sql.includes('from audit_escrow_entries') &&
      sql.includes('order by id desc') &&
      sql.includes('action = $1') &&
      !sql.includes('insert')
    ) {
      const [action, companyId] = params as [string, string | null]
      const filtered = entries
        .filter((e) => e.action === action && e.company_id === (companyId ?? null))
        .sort((a, b) => b.id - a.id)
      const row = filtered[0]
      if (!row) return buildResult([])
      // window_end OR entry_hash depending on the caller's columns
      if (sql.includes('select window_end')) {
        return buildResult([{ window_end: row.window_end } as QueryResultRow])
      }
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
    throw new Error(`unexpected sql in fake pool: ${sql}`)
  }

  const client: PoolClient = {
    query: ((sqlOrConfig: unknown, params?: unknown[]) => exec(String(sqlOrConfig), params ?? [])) as PoolClient['query'],
    release: () => undefined,
  } as unknown as PoolClient

  const pool: Pool = {
    query: ((sqlOrConfig: unknown, params?: unknown[]) => exec(String(sqlOrConfig), params ?? [])) as Pool['query'],
    connect: async () => client,
  } as unknown as Pool

  return { pool, keys, entries }
}

// -----------------------------------------------------------------------------
// getOrCreateActiveSigningKey + appendEntry chain
// -----------------------------------------------------------------------------

describe('audit-escrow append chain', () => {
  it('getOrCreateActiveSigningKey generates a fresh keypair when none exists', async () => {
    const fx = makeFakePool()
    const key = await getOrCreateActiveSigningKey(fx.pool, 'test-host')
    expect(key.keyId).toMatch(/^sitelayer-audit-ed25519-/)
    // Stored private/public keys decode to 32 bytes each.
    expect(Buffer.from(key.privateKeyB64, 'base64').length).toBe(32)
    expect(Buffer.from(key.publicKeyB64, 'base64').length).toBe(32)
    expect(fx.keys.length).toBe(1)
  })

  it('subsequent calls return the same active key', async () => {
    const fx = makeFakePool()
    const a = await getOrCreateActiveSigningKey(fx.pool, 'h')
    const b = await getOrCreateActiveSigningKey(fx.pool, 'h')
    expect(a.keyId).toBe(b.keyId)
    expect(fx.keys.length).toBe(1)
  })

  it('appendEntry links the chain via previous_entry_hash', async () => {
    const fx = makeFakePool()
    const windowStart = new Date('2026-05-22T00:00:00.000Z')
    const windowEnd1 = new Date('2026-05-22T01:00:00.000Z')
    const e1 = await appendEntry(fx.pool, {
      action: 'audit_event_batch',
      companyId: '00000000-0000-4000-8000-000000000001',
      windowStart,
      windowEnd: windowEnd1,
      sourceCount: 3,
      payload: { hello: 'world' },
    })
    expect(e1.previousEntryHash).toBe('')
    expect(e1.entryHash).not.toBe('')
    expect(e1.material.version).toBe(AUDIT_ESCROW_VERSION)
    expect(e1.material.payload_hash).toBe(hashCanonicalJSON({ hello: 'world' }))

    const e2 = await appendEntry(fx.pool, {
      action: 'audit_event_batch',
      companyId: '00000000-0000-4000-8000-000000000001',
      windowStart: windowEnd1,
      windowEnd: new Date('2026-05-22T02:00:00.000Z'),
      sourceCount: 1,
      payload: { hello: 'again' },
    })
    expect(e2.previousEntryHash).toBe(e1.entryHash)
    expect(e2.material.previous_entry_hash).toBe(e1.entryHash)
  })

  it('different (company_id, action) chains do not cross-link', async () => {
    const fx = makeFakePool()
    const base = {
      windowStart: new Date('2026-05-22T00:00:00.000Z'),
      windowEnd: new Date('2026-05-22T01:00:00.000Z'),
      sourceCount: 0,
      payload: { kind: 'baseline' },
    }
    const entryA = await appendEntry(fx.pool, { ...base, action: 'audit_event_batch', companyId: 'company-a-uuid'.padEnd(36, '0').slice(0, 36) })
    const entryB = await appendEntry(fx.pool, { ...base, action: 'audit_event_batch', companyId: 'company-b-uuid'.padEnd(36, '0').slice(0, 36) })
    expect(entryA.previousEntryHash).toBe('')
    expect(entryB.previousEntryHash).toBe('')
  })
})

// -----------------------------------------------------------------------------
// verifyEntry
// -----------------------------------------------------------------------------

describe('verifyEntry', () => {
  it('returns ok=true for a freshly-appended entry', async () => {
    const fx = makeFakePool()
    const entry = await appendEntry(fx.pool, {
      action: 'audit_event_batch',
      companyId: '00000000-0000-4000-8000-000000000001',
      windowStart: new Date('2026-05-22T00:00:00.000Z'),
      windowEnd: new Date('2026-05-22T01:00:00.000Z'),
      sourceCount: 1,
      payload: { evt: 'x' },
    })
    const report = verifyEntry(entry)
    expect(report.ok).toBe(true)
    expect(report.errors).toEqual([])
    expect(report.signatureValid).toBe(true)
  })

  it('detects a tampered entry_hash', async () => {
    const fx = makeFakePool()
    const entry = await appendEntry(fx.pool, {
      action: 'audit_event_batch',
      companyId: '00000000-0000-4000-8000-000000000001',
      windowStart: new Date('2026-05-22T00:00:00.000Z'),
      windowEnd: new Date('2026-05-22T01:00:00.000Z'),
      sourceCount: 1,
      payload: { evt: 'x' },
    })
    const tampered: AuditEscrowEntry = { ...entry, entryHash: 'a'.repeat(64) }
    const report = verifyEntry(tampered)
    expect(report.ok).toBe(false)
    expect(report.errors.some((e) => e.includes('entry_hash mismatch'))).toBe(true)
  })

  it('detects a payload that no longer matches the material', async () => {
    const fx = makeFakePool()
    const entry = await appendEntry(fx.pool, {
      action: 'audit_event_batch',
      companyId: '00000000-0000-4000-8000-000000000001',
      windowStart: new Date('2026-05-22T00:00:00.000Z'),
      windowEnd: new Date('2026-05-22T01:00:00.000Z'),
      sourceCount: 1,
      payload: { evt: 'x' },
    })
    const tampered: AuditEscrowEntry = { ...entry, payload: { evt: 'y' } }
    const report = verifyEntry(tampered)
    expect(report.ok).toBe(false)
    expect(report.errors.some((e) => e.includes('payload_hash mismatch'))).toBe(true)
  })

  it('detects a signature tampered post-insert', async () => {
    const fx = makeFakePool()
    const entry = await appendEntry(fx.pool, {
      action: 'audit_event_batch',
      companyId: '00000000-0000-4000-8000-000000000001',
      windowStart: new Date('2026-05-22T00:00:00.000Z'),
      windowEnd: new Date('2026-05-22T01:00:00.000Z'),
      sourceCount: 1,
      payload: { evt: 'x' },
    })
    // Flip a byte in the signature.
    const sigBytes = Buffer.from(entry.signatureB64, 'base64')
    sigBytes[0] = sigBytes[0]! ^ 0x01
    const tampered: AuditEscrowEntry = { ...entry, signatureB64: sigBytes.toString('base64') }
    const report = verifyEntry(tampered)
    expect(report.signatureValid).toBe(false)
    expect(report.ok).toBe(false)
  })
})

// -----------------------------------------------------------------------------
// Sanity: canonicalization is deterministic across runs (the hash contract
// depends on this).
// -----------------------------------------------------------------------------

describe('canonicalization stability', () => {
  it('produces identical bytes for repeated calls with deeply-nested input', () => {
    const input = {
      x: { z: [1, 2, { a: 'A', b: 'B' }], y: 'y' },
      a: ['a', null, true],
    }
    const a = canonicalizeJSON(input)
    const b = canonicalizeJSON(input)
    expect(a).toBe(b)
    const digestA = createHash('sha256').update(a, 'utf8').digest('hex')
    const digestB = createHash('sha256').update(b, 'utf8').digest('hex')
    expect(digestA).toBe(digestB)
  })
})
