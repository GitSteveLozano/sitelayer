import { useEffect, useMemo, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ColdStartSplash } from '@/components/shell/ColdStartSplash'
import { ControlPlaneProbe } from '@/components/ControlPlaneProbe'
import {
  ApiError,
  getActiveCompanySlug,
  queryKeys,
  request,
  setActiveCompanySlug,
  type BootstrapResponse,
  type SessionResponse,
} from '@/lib/api'
import { ACTIVE_COMPANY_STORAGE_KEY } from '@/lib/api/client'
import { normalizeMobileShellRole } from '@/lib/active-context'
import { membershipRoleToPersona, RoleContext } from '@/lib/role'
import { MobileShell } from '@/screens/mobile-shell'

type MembershipRow = {
  company_id: string
  company_slug: string
  company_name: string
  role: string
}

type MembershipsResponse = {
  memberships: MembershipRow[]
}

type ActiveCompany = {
  id: string
  slug: string
  name: string
  role: string
}

/**
 * Authenticated workspace entry.
 *
 * The old root went straight at `/api/bootstrap` for `la-operations`.
 * That was fine for a demo tenant, but a real multi-company app needs to
 * resolve the caller's memberships first. The canonical role shell still
 * owns navigation: admins land in admin mode, and field-only users stay in
 * foreman/worker mode.
 */
export default function WorkspaceRoute() {
  const membershipsQuery = useQuery({
    queryKey: ['me', 'memberships', 'workspace'],
    queryFn: () => request<MembershipsResponse>('/api/me/memberships'),
    staleTime: 5 * 60_000,
  })

  const activeCompany = useMemo<ActiveCompany | null>(() => {
    const memberships = membershipsQuery.data?.memberships ?? []
    if (memberships.length === 0) return null
    const requestedSlug = getActiveCompanySlug()
    const active = memberships.find((membership) => membership.company_slug === requestedSlug) ?? memberships[0]
    if (!active) return null
    return {
      id: active.company_id,
      slug: active.company_slug,
      name: active.company_name,
      role: active.role,
    }
  }, [membershipsQuery.data?.memberships])

  useEffect(() => {
    if (activeCompany) {
      persistActiveCompanySlug(activeCompany.slug)
    }
  }, [activeCompany])

  if (membershipsQuery.isPending) return <ColdStartSplash />
  if (membershipsQuery.error) return <WorkspaceLoadError error={membershipsQuery.error} />
  if (!activeCompany) return <Navigate to="/onboarding" replace />

  return <CompanyWorkspace activeCompany={activeCompany} />
}

function CompanyWorkspace({ activeCompany }: { activeCompany: ActiveCompany }) {
  const companySlug = activeCompany.slug
  const location = useLocation()

  const bootstrapQuery = useQuery({
    queryKey: queryKeys.bootstrap(companySlug),
    queryFn: () => request<BootstrapResponse>('/api/bootstrap', { companySlug }),
  })

  const sessionQuery = useQuery({
    queryKey: queryKeys.session(companySlug),
    queryFn: () => request<SessionResponse>('/api/session', { companySlug }),
  })

  // CompanyWorkspace is mounted via `<Route path="/*">` so `useParams()`
  // doesn't see deeper segments. Derive `projectId` and `currentTab`
  // from the pathname instead — this is the same pattern the operator-
  // context handshake uses for origin-side state.
  const probeRoute = useMemo(() => parseProbeRoute(location.pathname), [location.pathname])
  const isDesktop = useIsDesktop()

  const error = bootstrapQuery.error ?? sessionQuery.error
  if (needsOnboarding(error)) return <Navigate to="/onboarding" replace />
  if (error) return <WorkspaceLoadError error={error} />

  const session = sessionQuery.data ?? null
  const sessionRole =
    session?.memberships?.find((membership) => membership.slug === companySlug)?.role ??
    activeCompany.role ??
    session?.user?.role ??
    null
  const companyRole = normalizeMobileShellRole(sessionRole)
  const persona = companyRole === 'admin' || companyRole === 'office' ? 'owner' : membershipRoleToPersona(companyRole)

  if (bootstrapQuery.isPending || sessionQuery.isPending) return <ColdStartSplash />

  // Desktop v2 gate: owners on a wide viewport land on the command-center
  // surface (mounted at /desktop). Scoped to the workspace ROOT only — deep
  // routes (/projects/:id, /money, /schedule, …) still render in the shell so
  // direct links + the mobile persona screens keep working for everyone; the
  // command center keeps its own nav under /desktop/*. Foreman/worker always
  // stay on the mobile shell.
  if (isDesktop && persona === 'owner' && location.pathname === '/') {
    return <Navigate to="/desktop" replace />
  }

  const activeProjectName =
    probeRoute.projectId && bootstrapQuery.data
      ? (bootstrapQuery.data.projects.find((p) => p.id === probeRoute.projectId)?.name ?? null)
      : null

  return (
    <RoleContext.Provider value={persona}>
      {/* Operator probe — installs `window.__controlPlaneProbe` for the
          browser-bridge capture-modal. See
          ~/projects/digital-ontology/tab-to-task-current-state-2026-05-22.md §1.6.
          TODO: thread xstate snapshots (project-lifecycle, time-review,
          billing-review) once we expose them at this level — today each
          machine is mounted per-route deeper in the tree. */}
      <ControlPlaneProbe
        companySlug={companySlug}
        projectId={probeRoute.projectId}
        currentTab={probeRoute.currentTab}
        userRole={sessionRole}
        activeProjectName={activeProjectName}
        projectState={null}
        timeReviewState={null}
        billingReviewState={null}
      />
      <MobileShell
        bootstrap={bootstrapQuery.data ?? null}
        companyRole={companyRole}
        companySlug={companySlug}
        currentUserId={session?.user.id ?? null}
      />
    </RoleContext.Provider>
  )
}

/**
 * Parse the route into the two fields the probe carries on `path`.
 *
 *   /projects/abc123/...  -> { projectId: 'abc123', currentTab: 'projects' }
 *   /estimates            -> { projectId: null,    currentTab: 'estimates' }
 *   /                     -> { projectId: null,    currentTab: null }
 *
 * The probe doesn't need a full route schema — it only needs enough
 * coordinates for the capture-modal to label the captured tab. Keep this
 * intentionally lossy.
 */
function parseProbeRoute(pathname: string): { projectId: string | null; currentTab: string | null } {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return { projectId: null, currentTab: null }
  const [first, second] = segments
  const currentTab = first ?? null
  const projectId = first === 'projects' && second ? second : null
  return { projectId, currentTab }
}

function persistActiveCompanySlug(slug: string): void {
  setActiveCompanySlug(slug)
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, slug)
  } catch {
    // localStorage is best-effort only; module state still keeps this render coherent.
  }
}

function needsOnboarding(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 404 &&
    error.body !== null &&
    typeof error.body === 'object' &&
    'error' in error.body &&
    typeof (error.body as { error: unknown }).error === 'string' &&
    /company slug.*not found|requires_onboarding/i.test((error.body as { error: string }).error)
  )
}

/**
 * True when the viewport is desktop-width (>=1024px). Drives the Desktop v2
 * gate. SSR-safe (returns false until mounted) and tracks live resizes.
 */
function useIsDesktop(): boolean {
  const query = '(min-width: 1024px)'
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    setIsDesktop(mql.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return isDesktop
}

function WorkspaceLoadError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return <div className="p-4 text-[12px] text-bad">Failed to load workspace: {message}</div>
}
