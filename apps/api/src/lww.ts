/**
 * Last-write-wins helpers for measurement-style updates.
 *
 * The flow:
 *   - Frontend persists a `client_updated_at` ISO timestamp on every queued
 *     offline mutation (apps/web/src/api.ts). When replaying, it sets the
 *     `If-Unmodified-Since` header to that value.
 *   - The API reads the row's current `updated_at` and, if the server is
 *     newer than the client's reference timestamp, returns 409 with the
 *     authoritative server value so the client can drop the queued mutation
 *     and surface a "newer change synced from another device" toast.
 *   - Absent header → no LWW gate (keep older clients working).
 *
 * This is the LWW choice documented in CLAUDE.md → Decisions #4.
 */

export type LwwCheckResult =
  | { ok: true; clientReference: Date | null }
  | { ok: false; reason: 'header_unparseable'; rawHeader: string }
  | { ok: false; reason: 'server_newer'; serverUpdatedAt: Date; clientReference: Date }

export function parseIfUnmodifiedSince(header: string | undefined | null): Date | null {
  if (!header) return null
  const trimmed = String(header).trim()
  if (!trimmed) return null
  // Accept ISO 8601 (the offline queue always emits ISO via toISOString()) and
  // RFC 7231 IMF-fixdate. Date.parse handles both. We just guard against NaN.
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed)
}

/**
 * @param serverUpdatedAt the row's current `updated_at`
 * @param ifUnmodifiedSinceHeader raw value of the If-Unmodified-Since header
 * @returns whether the write should proceed, or how to reject it
 */
export function evaluateLww(
  serverUpdatedAt: Date | string | null | undefined,
  ifUnmodifiedSinceHeader: string | string[] | undefined | null,
): LwwCheckResult {
  const rawHeader = Array.isArray(ifUnmodifiedSinceHeader)
    ? ifUnmodifiedSinceHeader[0]
    : (ifUnmodifiedSinceHeader ?? '')
  if (!rawHeader) {
    return { ok: true, clientReference: null }
  }
  const clientReference = parseIfUnmodifiedSince(rawHeader)
  if (!clientReference) {
    return { ok: false, reason: 'header_unparseable', rawHeader }
  }
  if (!serverUpdatedAt) {
    // Server has no timestamp to compare; let the write through.
    return { ok: true, clientReference }
  }
  const serverDate = serverUpdatedAt instanceof Date ? serverUpdatedAt : new Date(serverUpdatedAt)
  if (Number.isNaN(serverDate.getTime())) {
    return { ok: true, clientReference }
  }
  // Server-side timestamp strictly newer than client reference → reject.
  // Equal timestamps mean the client was looking at the version we have,
  // so allow the write.
  if (serverDate.getTime() > clientReference.getTime()) {
    return { ok: false, reason: 'server_newer', serverUpdatedAt: serverDate, clientReference }
  }
  return { ok: true, clientReference }
}
