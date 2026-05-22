// Audit Escrow MVP — sitelayer-local signed, chained, append-only evidence
// anchor. Mirrors mesh/core/audit_escrow.go API surface; deliberately
// does NOT depend on mesh at runtime (ADR 0024 default-decoupled).
//
// Storage model:
//   - audit_escrow_keys: long-lived Ed25519 keypair, db-stored for v1.
//     Operator rotates by inserting a fresh key + setting retired_at on
//     the old row (see RUNBOOK_AUDIT_ESCROW.md). TODO: move private key
//     out of DB once a KMS path is selected (DO Spaces KMS, Bitwarden CLI,
//     etc.). Tracked at PROVING_GROUND_PLAN.md wedge 2 follow-ups.
//   - audit_escrow_entries: append-only signed bundle. Each entry's
//     entry_hash = SHA-256(material_json_canonical). previous_entry_hash
//     chains the entries per (company_id, action). signature_b64 =
//     Ed25519-sign(material_json_canonical).
//
// Canonicalization (RFC 8785-style, inlined — no external dep):
//   - Sort object keys lexicographically at every depth.
//   - Preserve array order.
//   - Primitive serialization matches JSON.stringify defaults.
//   This is the hash contract. DO NOT switch to JSON.stringify directly
//   or to a library without confirming byte-for-byte parity with the
//   inlined sorter — the chain must verify across mesh, sitelayer, and
//   any third-party auditor that re-implements canonicalization.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

export const AUDIT_ESCROW_ALGORITHM = 'Ed25519'
export const AUDIT_ESCROW_VERSION = 1

export type AuditEscrowExecutor = Pick<Pool | PoolClient, 'query'>

export interface AuditEscrowKey {
  keyId: string
  hostId: string
  publicKeyB64: string
  privateKeyB64: string
  createdAt: Date
}

export interface AuditEscrowMaterial {
  version: number
  created_at: string
  action: string
  company_id: string | null
  window_start: string
  window_end: string
  source_count: number
  previous_entry_hash: string
  payload_hash: string
  context_hash: string
  key_id: string
  payload: Record<string, unknown>
}

export interface AuditEscrowEntry {
  id: number
  entryHash: string
  previousEntryHash: string
  action: string
  companyId: string | null
  windowStart: Date
  windowEnd: Date
  sourceCount: number
  payloadHash: string
  contextHash: string
  keyId: string
  publicKeyB64: string
  signatureB64: string
  material: AuditEscrowMaterial
  payload: Record<string, unknown>
  s3Bucket: string
  s3Key: string
  s3VersionId: string
  s3ObjectLocked: boolean
  otsProofPath: string
  otsStatus: string
  createdAt: Date
}

export interface AppendEntryParams {
  action: string
  companyId: string | null
  windowStart: Date
  windowEnd: Date
  sourceCount: number
  payload: Record<string, unknown>
}

// -----------------------------------------------------------------------------
// Canonicalization + hashing primitives
// -----------------------------------------------------------------------------

/**
 * RFC 8785-style canonical JSON: sort object keys lexicographically at
 * every depth; preserve array order; use default JSON primitive encoding.
 *
 * Implementation is intentionally inlined (rather than pulling
 * `canonicalize` or `json-stringify-deterministic`) so the hash contract
 * is owned and reviewable in one file. Any third party verifying a
 * sitelayer escrow bundle must implement an equivalent sorter; the
 * runbook (RUNBOOK_AUDIT_ESCROW.md) describes the rules.
 */
export function canonicalizeJSON(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('non-finite number in audit escrow payload')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'bigint') {
    // Encode bigints as strings so the canonicalization remains
    // round-trippable and reviewable. Callers should explicitly String()
    // before passing in to avoid the implicit conversion.
    return JSON.stringify(value.toString())
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalizeJSON(item))
    return '[' + items.join(',') + ']'
  }
  if (typeof value === 'object') {
    // Date is a common foot-gun — coerce to ISO string explicitly.
    if (value instanceof Date) return JSON.stringify(value.toISOString())
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
    const parts: string[] = []
    for (const key of keys) {
      parts.push(JSON.stringify(key) + ':' + canonicalizeJSON(obj[key]))
    }
    return '{' + parts.join(',') + '}'
  }
  // Functions, symbols — refuse rather than silently drop.
  throw new Error(`unsupported value type in audit escrow payload: ${typeof value}`)
}

