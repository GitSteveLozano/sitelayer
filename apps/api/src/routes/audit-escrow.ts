// Audit Escrow verification routes — Wedge 2 of PROVING_GROUND_PLAN.md.
//
// All endpoints are admin-only (mirrors support-debug-packets). The
// authenticated company scope is NOT enforced on these reads because a
// dispute may need cross-company anchors visible to operator support;
// however the company_id is surfaced on every entry so the caller can
// filter.
//
//   GET /api/audit/escrow/:entry_id
//     Returns the bundle (material + signature + public key). The handler
//     verifies in-process BEFORE returning; a verification failure
//     surfaces as 500 with an `escrow_corruption` flag so the alert is
//     loud. The chain row is left intact for forensic inspection.
//
//   GET /api/audit/escrow/verify/:entry_id
//     Same data plus the verbose recompute-and-compare report for use by
//     external auditors. Returns 200 even on signature failure so the
//     auditor sees the diff; the response carries `report.ok`.
//
//   GET /api/audit/escrow/chain/head
//     Pin the chain head (id + entry_hash) so an external verifier can
//     walk backwards.

import type http from 'node:http'
import type { Pool } from 'pg'
import {
  getAuditEscrowChainHead,
  getAuditEscrowEntryById,
  verifyAuditEscrowEntry,
  type AuditEscrowEntry,
  type AuditEscrowVerificationReport,
} from '@sitelayer/queue'
import type { Logger } from '@sitelayer/logger'

export type AuditEscrowRouteCtx = {
  pool: Pool
  requireRole: (allowed: readonly string[]) => boolean
  sendJson: (status: number, body: unknown) => void
  logger?: Logger
}

interface BundleResponse {
  entry: SerializedEntry
  verification?: AuditEscrowVerificationReport
}

interface SerializedEntry {
  id: number
  entry_hash: string
  previous_entry_hash: string
  action: string
  company_id: string | null
  window_start: string
  window_end: string
  source_count: number
  payload_hash: string
  context_hash: string
  key_id: string
  public_key_b64: string
  signature_b64: string
  material: Record<string, unknown>
  payload: Record<string, unknown>
  s3_bucket: string
  s3_key: string
  s3_version_id: string
  s3_object_locked: boolean
  ots_proof_path: string
  ots_status: string
  created_at: string
}

function serializeEntry(entry: AuditEscrowEntry): SerializedEntry {
  return {
    id: entry.id,
    entry_hash: entry.entryHash,
    previous_entry_hash: entry.previousEntryHash,
    action: entry.action,
    company_id: entry.companyId,
    window_start: entry.windowStart.toISOString(),
    window_end: entry.windowEnd.toISOString(),
    source_count: entry.sourceCount,
    payload_hash: entry.payloadHash,
    context_hash: entry.contextHash,
    key_id: entry.keyId,
    public_key_b64: entry.publicKeyB64,
    signature_b64: entry.signatureB64,
    material: entry.material as unknown as Record<string, unknown>,
    payload: entry.payload,
    s3_bucket: entry.s3Bucket,
    s3_key: entry.s3Key,
    s3_version_id: entry.s3VersionId,
    s3_object_locked: entry.s3ObjectLocked,
    ots_proof_path: entry.otsProofPath,
    ots_status: entry.otsStatus,
    created_at: entry.createdAt.toISOString(),
  }
}

function parseEntryId(raw: string | undefined): number | null {
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) return null
  return parsed
}

export async function handleAuditEscrowRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: AuditEscrowRouteCtx,
): Promise<boolean> {
  if (req.method !== 'GET') return false

  // GET /api/audit/escrow/chain/head — return the latest entry id +
  // entry_hash for external chain-pinning. Cheap query, admin-only.
  if (url.pathname === '/api/audit/escrow/chain/head') {
    if (!ctx.requireRole(['admin'])) return true
    const head = await getAuditEscrowChainHead(ctx.pool)
    if (!head) {
      ctx.sendJson(200, { head: null })
      return true
    }
    ctx.sendJson(200, { head: { entry_id: head.entryId, entry_hash: head.entryHash } })
    return true
  }

  // GET /api/audit/escrow/verify/:entry_id — verbose verification.
  const verifyMatch = url.pathname.match(/^\/api\/audit\/escrow\/verify\/(\d+)$/)
  if (verifyMatch) {
    if (!ctx.requireRole(['admin'])) return true
    const entryId = parseEntryId(verifyMatch[1])
    if (entryId == null) {
      ctx.sendJson(400, { error: 'invalid entry_id' })
      return true
    }
    const entry = await getAuditEscrowEntryById(ctx.pool, entryId)
    if (!entry) {
      ctx.sendJson(404, { error: 'escrow entry not found' })
      return true
    }
    const report = verifyAuditEscrowEntry(entry)
    const body: BundleResponse = {
      entry: serializeEntry(entry),
      verification: report,
    }
    // Return 200 even when verification fails so the auditor sees the
    // diff. The fact that report.ok === false is itself the alert
    // signal.
    ctx.sendJson(200, body)
    return true
  }

  // GET /api/audit/escrow/:entry_id — bundle + in-process verification.
  // Pre-verifies before returning so the API never serves a broken
  // signature without alerting. A failed verification returns 500 +
  // logs at error severity; the chain row is left intact for forensic
  // inspection.
  const bundleMatch = url.pathname.match(/^\/api\/audit\/escrow\/(\d+)$/)
  if (bundleMatch) {
    if (!ctx.requireRole(['admin'])) return true
    const entryId = parseEntryId(bundleMatch[1])
    if (entryId == null) {
      ctx.sendJson(400, { error: 'invalid entry_id' })
      return true
    }
    const entry = await getAuditEscrowEntryById(ctx.pool, entryId)
    if (!entry) {
      ctx.sendJson(404, { error: 'escrow entry not found' })
      return true
    }
    const report = verifyAuditEscrowEntry(entry)
    if (!report.ok) {
      ctx.logger?.error(
        { entry_id: entryId, errors: report.errors },
        '[audit-escrow] CORRUPTION DETECTED — stored entry failed in-process verification',
      )
      ctx.sendJson(500, {
        error: 'audit escrow entry failed verification',
        escrow_corruption: true,
        entry_id: entryId,
        errors: report.errors,
      })
      return true
    }
    ctx.sendJson(200, { entry: serializeEntry(entry) })
    return true
  }

  return false
}
