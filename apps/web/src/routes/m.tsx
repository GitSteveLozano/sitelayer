/**
 * Mount point for the role-aware mobile shell.
 *
 * Originally landed at `/m/*` (PR #229) as a parallel mobile UX next to
 * v2's desktop AppShell. On 2026-05-05 we promoted it to the app root
 * (Option A) and retired AppShell — production is mobile-first. The
 * `basePath` prop lets the same component serve both:
 *
 *   - basePath=""   → mounted at `/*`     (canonical, post-2026-05-05)
 *   - basePath="/m" → mounted at `/m/*`   (legacy alias kept for any
 *                                          external links pointing at
 *                                          the original entry)
 *
 * The shell expects:
 *   - bootstrap: BootstrapResponse | null
 *   - companyRole: 'admin' | 'foreman' | 'office' | 'member'
 *   - companySlug: string
 *
 * Data flow (post-PR #244): the bootstrap + session payloads are fetched
 * via TanStack Query so a re-mount, route change, or background refetch
 * doesn't force a full reload. Underneath, the two queries still hit
 * `/api/bootstrap` and `/api/session` — same shape as v1 — but the
 * caching, retry, and dedupe machinery is v2's standard
 * `lib/api/client.ts:request<T>()` path.
 */
import { Navigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { type BootstrapResponse, type SessionResponse } from '@/lib/api'
import { ApiError, request, getActiveCompanySlug } from '../lib/api/client'
import { queryKeys } from '../lib/api/keys'
import { normalizeMobileShellRole } from '../lib/active-context'
import { MobileShell } from '../screens/mobile-shell'

type MRouteProps = {
  basePath?: string
}

export default function MRoute({ basePath = '' }: MRouteProps) {
  const companySlug = getActiveCompanySlug() || 'la-operations'

  const bootstrapQuery = useQuery({
    queryKey: queryKeys.bootstrap(companySlug),
    queryFn: () => request<BootstrapResponse>('/api/bootstrap', { companySlug }),
  })

  const sessionQuery = useQuery({
    queryKey: queryKeys.session(companySlug),
    queryFn: () => request<SessionResponse>('/api/session', { companySlug }),
  })

  const error = bootstrapQuery.error ?? sessionQuery.error

  // First-sign-in path: the user authenticated with Clerk but has no
  // company_memberships row yet, so getCompany() returns null and the
  // API responds 404 with `error: "company slug … not found"`. Bounce
  // them to /onboarding where the wizard creates a company + admin
  // membership in one POST. Anything else (network, 5xx, real auth
  // failure) renders the inline error so we don't mask outages.
  const needsOnboarding =
    error instanceof ApiError &&
    error.status === 404 &&
    error.body !== null &&
    typeof error.body === 'object' &&
    'error' in error.body &&
    typeof (error.body as { error: unknown }).error === 'string' &&
    /company slug.*not found|requires_onboarding/i.test((error.body as { error: string }).error)

  if (needsOnboarding) {
    return <Navigate to="/onboarding" replace />
  }
  if (error) {
    return <div className="p-4 text-[12px] text-bad">Failed to load: {String(error)}</div>
  }

  // Prefer the membership row that lines up with the active company,
  // then user.role on the session, then 'member'. The shell still upgrades
  // role per project assignment.
  const session = sessionQuery.data ?? null
  const sessionRole = session?.memberships?.find((m) => m.slug === companySlug)?.role ?? session?.user?.role ?? null

  return (
    <MobileShell
      bootstrap={bootstrapQuery.data ?? null}
      companyRole={normalizeMobileShellRole(sessionRole)}
      companySlug={companySlug}
      basePath={basePath}
    />
  )
}
