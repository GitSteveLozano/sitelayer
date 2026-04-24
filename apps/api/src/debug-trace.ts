import { timingSafeEqual } from 'node:crypto'
import type { AppTier } from '@sitelayer/config'

export class DebugTraceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DebugTraceError'
  }
}

export type DebugTraceAuthResult =
  | { ok: true; presentedToken: string }
  | { ok: false; status: number; body: { error: string; request_id?: string | undefined }; authenticate?: boolean }

export function safeTokenEqual(received: string, expected: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function authorizeDebugTraceRequest({
  debugToken,
  tier,
  allowProd,
  authorizationHeader,
  requestId,
}: {
  debugToken: string | undefined
  tier: AppTier
  allowProd?: string | undefined
  authorizationHeader: string | string[] | undefined
  requestId?: string | undefined
}): DebugTraceAuthResult {
  if (!debugToken) {
    return { ok: false, status: 404, body: { error: 'not found' } }
  }

  if (tier === 'prod' && allowProd !== '1') {
    return { ok: false, status: 403, body: { error: 'debug endpoint disabled in prod', request_id: requestId } }
  }

  const presented =
    typeof authorizationHeader === 'string' && authorizationHeader.startsWith('Bearer ')
      ? authorizationHeader.slice(7).trim()
      : ''
  if (!presented || !safeTokenEqual(presented, debugToken)) {
    return {
      ok: false,
      status: 401,
      body: { error: 'invalid debug token', request_id: requestId },
      authenticate: true,
    }
  }

  return { ok: true, presentedToken: presented }
}

export function parseTraceIdFromSentryTraceHeader(header: string | null): string | null {
  if (!header) return null
  const match = header.match(/^([0-9a-f]{32})-/i)
  return match?.[1] ?? null
}

export function readSentryTraceConfig(env: NodeJS.ProcessEnv = process.env): {
  org: string
  token: string
  host: string
} {
  const org = env.SENTRY_ORG
  const token = env.SENTRY_AUTH_TOKEN
  if (!org || !token) {
    throw new DebugTraceError(503, 'debug trace lookup requires SENTRY_ORG and SENTRY_AUTH_TOKEN')
  }
  return { org, token, host: env.SENTRY_HOST ?? 'sentry.io' }
}

export async function fetchSentryTrace(
  traceId: string,
  signal: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const { org, token, host } = readSentryTraceConfig(env)
  const url = `https://${host}/api/0/organizations/${encodeURIComponent(org)}/events-trace/${encodeURIComponent(traceId)}/`
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new DebugTraceError(
      response.status === 404 ? 404 : 502,
      `sentry trace fetch failed: ${response.status} ${body.slice(0, 256)}`,
    )
  }
  return response.json()
}
