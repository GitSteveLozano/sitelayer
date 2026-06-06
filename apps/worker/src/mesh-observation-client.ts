import { createHash, createHmac } from 'node:crypto'
import {
  createProjectSignal,
  HttpSink,
  NullSink,
  type EventSink,
  type HttpSinkOptions,
  type ProjectEvent,
  type SignFn,
} from '@operator/projectkit'

// mesh-observation-client.ts — best-effort telemetry POST for the operator's
// observation ingest. Adopts the @operator/projectkit contract: the
// observation is shaped into a projectkit ProjectEvent and delivered through an
// HttpSink (mesh is just a URL). The mesh canonical-HMAC is INJECTED as the
// sink's `sign` callback so the wire-shaping (envelope, transport) lives in the
// published contract, not duplicated here. When the ingress URL env is unset we
// wire a NullSink and telemetry is simply OFF — the app keeps working.
//
// The injected HMAC mirrors the canonical-string scheme verified by mesh's
// hmacAuthMiddleware:
//
//   canonical = "<unix_ts>.<METHOD>.<URI-PATH>.<HEX-SHA256-OF-BODY>"
//   X-Mesh-Signature = "sha256=" + HEX(HMAC-SHA256(secret_bytes, canonical))
//
// Replay window is 300s server-side; we sign with a current unix timestamp per
// request and the timestamp travels in X-Mesh-Timestamp.
//
// Best-effort by design — failures don't bubble up to callers, they're logged
// at warn-level. The sitelayer side of Wedge 4 is "telemetry to mesh, not
// authoritative state": work-item status transitions persist in sitelayer's
// audit log regardless of whether the mesh POST lands.
//
// Required env (secret/env handling unchanged — the secret stays here, never
// moved):
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

const OBSERVATION_PROJECT_KEY = 'sitelayer'

/**
 * Map an observation payload onto the projectkit ProjectEvent contract. The
 * subscriber-specific fields (source/subject/status/reason/severity/metadata)
 * travel as a small flat payload so a subscriber that understands the legacy
 * observation shape still has every field, while the common fields
 * (event_type, occurred_at, outcome, …) route through the contract.
 */
function toObservationProjectEvent(
  payload: ObservationEventPayload,
  occurredAt: string,
): Omit<ProjectEvent, 'schema_version' | 'project_key'> {
  const event: Omit<ProjectEvent, 'schema_version' | 'project_key'> = {
    event_type: payload.event_type,
    occurred_at: occurredAt,
    domain: 'diagnostic',
    entity_kind: payload.subject.type,
    entity_id: payload.subject.id,
    source_surface: payload.source,
    payload: {
      source: payload.source,
      subject: payload.subject,
      status: payload.status,
      reason: payload.reason,
      severity: payload.severity,
      metadata: payload.metadata,
    },
  }
  if (payload.status !== undefined) event.outcome = payload.status
  if (payload.reason !== undefined) event.reason = payload.reason
  return event
}

/**
 * Build the injected HMAC signer. Returns null when env is incomplete so the
 * caller can fall back to a NullSink (telemetry OFF). The signer computes the
 * mesh canonical-string over the FINAL request body string the HttpSink is
 * about to POST — so the route path + header names + scheme live here in host
 * config, and the contract package never holds a mesh secret.
 */
function buildMeshSigner(url: string, component: string, secret: Buffer, now: () => Date): SignFn {
  const path = parsePath(url) ?? '/'
  return (body: string) => {
    const timestamp = String(Math.floor(now().getTime() / 1000))
    const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex')
    const canonical = `${timestamp}.POST.${path}.${bodySha256}`
    const signature = 'sha256=' + createHmac('sha256', secret).update(canonical).digest('hex')
    return {
      'X-Mesh-Component': component,
      'X-Mesh-Timestamp': timestamp,
      'X-Mesh-Signature': signature,
    }
  }
}

