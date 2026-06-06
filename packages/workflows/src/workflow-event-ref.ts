/**
 * The transition-anchor id — the single keystone that lets a frontend trace
 * and a backend `workflow_event_log` row name the SAME deterministic
 * transition without coordination.
 *
 * `workflowEventRef({ workflow_name, entity_id, state_version })` returns
 *
 *   workflow_event:<workflow_name>:<sha256(workflow_name:entity_id:state_version)[:16]>:<state_version>
 *
 * It MUST be byte-identical on both sides of the seam:
 *   - the server lane (apps/worker/src/runners/mesh-trace-forward.ts) stamps
 *     it on every forwarded workflow transition, and
 *   - the client lane (apps/web/src/machines/headless-workflow.ts) stamps it
 *     on the control-plane trace it emits after a load/dispatch.
 * The mesh ingest then dedups + correlates the two by this exact string.
 *
 * Because this anchor crosses the worker (Node) AND the browser bundle, this
 * module is deliberately ISOMORPHIC: it carries its own tiny, dependency-free
 * SHA-256 (no `node:crypto`, no async Web Crypto) so the SAME synchronous
 * function produces the SAME string everywhere. The unit test pins the output
 * against `node:crypto`'s SHA-256 of the same canonical input, proving the
 * hand-rolled digest matches the platform one bit-for-bit.
 */

export interface WorkflowEventRefInput {
  workflow_name: string
  entity_id: string
  state_version: number
}

/** The canonical string the digest is taken over (and the ref's prefix uses). */
function canonicalAnchorString(input: WorkflowEventRefInput): string {
  return `${input.workflow_name}:${input.entity_id}:${input.state_version}`
}

export function workflowEventRef(input: WorkflowEventRefInput): string {
  const digest = sha256Hex(canonicalAnchorString(input)).slice(0, 16)
  return `workflow_event:${input.workflow_name}:${digest}:${input.state_version}`
}

// --- dependency-free SHA-256 (FIPS 180-4) -----------------------------------
// A self-contained, synchronous SHA-256 over a UTF-8 string. Kept private to
// this module; the only public surface is workflowEventRef(). Pinned against
// node:crypto in workflow-event-ref.test.ts.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
])

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits))
}

/** UTF-8 encode a string into bytes (BMP + surrogate pairs). */
function utf8Bytes(input: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    }
  }
  return bytes
}

function sha256Hex(message: string): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  const bytes = utf8Bytes(message)
  const bitLen = bytes.length * 8
  // Append 0x80, then pad with zeros to 56 mod 64, then the 64-bit big-endian length.
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0x00)
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff)
  bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff)

  const w = new Uint32Array(64)
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4
      w[i] =
        (((bytes[j] ?? 0) << 24) | ((bytes[j + 1] ?? 0) << 16) | ((bytes[j + 2] ?? 0) << 8) | (bytes[j + 3] ?? 0)) >>> 0
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0
      const w2 = w[i - 2] ?? 0
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0
    }

    let a = h[0] ?? 0
    let b = h[1] ?? 0
    let c = h[2] ?? 0
    let d = h[3] ?? 0
    let e = h[4] ?? 0
    let f = h[5] ?? 0
    let g = h[6] ?? 0
    let hh = h[7] ?? 0

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h[0] = ((h[0] ?? 0) + a) >>> 0
    h[1] = ((h[1] ?? 0) + b) >>> 0
    h[2] = ((h[2] ?? 0) + c) >>> 0
    h[3] = ((h[3] ?? 0) + d) >>> 0
    h[4] = ((h[4] ?? 0) + e) >>> 0
    h[5] = ((h[5] ?? 0) + f) >>> 0
    h[6] = ((h[6] ?? 0) + g) >>> 0
    h[7] = ((h[7] ?? 0) + hh) >>> 0
  }

  let hex = ''
  for (let i = 0; i < 8; i++) hex += (h[i] ?? 0).toString(16).padStart(8, '0')
  return hex
}
