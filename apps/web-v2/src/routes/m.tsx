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
 *   - bootstrap: BootstrapResponse | null   (v1-style /api/bootstrap response)
 *   - companyRole: 'admin' | 'foreman' | 'office' | 'member'
 *   - companySlug: string
 *
 * v2's main runtime uses TanStack Query + Clerk-derived role. This wrapper
 * fetches the v1 bootstrap on mount and threads it in so we don't have to
 * rewrite the shell against v2's hooks. The two API clients coexist —
 * api-v1-compat.ts (the moved 1.6k-line v1 client) services the shell;
 * lib/api/* services everything else. Deduplication is a follow-up.
 */
import { useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { apiGet, getStoredCompanySlug, type BootstrapResponse, type SessionResponse } from '../api-v1-compat'
import { ApiError } from '../lib/api/client'
import { normalizeMobileShellRole } from '../lib/active-context'
import { MobileShell } from '../views/m-shell'

type MRouteProps = {
  basePath?: string
}

export default function MRoute({ basePath = '' }: MRouteProps) {
  const companySlug = getStoredCompanySlug() ?? 'la-operations'
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      apiGet<BootstrapResponse>('/api/bootstrap', companySlug),
      apiGet<SessionResponse>('/api/session', companySlug),
    ])
      .then(([b, s]) => {
        if (cancelled) return
        setBootstrap(b)
        setSession(s)
      })
      .catch((err) => {
        if (!cancelled) setError(err)
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  // First-time visitors have a valid Clerk session but no company yet —
  // both bootstrap and session 404 with `company slug X not found`.
  // Promise.all rejects with whichever lost the race, so accept either
  // path. Send the user to the wizard instead of leaving an error toast.
  if (
    error instanceof ApiError &&
    error.status === 404 &&
    (error.path === '/api/bootstrap' || error.path === '/api/session')
  ) {
    return <Navigate to="/onboarding" replace />
  }

  if (error) {
    return <div className="p-4 text-[12px] text-bad">Failed to load: {String(error)}</div>
  }

  // Match the v1 caller pattern: prefer the membership row that lines up
  // with the active company, fall back to user.role on the session, then
  // fall back to 'member' (which the shell upgrades per project
  // assignment).
  const sessionRole = session?.memberships?.find((m) => m.slug === companySlug)?.role ?? session?.user?.role ?? null

  return (
    <MobileShell
      bootstrap={bootstrap}
      companyRole={normalizeMobileShellRole(sessionRole)}
      companySlug={companySlug}
      basePath={basePath}
    />
  )
}
