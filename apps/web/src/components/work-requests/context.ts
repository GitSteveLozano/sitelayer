import { getBuildSha, nextRequestId } from '@/lib/api/client'

export type WorkRequestClientContext = Record<string, unknown>

export function buildBrowserWorkRequestContext(extra: WorkRequestClientContext = {}): WorkRequestClientContext {
  const path =
    typeof window === 'undefined'
      ? { path: null, search: null, route: null }
      : {
          path: window.location.pathname,
          search: window.location.search || null,
          route: `${window.location.pathname}${window.location.search}`,
        }
  return {
    source: 'web',
    captured_at: new Date().toISOString(),
    client_request_id: nextRequestId(),
    build_sha: getBuildSha(),
    page: path,
    browser: readBrowserContext(),
    ...extra,
  }
}

function readBrowserContext(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null
  const connection = readConnectionContext(window.navigator)
  return {
    url: window.location.href,
    locale: window.navigator.language || null,
    timezone: readTimezone(),
    online: window.navigator.onLine,
    visibility_state: typeof document === 'undefined' ? null : document.visibilityState,
    user_agent_family: userAgentFamily(window.navigator.userAgent),
    mobile: /Mobile|Android|iPhone|iPad|iPod/i.test(window.navigator.userAgent),
    viewport: {
      width: finiteNumber(window.innerWidth),
      height: finiteNumber(window.innerHeight),
      device_pixel_ratio: finiteNumber(window.devicePixelRatio) ?? 1,
    },
    ...(connection ? { connection } : {}),
  }
}

function readConnectionContext(navigatorRef: Navigator): Record<string, unknown> | null {
  const connection = (
    navigatorRef as Navigator & {
      connection?: {
        effectiveType?: string
        saveData?: boolean
        rtt?: number
        downlink?: number
      }
    }
  ).connection
  if (!connection) return null
  return {
    effective_type: typeof connection.effectiveType === 'string' ? connection.effectiveType : null,
    save_data: typeof connection.saveData === 'boolean' ? connection.saveData : null,
    rtt: finiteNumber(connection.rtt),
    downlink: finiteNumber(connection.downlink),
  }
}

function readTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function userAgentFamily(userAgent: string): string {
  if (/Edg\//.test(userAgent)) return 'edge'
  if (/Firefox\//.test(userAgent)) return 'firefox'
  if (/CriOS\/|Chrome\//.test(userAgent)) return 'chrome'
  if (/Safari\//.test(userAgent)) return 'safari'
  return 'unknown'
}
