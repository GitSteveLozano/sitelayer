/**
 * Unified responsive app shell (Phase D).
 *
 * Before Phase D the app mounted TWO parallel shells behind TWO route roots:
 *   - `/desktop/*` → DesktopWorkspace (sidebar + ⌘K command center)
 *   - `/*`         → MobileShell      (bottom-tab field surface)
 * with a forced `/` → `/desktop` redirect picking between them by a JS viewport
 * gate (the former `useIsDesktop()` in routes/workspace.tsx).
 *
 * This component folds both into ONE shell that resolves the caller's company +
 * persona ONCE and renders ONE route tree. The `desktop` section renders the
 * command-center chrome (sidebar/topbar/⌘K) around its route table; everything
 * else is the field section (MobileShell's bottom-tab chrome). Both sections are
 * driven by this single mount — there is no longer a separate workspace router,
 * a separate desktop route, or a separate `/m` alias mount.
 *
 * Rounds 1-3 already made the screens themselves responsive (they adapt by
 * `useIsDesktop()`/`lg:`), so the command-center routes and the field routes
 * largely render the same components — this step unifies the routing/shell layer
 * on top of them.
 *
 * The command-center keeps its `/desktop` URL prefix (the canonical section
 * selector — ~110 internal links + the DSidebar nav target it). What Phase D
 * removes is the FORCED `/` → `/desktop` redirect: `/` now serves the unified
 * tree directly, and owners/foremen on a desktop viewport get persona-aware
 * landing (their command-center home) instead of an unconditional bounce.
 *
 * The two heavy sections stay lazy so each keeps its own chunk (the field bundle
 * never weighs the command-center owner/estimator code and vice versa) — the
 * same code-split the pre-Phase-D `/desktop/*` vs `/*` lazy routes had.
 */
import { lazy, Suspense, useEffect, useMemo } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ColdStartSplash } from '@/components/shell/ColdStartSplash'
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
import { membershipRoleToPersona, type Role } from '@/lib/role'
import { useIsDesktop } from '@/lib/use-is-desktop'

const CommandCenterSection = lazy(() =>
  import('@/screens/desktop/desktop-workspace').then((m) => ({ default: m.DesktopWorkspace })),
)
const FieldSection = lazy(() => import('@/screens/field-surface'))

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
 * Authenticated app entry. Resolves the caller's memberships first (a real
 * multi-company app can't assume a single tenant), then hands the active
 * company to the resolved shell.
 */
export default function AppShell() {
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
  if (!activeCompany) return <OnboardingRedirect />

  return <CompanyShell activeCompany={activeCompany} />
}

function CompanyShell({ activeCompany }: { activeCompany: ActiveCompany }) {
  const companySlug = activeCompany.slug
  const location = useLocation()
  const isDesktop = useIsDesktop()

  const bootstrapQuery = useQuery({
    queryKey: queryKeys.bootstrap(companySlug),
    queryFn: () => request<BootstrapResponse>('/api/bootstrap', { companySlug }),
  })

  const sessionQuery = useQuery({
    queryKey: queryKeys.session(companySlug),
    queryFn: () => request<SessionResponse>('/api/session', { companySlug }),
  })

  const error = bootstrapQuery.error ?? sessionQuery.error
  if (needsOnboarding(error)) return <OnboardingRedirect />
  if (error) return <WorkspaceLoadError error={error} />

  const session = sessionQuery.data ?? null
  const sessionRole =
    session?.memberships?.find((membership) => membership.slug === companySlug)?.role ??
    activeCompany.role ??
    session?.user?.role ??
    null
  const companyRole = normalizeMobileShellRole(sessionRole)
  const persona: Role =
    companyRole === 'admin' || companyRole === 'office' ? 'owner' : membershipRoleToPersona(companyRole)

  if (bootstrapQuery.isPending || sessionQuery.isPending) return <ColdStartSplash />

  // Persona-aware default landing (replaces the former forced `/` → `/desktop`
  // redirect). Owners + foremen on a desktop viewport land on the command-
  // center home; we route them there as a one-time bounce off the bare root so
  // the canonical `/desktop` section URL + the DSidebar nav stay coherent.
  // Crucially this is scoped to `location.pathname === '/'` ONLY — every deep
  // route (`/projects/:id`, `/foreman/blocker/:id`, …) renders in-place for all
  // personas/viewports, so direct links + the e2e nav keep resolving. Workers
  // and any narrow viewport stay on the field tree (the jobsite surface is
  // phone-first by design).
  if (isDesktop && location.pathname === '/') {
    if (persona === 'owner') return <Navigate to="/desktop" replace />
    if (persona === 'foreman') return <Navigate to="/desktop/fm/today" replace />
  }

  const bootstrap = bootstrapQuery.data ?? null
  const currentUserId = session?.user.id ?? null

  return (
    <Suspense fallback={<ColdStartSplash />}>
      <Routes>
        {/* Command-center section (owner/estimator/foreman command center). The
            section renders the sidebar/topbar/⌘K chrome and its own route table;
            it installs its own RoleContext + probe + feedback dock internally. */}
        <Route path="desktop/*" element={<CommandCenterSection bootstrap={bootstrap} />} />
        {/* Field / mobile section — bottom-tab chrome. Owns its own nested route
            table (the union's field half) and the role-mode/company switchers;
            it renders the right persona tabs from the live pathname. */}
        <Route
          path="*"
          element={
            <FieldSection
              bootstrap={bootstrap}
              companyRole={companyRole}
              companySlug={companySlug}
              currentUserId={currentUserId}
              persona={persona}
              sessionRole={sessionRole}
            />
          }
        />
      </Routes>
    </Suspense>
  )
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

/**
 * First-run / no-company redirect → the DESIGNED onboarding flows
 * (design-fidelity audit M01/D16). Desktop viewports get the account-setup
 * wizard at /welcome (dsg__68-72); everything else gets the mobile owner
 * flow at /owner/onboarding (msg__01-03). The legacy 3-step Tailwind wizard
 * (screens/onboarding/wizard.tsx) is retired — /onboarding itself now
 * forwards here-equivalently (routes/onboarding.tsx).
 */
function OnboardingRedirect() {
  const isDesktop = useIsDesktop()
  return <Navigate to={isDesktop ? '/welcome' : '/owner/onboarding'} replace />
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

function WorkspaceLoadError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return <div className="p-4 text-[12px] text-bad">Failed to load workspace: {message}</div>
}
