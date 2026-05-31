import { createHash } from 'node:crypto'

/**
 * UUID derived from a scoped ref. Same ref+scope → same id forever, so
 * tests can reference rows by name across runs. The output respects
 * UUIDv4 version/variant nibbles so it passes `isValidUuid` in
 * apps/api/src/http-utils.ts.
 *
 * NOTE: this is a verbatim lift of the helper that lived in
 * `scripts/seed-scenario.ts`. The derivation MUST stay byte-identical —
 * every already-seeded dev/demo row keys on these ids, and a change here
 * would silently fork the id space (breaking idempotency + cross-references).
 */
export function refUuid(scope: string, ref: string): string {
  const hash = createHash('sha256').update(`sitelayer:scenario:${scope}:${ref}`).digest('hex')
  // Version 4 (random) layout: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y is 8/9/a/b.
  const variant = ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(18, 20)}`,
    hash.slice(20, 32),
  ].join('-')
}