/** SHA-256 of input text, hex-encoded. Used for entry_hash, payload_hash, context_hash. */
export function hashSHA256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Convenience: canonicalize then hash. */
export function hashCanonicalJSON(value: unknown): string {
  return hashSHA256(canonicalizeJSON(value))
}

// -----------------------------------------------------------------------------
// Ed25519 sign / verify
// -----------------------------------------------------------------------------

/**
 * Sign a message with the given base64-encoded raw (32-byte) Ed25519
 * private key. Returns the base64 signature.
 *
 * The DB stores keys in raw form (`crypto.generateKeyPairSync('ed25519')`
 * with `{ format: 'der', type: 'pkcs8' }` would be DER-encoded; we
 * instead extract the raw 32-byte seed + 32-byte public key so the
 * stored payload is portable across crypto libraries that follow the
 * RFC 8032 raw-key convention).
 */
export function signEd25519(privateKeyB64: string, message: string): string {
  const privateKey = importPrivateKey(privateKeyB64)
  const signature = cryptoSign(null, Buffer.from(message, 'utf8'), privateKey)
  return signature.toString('base64')
}

/** Verify a base64 signature against a message and base64 raw public key. */
export function verifyEd25519(publicKeyB64: string, message: string, signatureB64: string): boolean {
  try {
    const publicKey = importPublicKey(publicKeyB64)
    const signature = Buffer.from(signatureB64, 'base64')
    return cryptoVerify(null, Buffer.from(message, 'utf8'), publicKey, signature)
  } catch {
    return false
  }
}

// node:crypto Ed25519 requires KeyObjects, but we want to store the raw
// 32-byte seed (private) + 32-byte public key as base64. These helpers
// wrap the raw bytes in the minimal DER prefix required by KeyObject.

