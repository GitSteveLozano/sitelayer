import http from 'node:http'

export const CORS_ALLOW_HEADERS =
  'content-type, authorization, baggage, sentry-trace, traceparent, x-request-id, x-sitelayer-company-id, x-sitelayer-company-slug, x-sitelayer-user-id'
export const CORS_EXPOSE_HEADERS = 'x-request-id, etag'

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * Pick the response Origin header from the configured allowlist. Falls back to
 * the first allowed origin (or `*` when nothing is configured) so the browser
 * still gets a usable header even on no-origin requests like curl.
 */
export function getCorsOrigin(req: http.IncomingMessage, allowedOrigins: readonly string[]): string {
  const origin = req.headers.origin
  if (!origin) return allowedOrigins[0] ?? '*'
  const originStr = Array.isArray(origin) ? origin[0] : origin
  return allowedOrigins.includes(originStr) ? originStr : (allowedOrigins[0] ?? '*')
}

/**
 * Standard JSON response with CORS headers attached. The `req` arg is optional;
 * when omitted the origin defaults to `*` (used for paths handled before CORS
 * resolution, like /health).
 */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  opts?: { req?: http.IncomingMessage; allowedOrigins?: readonly string[] },
): void {
  const allowedOrigins = opts?.allowedOrigins ?? []
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': opts?.req ? getCorsOrigin(opts.req, allowedOrigins) : '*',
    'access-control-allow-methods': 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-expose-headers': CORS_EXPOSE_HEADERS,
  })
  res.end(JSON.stringify(body, null, 2))
}

export function sendRedirect(res: http.ServerResponse, location: string): void {
  res.writeHead(303, { location })
  res.end()
}

/**
 * Read a JSON request body, capped at `maxJsonBodyBytes` to defend against
 * runaway uploads. An empty body resolves to `{}` so handlers can treat
 * zero-byte POSTs the same as an empty object literal.
 */
export function readBody(req: http.IncomingMessage, maxJsonBodyBytes: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let receivedBytes = 0
    let rejected = false
    req.on('data', (chunk) => {
      if (rejected) return
      const buffer = Buffer.from(chunk)
      receivedBytes += buffer.length
      if (receivedBytes > maxJsonBodyBytes) {
        rejected = true
        reject(new HttpError(413, `request body exceeds ${maxJsonBodyBytes} bytes`))
        req.destroy()
        return
      }
      chunks.push(buffer)
    })
    req.on('end', () => {
      if (rejected) return
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        reject(new HttpError(400, 'invalid JSON body'))
      }
    })
    req.on('error', (error) => {
      if (!rejected) reject(error)
    })
  })
}

export function isValidDateInput(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function parseOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return null
  return parsed
}

export function parseExpectedVersion(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function isValidUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

/**
 * Coerce a JSON config payload off the request body. Accepts either a
 * pre-parsed object, a raw JSON string, or null/undefined/empty (-> {}).
 * Throws on invalid JSON so the handler can return a 400. Used by
 * pricing-profiles, bonus-rules, and similar config-bearing entities.
 */
export function parseConfigPayload(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'object') return value as Record<string, unknown>
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return {}
    return JSON.parse(trimmed) as Record<string, unknown>
  }
  return {}
}

/**
 * Validate a route's JSON body against a Zod schema. Mirror of the
 * pattern used by workflow event endpoints
 * (parseRentalBillingEventRequest etc.) but without coupling to a
 * specific workflow shape.
 *
 * Returns a discriminated result. The route handler should:
 *   const parsed = parseJsonBody(MySchema, await ctx.readBody())
 *   if (!parsed.ok) {
 *     ctx.sendJson(400, { error: parsed.error })
 *     return true
 *   }
 *   const body = parsed.value
 *
 * No numeric coercion is performed — a route that needs to accept
 * "5" alongside 5 should declare the field as `z.coerce.number()`
 * (or `.union([z.number(), z.string()])`). Coercing every numeric
 * string globally would silently mutate fields like "01234" zip
 * codes, which is too risky for a generic helper.
 *
 * The error message follows the workflow-event-parser convention
 * ("path: zod issue message") so route handlers can pass the error
 * straight to the client without additional formatting.
 */
export interface ParseJsonBodyOk<T> {
  ok: true
  value: T
}
export interface ParseJsonBodyErr {
  ok: false
  error: string
}
export type ParseJsonBodyResult<T> = ParseJsonBodyOk<T> | ParseJsonBodyErr

export function parseJsonBody<T>(
  schema: {
    safeParse: (value: unknown) =>
      | { success: true; data: T }
      | {
          success: false
          error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }
        }
  },
  body: unknown,
): ParseJsonBodyResult<T> {
  const result = schema.safeParse(body ?? {})
  if (result.success) return { ok: true, value: result.data }
  const issue = result.error.issues[0]
  const path = issue?.path.length ? issue.path.map((p) => String(p)).join('.') : '(root)'
  return { ok: false, error: `${path}: ${issue?.message ?? 'invalid request body'}` }
}
