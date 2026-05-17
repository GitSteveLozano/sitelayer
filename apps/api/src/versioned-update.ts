import type { PoolClient } from 'pg'
import type { ActiveCompany } from './auth-types.js'
import { parseExpectedVersion } from './http-utils.js'
import { withMutationTx } from './mutation-tx.js'

/**
 * Cross-cutting helper for the recurring "PATCH versioned entity" /
 * "DELETE versioned entity" pattern that ~13 entity-CRUD route modules
 * share. The helper preserves the existing behaviour byte-for-byte:
 *
 *   1. Parse `expected_version` (or `version`) off the body.
 *   2. Run the caller's UPDATE inside `withMutationTx`.
 *   3. The caller's `update` callback runs the actual SQL + ledger
 *      writes and returns the row or `null` when the WHERE didn't match.
 *   4. On null, run `checkVersion` to distinguish a stale-version 409
 *      (already sent inside checkVersion) from a real 404.
 *   5. On success, send the row as JSON 200.
 *
 * The helper does not record the ledger row itself — the caller does
 * that inside the update callback so the SQL, the recordMutationLedger
 * call, and any extra side-effects (e.g. customer mapping backfill,
 * parent project version bump) all run in one explicit block. This
 * matches the existing pattern and avoids hiding the ledger shape.
 */
export interface VersionedUpdateCtx {
  company: ActiveCompany
  sendJson: (status: number, body: unknown) => void
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
}

export interface PatchVersionedEntityArgs<TRow> {
  ctx: VersionedUpdateCtx
  /** Already-parsed request body. */
  body: Record<string, unknown>
  /** Ledger entity_type — e.g. 'customer'. Currently informational only;
   *  the caller still calls recordMutationLedger inside the update cb. */
  entityType: string
  /** Human label baked into the 404 body — e.g. 'customer'. */
  entityName: string
  /** SQL table name used for the version-disambiguation lookup. */
  table: string
  /** Entity id (uuid string, code, etc.). Passed to checkVersion. */
  id: string
  /**
   * SQL fragment passed to checkVersion. Defaults to
   * `company_id = $1 and id = $2 and deleted_at is null` which matches
   * customers/workers; routes whose table doesn't have `deleted_at`
   * (bonus_rules, pricing_profiles, ...) or whose primary key is `code`
   * pass a fragment that omits the soft-delete clause / uses the right
   * column. Caller supplies `[company.id, id]` automatically.
   */
  checkVersionWhere?: string
  /**
   * The caller's UPDATE step. Receives the live PoolClient and the
   * parsed expectedVersion. Returns the row or `null` when zero rows
   * matched. The caller is responsible for calling
   * `recordMutationLedger` inside this callback (and any other
   * tx-scoped side effects like parent-row version bumps).
   */
  update: (client: PoolClient, expectedVersion: number | null) => Promise<TRow | null>
}

export async function patchVersionedEntity<TRow>(args: PatchVersionedEntityArgs<TRow>): Promise<true> {
  const expectedVersion = parseExpectedVersion(args.body.expected_version ?? args.body.version)
  const updated = await withMutationTx(async (client) => args.update(client, expectedVersion))
  if (!updated) {
    const where = args.checkVersionWhere ?? 'company_id = $1 and id = $2 and deleted_at is null'
    const ok = await args.ctx.checkVersion(args.table, where, [args.ctx.company.id, args.id], expectedVersion)
    if (!ok) return true
    args.ctx.sendJson(404, { error: `${args.entityName} not found` })
    return true
  }
  args.ctx.sendJson(200, updated)
  return true
}

export interface DeleteVersionedEntityArgs<TRow> {
  ctx: VersionedUpdateCtx
  /**
   * Optional request body — DELETE may carry an expected_version, or it
   * may be unconditional (some routes don't read a body). When omitted
   * `expectedVersion` is null and checkVersion is still consulted: a
   * null expectedVersion is treated as "any version" by the standard
   * checkVersion implementation.
   */
  body?: Record<string, unknown>
  entityType: string
  entityName: string
  table: string
  id: string
  checkVersionWhere?: string
  /** Same shape as the patch update callback. */
  delete: (client: PoolClient, expectedVersion: number | null) => Promise<TRow | null>
}

export async function deleteVersionedEntity<TRow>(args: DeleteVersionedEntityArgs<TRow>): Promise<true> {
  const expectedVersion = args.body ? parseExpectedVersion(args.body.expected_version ?? args.body.version) : null
  const deleted = await withMutationTx(async (client) => args.delete(client, expectedVersion))
  if (!deleted) {
    const where = args.checkVersionWhere ?? 'company_id = $1 and id = $2 and deleted_at is null'
    const ok = await args.ctx.checkVersion(args.table, where, [args.ctx.company.id, args.id], expectedVersion)
    if (!ok) return true
    args.ctx.sendJson(404, { error: `${args.entityName} not found` })
    return true
  }
  args.ctx.sendJson(200, deleted)
  return true
}

// Re-export the ledger helpers so call sites only need to import this
// module for the common case. Helpful for grep — anyone touching this
// pattern lands here first.
export { recordMutationLedger, withMutationTx } from './mutation-tx.js'