export async function postObservationEvent(
  payload: ObservationEventPayload,
  deps: PostObservationDeps = {},
): Promise<PostObservationResult> {
  const url = (process.env.MESH_OBSERVATION_INGRESS_URL ?? '').trim()
  const component = (process.env.MESH_OBSERVATION_COMPONENT ?? '').trim()
  const secretHex = (process.env.MESH_OBSERVATION_SECRET_HEX ?? '').trim()
  const now = deps.now ?? (() => new Date())
  const log = deps.logger ?? console

  // Unconfigured → NullSink: telemetry is simply off, the app keeps working.
  // The contract path is still exercised (inertly) so the seam is uniform.
  if (!url || !component || !secretHex) {
    const sink: EventSink = new NullSink()
    const occurredAt = (payload.occurred_at ?? now().toISOString()).toString()
    await deliverViaSink(sink, payload, occurredAt)
    return { attempted: false, ok: false, error: 'observation client not configured' }
  }

  let secret: Buffer
  try {
    secret = Buffer.from(secretHex, 'hex')
  } catch {
    return { attempted: false, ok: false, error: 'invalid secret hex' }
  }
  if (secret.length === 0) {
    return { attempted: false, ok: false, error: 'empty secret bytes' }
  }
  if (!parsePath(url)) {
    return { attempted: false, ok: false, error: 'observation url has no path component' }
  }

  const occurredAt = (payload.occurred_at ?? now().toISOString()).toString()
  const sinkOptions: HttpSinkOptions = {
    url,
    sign: buildMeshSigner(url, component, secret, now),
    timeoutMs: 8000,
    name: 'mesh-observation',
  }
  if (deps.fetchImpl) sinkOptions.fetchImpl = deps.fetchImpl
  const sink = new HttpSink(sinkOptions)

  // Pre-flight body size check against the envelope (not just the inner event),
  // preserving the 64KiB ceiling the previous wire honored.
  const probeEnvelope = JSON.stringify(buildEnvelopePreview(payload, occurredAt))
  if (Buffer.byteLength(probeEnvelope, 'utf8') > MAX_BODY_BYTES) {
    return { attempted: false, ok: false, error: 'body exceeds 64KiB limit' }
  }

  try {
    const result = await deliverViaSink(sink, payload, occurredAt)
    if (!result.ok) {
      log.warn?.('mesh observation ingest non-2xx', result.status, (result.error ?? '').slice(0, 240))
      const failed: PostObservationResult = {
        attempted: true,
        ok: false,
        error: result.error ?? (result.status ? `mesh ingest ${result.status}` : 'mesh ingest failed'),
      }
      if (result.status !== undefined) failed.status = result.status
      return failed
    }
    const okResult: PostObservationResult = { attempted: true, ok: true }
    if (result.status !== undefined) okResult.status = result.status
    return okResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn?.('mesh observation ingest fetch failed', message)
    return { attempted: true, ok: false, error: message }
  }
}

/** Deliver one observation as a projectkit ProjectEvent through the given sink. */
function deliverViaSink(sink: EventSink, payload: ObservationEventPayload, occurredAt: string) {
  const signal = createProjectSignal({
    projectKey: OBSERVATION_PROJECT_KEY,
    sink,
    producer: { name: 'sitelayer-worker' },
    now: () => occurredAt,
    onError: () => {},
  })
  return signal.emit(toObservationProjectEvent(payload, occurredAt))
}

/** Shape a representative envelope for the pre-flight size check. */
function buildEnvelopePreview(payload: ObservationEventPayload, occurredAt: string) {
  const event = toObservationProjectEvent(payload, occurredAt)
  return {
    contract_version: '1.0.0',
    project_key: OBSERVATION_PROJECT_KEY,
    emitted_at: occurredAt,
    producer: { name: 'sitelayer-worker' },
    events: [{ ...event, schema_version: '1.0.0', project_key: OBSERVATION_PROJECT_KEY }],
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
