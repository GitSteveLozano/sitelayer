import type http from 'node:http'
import type { Pool, PoolClient } from 'pg'
import type { ActiveCompany, CompanyRole } from './auth-types.js'
import type { Identity } from './auth.js'

/**
 * Context passed to every entity route module. Pulls together the
 * per-request state (req/res/url, the resolved company + identity) and the
 * cross-cutting helpers handlers need (requireRole / checkVersion).
 *
 * This is the seam that lets us split server.ts into entity-scoped modules
 * without each module having to import server.ts directly.
 */
export type RouteContext = {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  pool: Pool
  company: ActiveCompany
  identity: Identity
  /**
   * Enforce role-based access. Returns true when allowed; on false, the
   * helper has already sent the 403 response and the handler should return.
   */
  requireRole: (allowed: readonly CompanyRole[]) => boolean
  /**
   * Wrap `fn` in BEGIN/COMMIT and run it against a dedicated PoolClient.
   * Same shape as the module-level withMutationTx in mutation-tx.ts; passed
   * here so the route modules don't have to know about the global pool.
   */
  withMutationTx: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>
  /**
   * Optimistic-concurrency check used by every PATCH/DELETE handler. Returns
   * true when the version still matches; on false, the helper has already
   * sent the 409 response and the handler should return.
   */
  checkVersion: (table: string, where: string, params: unknown[], expectedVersion: number | null) => Promise<boolean>
  /**
   * Parse a JSON request body once and cache the result on the context so
   * a route module can read it cheaply.
   */
  readBody: () => Promise<Record<string, unknown>>
  sendJson: (status: number, body: unknown) => void
  /**
   * The currently-active user id (from Clerk JWT or fallback header).
   * Threaded into mutation_outbox.actor_user_id.
   */
  getCurrentUserId: () => string
}
