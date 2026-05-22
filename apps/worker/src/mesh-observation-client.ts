import { createHash, createHmac } from 'node:crypto'

// mesh-observation-client.ts — minimal HMAC POST client for mesh's
// /api/observations/ingest endpoint (server_observation_events_ingest.go).
// Mirrors the canonical-string scheme verified by mesh's hmacAuthMiddleware:
//
//   canonical = "<unix_ts>.<METHOD>.<URI-PATH>.<HEX-SHA256-OF-BODY>"
//   X-Mesh-Signature = "sha256=" + HEX(HMAC-SHA256(secret_bytes, canonical))
//
// Empty body hashes to the well-known
// e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 SHA-256.
// Replay window is 300s server-side; we send a current unix timestamp
// per request.
//
// Best-effort by design — failures don't bubble up to callers, they're
// logged at warn-level. The sitelayer side of Wedge 4 is "telemetry to
// mesh, not authoritative state": work item status transitions persist
// in sitelayer's audit log regardless of whether the mesh POST lands.
//
// Required env:
//   MESH_OBSERVATION_INGRESS_URL    — full URL, e.g.
//                                     http://mesh-hetzner:8713/api/observations/ingest
//   MESH_OBSERVATION_COMPONENT      — component name registered in mesh's
//                                     component_auth_secrets table
//                                     (e.g. "sitelayer-worker")
//   MESH_OBSERVATION_SECRET_HEX     — hex-encoded secret bytes for the
//                                     above component

export type ObservationEventPayload = {
  source: string
  event_type: string
  subject: { type: string; id: string }
  status?: string
  reason?: string
  severity?: string
  occurred_at?: string
  metadata?: Record<string, unknown>
}

export type PostObservationResult = {
  attempted: boolean
  ok: boolean
  status?: number
  error?: string
}

export type PostObservationDeps = {
  fetchImpl?: typeof fetch
  now?: () => Date
  logger?: { warn: (...args: unknown[]) => void }
}

const MAX_BODY_BYTES = 64 * 1024

export async function postObservationEvent(
  payload: ObservationEventPayload,
  deps: PostObservationDeps = {},
): Promise<PostObservationResult> {
  const url = (process.env.MESH_OBSERVATION_INGRESS_URL ?? '').trim()
  const component = (process.env.MESH_OBSERVATION_COMPONENT ?? '').trim()
  const secretHex = (process.env.MESH_OBSERVATION_SECRET_HEX ?? '').trim()
  if (!url || !component || !secretHex) {
    return { attempted: false, ok: false, error: 'observation client not configured' }
  }
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = (deps.now ?? (() => new Date()))()
  const log = deps.logger ?? console
  let secret: Buffer
  try {
    secret = Buffer.from(secretHex, 'hex')
  } catch {
    return { attempted: false, ok: false, error: 'invalid secret hex' }
  }
  if (secret.length === 0) {
    return { attempted: false, ok: false, error: 'empty secret bytes' }
  }
  const bodyJson = JSON.stringify(payload)
  if (Buffer.byteLength(bodyJson, 'utf8') > MAX_BODY_BYTES) {
    return { attempted: false, ok: false, error: 'body exceeds 64KiB limit' }
  }
  const path = parsePath(url)
  if (!path) {
    return { attempted: false, ok: false, error: 'observation url has no path component' }
  }
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const bodySha256 = createHash('sha256').update(bodyJson, 'utf8').digest('hex')
  const canonical = `${timestamp}.POST.${path}.${bodySha256}`
  const signature = 'sha256=' + createHmac('sha256', secret).update(canonical).digest('hex')
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'X-Mesh-Component': component,
        'X-Mesh-Timestamp': timestamp,
        'X-Mesh-Signature': signature,
      },
      body: bodyJson,
    })
    if (!response.ok) {
      const responseText = await response.text().catch(() => '')
      log.warn?.(
        'mesh observation ingest non-2xx',
        response.status,
        responseText.slice(0, 240),
      )
      return { attempted: true, ok: false, status: response.status, error: `mesh ingest ${response.status}` }
    }
    return { attempted: true, ok: true, status: response.status }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn?.('mesh observation ingest fetch failed', message)
    return { attempted: true, ok: false, error: message }
  }
}

function parsePath(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.pathname || null
  } catch {
    return null
  }
}