const ED25519_PRIVATE_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED25519_PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function importPrivateKey(privateKeyB64: string): KeyObject {
  const raw = Buffer.from(privateKeyB64, 'base64')
  if (raw.length !== 32) {
    throw new Error(`audit escrow private key must be 32 bytes (raw seed), got ${raw.length}`)
  }
  return createPrivateKey({
    key: Buffer.concat([ED25519_PRIVATE_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  })
}

function importPublicKey(publicKeyB64: string): KeyObject {
  const raw = Buffer.from(publicKeyB64, 'base64')
  if (raw.length !== 32) {
    throw new Error(`audit escrow public key must be 32 bytes (raw), got ${raw.length}`)
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_PUBLIC_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  })
}

// -----------------------------------------------------------------------------
// Key management
// -----------------------------------------------------------------------------

interface KeyRow {
  key_id: string
  host_id: string
  public_key_b64: string
  private_key_b64: string
  created_at: Date
}

function rowToKey(row: KeyRow): AuditEscrowKey {
  return {
    keyId: row.key_id,
    hostId: row.host_id,
    publicKeyB64: row.public_key_b64,
    privateKeyB64: row.private_key_b64,
    createdAt: row.created_at,
  }
}

/**
 * Return the currently-active signing key, generating one if none exists.
 *
 * Generation extracts the raw seed (private) and raw point (public)
 * from the node:crypto KeyObject so the stored payload is portable.
 * Subsequent ticks read the same row until an operator marks it retired.
 */
export async function getOrCreateActiveSigningKey(pool: Pool, hostId = ''): Promise<AuditEscrowKey> {
  const existing = await pool.query<KeyRow>(
    `select key_id, host_id, public_key_b64, private_key_b64, created_at
       from audit_escrow_keys
      where retired_at is null
      order by created_at desc
      limit 1`,
  )
  if (existing.rows.length > 0) {
    return rowToKey(existing.rows[0]!)
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  // Extract raw 32-byte seeds via JWK to avoid parsing DER ourselves.
  const privJwk = privateKey.export({ format: 'jwk' }) as { d?: string; x?: string }
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x?: string }
  if (!privJwk.d || !pubJwk.x) {
    throw new Error('failed to extract raw Ed25519 keypair (jwk missing d/x)')
  }
  const privateRaw = Buffer.from(base64urlToBase64(privJwk.d), 'base64')
  const publicRaw = Buffer.from(base64urlToBase64(pubJwk.x), 'base64')
  const publicKeyB64 = publicRaw.toString('base64')
  const privateKeyB64 = privateRaw.toString('base64')
  // Stable key_id derived from the public key so concurrent inserts
  // converge on the same row.
  const sum = createHash('sha256').update(publicRaw).digest('hex')
  const keyId = 'sitelayer-audit-ed25519-' + sum.slice(0, 16)

  const inserted = await pool.query<KeyRow>(
    `insert into audit_escrow_keys (key_id, host_id, algorithm, public_key_b64, private_key_b64)
     values ($1, $2, $3, $4, $5)
     on conflict (key_id) do update set host_id = excluded.host_id
     returning key_id, host_id, public_key_b64, private_key_b64, created_at`,
    [keyId, hostId, AUDIT_ESCROW_ALGORITHM, publicKeyB64, privateKeyB64],
  )
  return rowToKey(inserted.rows[0]!)
}

function base64urlToBase64(input: string): string {
  let out = input.replace(/-/g, '+').replace(/_/g, '/')
  while (out.length % 4 !== 0) out += '='
  return out
}

// -----------------------------------------------------------------------------
// Append + read entries
// -----------------------------------------------------------------------------

interface EntryRow {
  id: string | number
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
  public_key_b64: string
  signature_b64: string
  material_json: AuditEscrowMaterial | string
  payload_json: Record<string, unknown> | string
  s3_bucket: string
  s3_key: string
  s3_version_id: string
  s3_object_locked: boolean
  ots_proof_path: string
  ots_status: string
  created_at: Date
}

function rowToEntry(row: EntryRow): AuditEscrowEntry {
  const material =
    typeof row.material_json === 'string' ? (JSON.parse(row.material_json) as AuditEscrowMaterial) : row.material_json
  const payload =
    typeof row.payload_json === 'string'
      ? (JSON.parse(row.payload_json) as Record<string, unknown>)
      : row.payload_json
  return {
    id: typeof row.id === 'string' ? Number(row.id) : row.id,
    entryHash: row.entry_hash,
    previousEntryHash: row.previous_entry_hash,
    action: row.action,
    companyId: row.company_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    sourceCount: row.source_count,
    payloadHash: row.payload_hash,
    contextHash: row.context_hash,
    keyId: row.key_id,
    publicKeyB64: row.public_key_b64,
    signatureB64: row.signature_b64,
    material,
    payload,
    s3Bucket: row.s3_bucket,
    s3Key: row.s3_key,
    s3VersionId: row.s3_version_id,
    s3ObjectLocked: row.s3_object_locked,
    otsProofPath: row.ots_proof_path,
    otsStatus: row.ots_status,
    createdAt: row.created_at,
  }
}

/**
 * Find the previous entry's hash for the (company_id, action) chain.
 * Returns '' if this is the first entry for that chain.
 *
 * `companyId IS NULL` is also a valid chain (global entries) — postgres'
 * NULL semantics handle the comparison correctly via IS NOT DISTINCT FROM.
 */
async function findPreviousEntryHash(
  executor: AuditEscrowExecutor,
  action: string,
  companyId: string | null,
): Promise<string> {
  const result = await executor.query<{ entry_hash: string }>(
    `select entry_hash
       from audit_escrow_entries
      where action = $1
        and company_id IS NOT DISTINCT FROM $2::uuid
      order by id desc
      limit 1`,
    [action, companyId],
  )
  return result.rows[0]?.entry_hash ?? ''
}

/**
 * Append a new entry to the chain. Computes context_hash, payload_hash,
 * entry_hash (= hash of canonicalized material_json), signs entry_hash
 * material with the active signing key, inserts a row, and returns it.
 *
 * Caller is responsible for any post-insert backfill (e.g. setting
 * `audit_events.escrow_anchor_id` to the returned `id`).
 *
 * Idempotency: the runner is responsible for not double-anchoring the
 * same row range; this function does not de-dupe. A retry that produces
 * the same payload will produce a different entry_hash because of the
 * embedded created_at + window timestamps.
 */
export async function appendEntry(pool: Pool, params: AppendEntryParams): Promise<AuditEscrowEntry> {
  const action = params.action.trim()
  if (!action) throw new Error('audit escrow: action required')
  if (params.windowEnd < params.windowStart) {
    throw new Error('audit escrow: window_end < window_start')
  }
  const payload = params.payload ?? {}

  const key = await getOrCreateActiveSigningKey(pool, process.env.AUDIT_ESCROW_HOST_ID ?? '')

  const client = await pool.connect()
  try {
    await client.query('begin')
    // Per-chain advisory lock prevents two concurrent ticks from racing
    // on previous_entry_hash for the same (company, action) chain.
    // hashtext returns an int4 so we widen it through to bigint via
    // ::bigint to fit pg_advisory_xact_lock(bigint).
    const lockKey = `audit_escrow:${params.companyId ?? 'global'}:${action}`
    await client.query(`select pg_advisory_xact_lock(hashtext($1)::bigint)`, [lockKey])

    const previousHash = await findPreviousEntryHash(client, action, params.companyId)

    const windowStartIso = params.windowStart.toISOString()
    const windowEndIso = params.windowEnd.toISOString()
    const payloadHash = hashCanonicalJSON(payload)
    // context_hash binds the chain link + window + signing key so a
    // verifier can recompute it from just the material header without
    // needing the payload. Order matters; do NOT change without bumping
    // AUDIT_ESCROW_VERSION and adding a migration note.
    const contextHash = hashSHA256(
      [previousHash, windowStartIso, windowEndIso, key.keyId].join('\n'),
    )

    const createdAt = new Date()
    const material: AuditEscrowMaterial = {
      version: AUDIT_ESCROW_VERSION,
      created_at: createdAt.toISOString(),
      action,
      company_id: params.companyId,
      window_start: windowStartIso,
      window_end: windowEndIso,
      source_count: params.sourceCount,
      previous_entry_hash: previousHash,
      payload_hash: payloadHash,
      context_hash: contextHash,
      key_id: key.keyId,
      payload,
    }
    const materialCanonical = canonicalizeJSON(material)
    const entryHash = hashSHA256(materialCanonical)
    const signatureB64 = signEd25519(key.privateKeyB64, materialCanonical)
    const payloadCanonical = canonicalizeJSON(payload)

    const insertResult = await client.query<EntryRow>(
      `insert into audit_escrow_entries (
         entry_hash, previous_entry_hash, action, company_id,
         window_start, window_end, source_count,
         payload_hash, context_hash, key_id, signature_b64,
         material_json, payload_json, created_at
       )
       values (
         $1, $2, $3, $4::uuid,
         $5, $6, $7,
         $8, $9, $10, $11,
         $12::jsonb, $13::jsonb, $14
       )
       returning id, entry_hash, previous_entry_hash, action, company_id,
                 window_start, window_end, source_count,
                 payload_hash, context_hash, key_id, signature_b64,
                 material_json, payload_json,
                 s3_bucket, s3_key, s3_version_id, s3_object_locked,
                 ots_proof_path, ots_status, created_at`,
      [
        entryHash,
        previousHash,
        action,
        params.companyId,
        params.windowStart,
        params.windowEnd,
        params.sourceCount,
        payloadHash,
        contextHash,
        key.keyId,
        signatureB64,
        materialCanonical,
        payloadCanonical,
        createdAt,
      ],
    )
    await client.query('commit')

    const row = insertResult.rows[0]!
    // Backfill the joined public key + key id (the insert RETURNING only
    // gets the FK key_id; rowToEntry needs the matching public_key_b64).
    const enriched: EntryRow = {
      ...row,
      public_key_b64: key.publicKeyB64,
    }
    return rowToEntry(enriched)
  } catch (err) {
    await client.query('rollback').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

const ENTRY_SELECT = `
  select e.id, e.entry_hash, e.previous_entry_hash, e.action, e.company_id,
         e.window_start, e.window_end, e.source_count,
         e.payload_hash, e.context_hash,
         e.key_id, k.public_key_b64, e.signature_b64,
         e.material_json, e.payload_json,
         e.s3_bucket, e.s3_key, e.s3_version_id, e.s3_object_locked,
         e.ots_proof_path, e.ots_status, e.created_at
    from audit_escrow_entries e
    join audit_escrow_keys k on k.key_id = e.key_id`

export async function getEntryById(pool: Pool, entryId: number): Promise<AuditEscrowEntry | null> {
  const result = await pool.query<EntryRow>(`${ENTRY_SELECT} where e.id = $1`, [entryId])
  if (result.rows.length === 0) return null
  return rowToEntry(result.rows[0]!)
}

export async function getChainHead(pool: Pool): Promise<{ entryId: number; entryHash: string } | null> {
  const result = await pool.query<{ id: string | number; entry_hash: string }>(
    `select id, entry_hash
       from audit_escrow_entries
      order by id desc
      limit 1`,
  )
  if (result.rows.length === 0) return null
  const row = result.rows[0]!
  return {
    entryId: typeof row.id === 'string' ? Number(row.id) : row.id,
    entryHash: row.entry_hash,
  }
}

/**
 * Verify an entry's signature + entry_hash. Returns a structured report
 * suitable for both the in-process GET pre-check (where we want a
 * boolean) and the verbose verification endpoint (where we want the
 * recomputed hashes alongside the stored values).
 */
export interface VerificationReport {
  ok: boolean
  errors: string[]
  recomputed: {
    entryHash: string
    payloadHash: string
    contextHash: string
  }
  stored: {
    entryHash: string
    payloadHash: string
    contextHash: string
  }
  signatureValid: boolean
}

export function verifyEntry(entry: AuditEscrowEntry): VerificationReport {
  const errors: string[] = []
  const materialCanonical = canonicalizeJSON(entry.material)
  const recomputedEntryHash = hashSHA256(materialCanonical)
  const recomputedPayloadHash = hashCanonicalJSON(entry.payload)
  const recomputedContextHash = hashSHA256(
    [entry.previousEntryHash, entry.windowStart.toISOString(), entry.windowEnd.toISOString(), entry.keyId].join('\n'),
  )

  if (recomputedEntryHash !== entry.entryHash) {
    errors.push(`entry_hash mismatch: stored=${entry.entryHash} recomputed=${recomputedEntryHash}`)
  }
  if (recomputedPayloadHash !== entry.payloadHash) {
    errors.push(`payload_hash mismatch: stored=${entry.payloadHash} recomputed=${recomputedPayloadHash}`)
  }
  if (recomputedContextHash !== entry.contextHash) {
    errors.push(`context_hash mismatch: stored=${entry.contextHash} recomputed=${recomputedContextHash}`)
  }
  // Material's embedded hashes must match too — defends against a row
  // whose top-level hashes were patched but whose material wasn't.
  if (entry.material.payload_hash !== entry.payloadHash) {
    errors.push(
      `material.payload_hash != row.payload_hash: material=${entry.material.payload_hash} row=${entry.payloadHash}`,
    )
  }
  if (entry.material.context_hash !== entry.contextHash) {
    errors.push(
      `material.context_hash != row.context_hash: material=${entry.material.context_hash} row=${entry.contextHash}`,
    )
  }
  const signatureValid = verifyEd25519(entry.publicKeyB64, materialCanonical, entry.signatureB64)
  if (!signatureValid) {
    errors.push('signature verification failed')
  }

  return {
    ok: errors.length === 0,
    errors,
    recomputed: {
      entryHash: recomputedEntryHash,
      payloadHash: recomputedPayloadHash,
      contextHash: recomputedContextHash,
    },
    stored: {
      entryHash: entry.entryHash,
      payloadHash: entry.payloadHash,
      contextHash: entry.contextHash,
    },
    signatureValid,
  }
}

// -----------------------------------------------------------------------------
// Seal metadata (S3 + OTS) — best-effort post-anchor updates
// -----------------------------------------------------------------------------

export interface SealMetadataInput {
  entryId: number
  s3Bucket?: string
  s3Key?: string
  s3VersionId?: string
  s3ObjectLocked?: boolean
  otsProofPath?: string
  otsStatus?: string
}

/**
 * Record external-sealing metadata on an existing entry. Idempotent; a
 * second call with a different value overrides the previous (operators
 * may re-seal an entry after an outage). Failure to seal is non-fatal —
 * the local signed chain is the legally-meaningful primitive; S3/OTS
 * are the cherry on top.
 */
export async function sealEntry(pool: Pool, input: SealMetadataInput): Promise<void> {
  await pool.query(
    `update audit_escrow_entries
        set s3_bucket = coalesce(nullif($2, ''), s3_bucket),
            s3_key = coalesce(nullif($3, ''), s3_key),
            s3_version_id = coalesce(nullif($4, ''), s3_version_id),
            s3_object_locked = case when $5::boolean is null then s3_object_locked else $5::boolean end,
            ots_proof_path = coalesce(nullif($6, ''), ots_proof_path),
            ots_status = coalesce(nullif($7, ''), ots_status)
      where id = $1`,
    [
      input.entryId,
      input.s3Bucket ?? '',
      input.s3Key ?? '',
      input.s3VersionId ?? '',
      input.s3ObjectLocked ?? null,
      input.otsProofPath ?? '',
      input.otsStatus ?? '',
    ],
  )
}
