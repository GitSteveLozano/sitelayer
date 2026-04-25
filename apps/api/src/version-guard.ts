/**
 * Version-conflict guard for optimistic concurrency endpoints.
 *
 * Many PATCH/DELETE handlers in `server.ts` follow the same shape:
 *
 *   const existing = await pool.query('select version from TABLE where ...')
 *   if (existing.rows[0] && expectedVersion !== null && Number(existing.rows[0].version) !== expectedVersion) {
 *     sendJson(res, 409, { error: 'version conflict', current_version: Number(existing.rows[0].version) })
 *     return false
 *   }
 *   return true
 *
 * `assertVersion` is the de-duplicated form: it runs the SELECT, sends the 409
 * response when a mismatch is detected, and tells the caller whether the write
 * may proceed.
 *
 * Behaviour notes:
 * - When `expectedVersion` is null, the guard is a no-op (returns true) — the
 *   client opted out of optimistic concurrency. We still skip the SELECT in
 *   that case to avoid an extra round-trip.
 * - When the row does not exist, the guard returns true. The caller is
 *   responsible for emitting a 404 (or treating the missing row as expected,
 *   e.g. an upsert path).
 * - The 409 body intentionally matches the inline shape that was previously
 *   used so client code keeps working unchanged.
 */
import type http from 'node:http'

export type VersionGuardPool = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<{ version: number | string }> }>
}

export type VersionGuardResponder = {
  writeHead: http.ServerResponse['writeHead']
  end: http.ServerResponse['end']
}

function defaultSendJson(res: VersionGuardResponder, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body, null, 2))
}

export type AssertVersionOptions = {
  /**
   * Override the JSON sender. Used by `server.ts` to keep CORS headers attached
   * to the 409 response. Defaults to a minimal JSON writer suitable for tests.
   */
  sendJson?: (res: VersionGuardResponder, status: number, body: unknown) => void
}

/**
 * Run the SELECT-then-409 dance for a single-row optimistic concurrency check.
 *
 * @returns `true` if the caller may proceed (no conflict, or no expected
 *          version supplied). `false` if a 409 has already been emitted on
 *          `res` and the caller should bail out.
 */
export async function assertVersion(
  pool: VersionGuardPool,
  table: string,
  where: string,
  params: unknown[],
  expectedVersion: number | null,
  res: VersionGuardResponder,
  options: AssertVersionOptions = {},
): Promise<boolean> {
  if (expectedVersion === null) return true
  const sender = options.sendJson ?? defaultSendJson
  const result = await pool.query(`select version from ${table} where ${where}`, params)
  const current = result.rows[0]
  if (!current) return true
  const currentVersion = Number(current.version)
  if (currentVersion === expectedVersion) return true
  sender(res, 409, { error: 'version conflict', current_version: currentVersion })
  return false
}
