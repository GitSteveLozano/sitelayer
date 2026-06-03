import type http from 'node:http'
import { createHmac } from 'node:crypto'
import {
  HttpSink,
  validateProjectEvent,
  type HttpSinkOptions,
  type ProjectEventEnvelope,
} from '@operator/projectkit'

/**
 * Server-side @operator/projectkit ingest proxy (the SAME-ORIGIN seam).
 *
 * The browser beacon (apps/web/src/lib/product-trace-beacon.ts) posts a
 * ProjectEventEnvelope here; this route validates every event against the
 * published contract and forwards it to the configured subscriber. The
 * subscriber (mesh, or anything else) is JUST a URL — swappable, self-hostable,
 * and never known to the client. This mirrors the nhl testbed's /api/signal
 * route so the boundary is uniform across testbeds.
 *
 * Inert by default: SIGNAL_SINK_URL unset → 204 (capture off, the app keeps
 * working). The HMAC secret stays server-side (SIGNAL_SINK_SECRET) and is
 * INJECTED into the HttpSink's sign callback — never baked into the contract
 * package or shipped to the browser.
 *
 * This is a TELEMETRY path only — no billing/QBO/pricing/cash-path code.
 */

export type SignalRouteCtx = {
  res: http.ServerResponse
  sendJson: (status: number, body: unknown) => void
  /** Read + JSON-parse the request body. */
  readBody: () => Promise<Record<string, unknown>>
  /** Resolved CORS allow-origin for the current request. */
  getCorsOrigin: () => string
}

function sinkUrl(): string | null {
  return process.env.SIGNAL_SINK_URL?.trim() || null
}
function sinkSecret(): string | null {
  return process.env.SIGNAL_SINK_SECRET?.trim() || null
}

/**
 * Pre-auth handler for POST /api/signal. Returns true when it handled the
 * request (so the caller stops walking the route cascade), false otherwise.
 * Unauthenticated by design — the browser beacon carries no Bearer.
 */
export async function handleSignalRoutes(
  req: http.IncomingMessage,
  url: URL,
  ctx: SignalRouteCtx,
): Promise<boolean> {
  if (req.method !== 'POST' || url.pathname !== '/api/signal') return false

  const target = sinkUrl()
  // No sink configured → capture off, the testbed keeps working. A true empty
  // 204 (no body) so the browser beacon's fire-and-forget POST is cheap.
  if (!target) {
    ctx.res.writeHead(204, { 'access-control-allow-origin': ctx.getCorsOrigin() })
    ctx.res.end()
    return true
  }

  let envelope: Record<string, unknown>
  try {
    envelope = await ctx.readBody()
  } catch {
    ctx.sendJson(400, { error: 'invalid json' })
    return true
  }

  const events = (envelope as { events?: unknown }).events
  if (!Array.isArray(events)) {
    ctx.sendJson(400, { error: 'envelope.events must be an array' })
    return true
  }
  const problems = events.flatMap((e) => validateProjectEvent(e))
  if (problems.length > 0) {
    ctx.sendJson(422, { error: 'contract violation', problems })
    return true
  }

  const secret = sinkSecret()
  const options: HttpSinkOptions = { url: target, timeoutMs: 6000, name: 'signal-sink' }
  if (secret) {
    // Signing scheme is the SUBSCRIBER's concern (mesh defines it). Default:
    // HMAC-SHA256 over the body, header x-signal-signature. Injected here so the
    // secret stays server-side and out of the contract package.
    options.sign = (body) => ({
      'x-signal-signature': createHmac('sha256', secret).update(body).digest('hex'),
    })
  }
  const sink = new HttpSink(options)
  const result = await sink.deliver(envelope as unknown as ProjectEventEnvelope)
  ctx.sendJson(result.ok ? 202 : 502, { ok: result.ok, accepted: result.accepted ?? 0 })
  return true
}
