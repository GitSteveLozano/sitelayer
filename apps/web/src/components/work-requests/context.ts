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
    ...extra,
  }
}
