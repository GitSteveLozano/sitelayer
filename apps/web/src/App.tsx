import { lazy, Suspense, useCallback, useEffect, useState, type ComponentProps } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { SignedIn, SignedOut, SignIn, SignUp, UserButton, useAuth, useUser } from '@clerk/clerk-react'
import {
  apiGet,
  DEFAULT_COMPANY_SLUG,
  FIXTURES_ENABLED,
  getStoredCompanySlug,
  registerClerkTokenProvider,
  setStoredCompanySlug,
} from './api.js'
import type { FeaturesResponse, ScheduleRow, SessionResponse } from './api.js'
import { CompanySwitcher } from './components/company-switcher.js'
import { EnvironmentRibbon } from './components/environment-ribbon.js'
import { SyncStatusBadge } from './components/sync-status-badge.js'
import { useBootstrapRefresh } from './machines/bootstrap-refresh.js'
import { useDayConfirmed } from './machines/day-confirmed.js'
import { useOfflineReplay } from './machines/offline-replay.js'
import { useProjectSelection } from './machines/project-selection.js'
import { Button } from './components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './components/ui/dialog.js'
import { Input } from './components/ui/input.js'
import { Toaster, toastError, toastSuccess } from './components/ui/toast.js'

const loadAuditView = () => import('./views/audit.js')
const loadBonusSimView = () => import('./views/bonus-sim.js')
const loadClockView = () => import('./views/clock.js')
const loadConfirmView = () => import('./views/confirm.js')
const loadEstimatesView = () => import('./views/estimates.js')
const loadIntegrationsView = () => import('./views/integrations.js')
const loadOnboardingView = () => import('./views/onboarding.js')
const loadProjectsView = () => import('./views/projects.js')
const loadRentalsView = () => import('./views/rentals.js')
const loadScheduleView = () => import('./views/schedule.js')
const loadTakeoffsView = () => import('./views/takeoffs.js')

const AuditView = lazy(() => loadAuditView().then(({ AuditView }) => ({ default: AuditView })))
const BonusSimView = lazy(() => loadBonusSimView().then(({ BonusSimView }) => ({ default: BonusSimView })))
const ClockView = lazy(() => loadClockView().then(({ ClockView }) => ({ default: ClockView })))
const ConfirmView = lazy(() => loadConfirmView().then(({ ConfirmView }) => ({ default: ConfirmView })))
const EstimatesView = lazy(() => loadEstimatesView().then(({ EstimatesView }) => ({ default: EstimatesView })))
const IntegrationsView = lazy(() =>
  loadIntegrationsView().then(({ IntegrationsView }) => ({ default: IntegrationsView })),
)
const OnboardingView = lazy(() => loadOnboardingView().then(({ OnboardingView }) => ({ default: OnboardingView })))
const ProjectsView = lazy(() => loadProjectsView().then(({ ProjectsView }) => ({ default: ProjectsView })))
const RentalsView = lazy(() => loadRentalsView().then(({ RentalsView }) => ({ default: RentalsView })))
const ScheduleView = lazy(() => loadScheduleView().then(({ ScheduleView }) => ({ default: ScheduleView })))
const TakeoffsView = lazy(() => loadTakeoffsView().then(({ TakeoffsView }) => ({ default: TakeoffsView })))

const ROUTE_PRELOADS: Record<string, () => Promise<unknown>> = {
  '/audit': loadAuditView,
  '/bonus-sim': loadBonusSimView,
  '/clock': loadClockView,
  '/confirm': loadConfirmView,
  '/estimates': loadEstimatesView,
  '/integrations': loadIntegrationsView,
  '/onboarding': loadOnboardingView,
  '/projects': loadProjectsView,
  '/rentals': loadRentalsView,
  '/schedule': loadScheduleView,
  '/takeoffs': loadTakeoffsView,
}

const SentryRoutes = Routes

function preloadRoute(path: string) {
  const routeKey = path.startsWith('/takeoffs') ? '/takeoffs' : path
  void ROUTE_PRELOADS[routeKey]?.()
}

// Bridge Clerk's getToken into the api module's global token provider.
// Mounted inside <SignedIn>; on sign-out the provider keeps returning whatever
// Clerk's getToken does (null until a new session). Registering a single function
// reference keeps re-renders cheap.
function ClerkTokenBridge() {
  const { getToken } = useAuth()
  useEffect(() => {
    registerClerkTokenProvider(() => getToken())
    return () => {
      registerClerkTokenProvider(async () => null)
    }
  }, [getToken])
  return null
}

// Wrapper used by the Clerk-authenticated app shell to surface the public
// metadata role to the audit view without forcing every route to depend on
// useUser(). Never rendered in fixtures mode, so the hook call is always safe.
function ClerkAuditRoute({ companySlug, session }: { companySlug: string; session: SessionResponse | null }) {
  const { user } = useUser()
  const raw = user?.publicMetadata?.role
  const publicMetadataRole = typeof raw === 'string' ? raw : null
  return <AuditView companySlug={companySlug} session={session} publicMetadataRole={publicMetadataRole} />
}

function RouteFallback() {
  return (
    <section className="panel routeFallback" aria-busy="true">
      <p className="muted">Loading...</p>
    </section>
  )
}

export function App() {
  // Fixtures mode (e2e + storybook-like preview) renders the app without Clerk
  // auth gating so tests can deterministically reach every route without a
  // session. The api module short-circuits real HTTP in fixtures mode too.
  if (FIXTURES_ENABLED) {
    return (
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    )
  }
  return (
    <BrowserRouter>
      <SignedOut>
        <UnauthShell />
      </SignedOut>
      <SignedIn>
        <ClerkTokenBridge />
        <AppShell />
      </SignedIn>
    </BrowserRouter>
  )
}

function UnauthShell() {
  // Best-effort tier ribbon for unsigned users — does not require a token.
  const [features, setFeatures] = useState<FeaturesResponse | null>(null)
  useEffect(() => {
    let cancelled = false
    apiGet<FeaturesResponse>('/api/features', DEFAULT_COMPANY_SLUG)
      .then((data) => {
        if (!cancelled) setFeatures(data)
      })
      .catch(() => {
        /* ribbon is best-effort */
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main className="shell">
      <EnvironmentRibbon features={features} />
      <Toaster />
      <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
        <SentryRoutes>
          <Route path="/sign-in/*" element={<SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />} />
          <Route path="/sign-up/*" element={<SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />} />
          <Route path="*" element={<Navigate to="/sign-in" replace />} />
        </SentryRoutes>
      </div>
    </main>
  )
}

function AppShell() {
  const [companySlug, setCompanySlug] = useState(() => getStoredCompanySlug() || DEFAULT_COMPANY_SLUG)
  // The bootstrap-refresh XState machine owns the company-level fan-out
  // (session/bootstrap/companies/syncStatus/qboConnection) and the
  // single error banner. See machines/bootstrap-refresh.ts.
  const {
    bootstrap,
    session,
    companies,
    syncStatus,
    qboConnection,
    error,
    refreshKey: syncRefreshKey,
    refresh: triggerRefresh,
    setActionError,
    clearError,
  } = useBootstrapRefresh(companySlug)
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  // The project-selection XState machine owns the per-project fan-out
  // (summary, blueprints, measurements, materialBills, schedules,
  // selectedBlueprintId). See machines/project-selection.ts.
  const {
    summary,
    blueprints,
    measurements,
    materialBills,
    schedules,
    selectedBlueprintId,
    refresh: refreshProject,
    setSelectedBlueprintId,
    error: projectError,
  } = useProjectSelection(companySlug, selectedProjectId)
  const [busy, setBusy] = useState<string | null>(null)
  // Offline-replay XState machine owns the offline queue depth, replay loop,
  // and online event listener. See machines/offline-replay.ts.
  const { offlineQueue } = useOfflineReplay(companySlug)
  const [features, setFeatures] = useState<FeaturesResponse | null>(null)
  // Today's confirm state is owned by useDayConfirmed — reads localStorage,
  // refreshes on the `sitelayer:day-confirmed` window event.
  const confirmDoneToday = useDayConfirmed()

  useEffect(() => {
    let cancelled = false
    apiGet<FeaturesResponse>('/api/features', companySlug)
      .then((data) => {
        if (!cancelled) setFeatures(data)
      })
      .catch(() => {
        /* ribbon is best-effort; don't block app */
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  useEffect(() => {
    setStoredCompanySlug(companySlug)
  }, [companySlug])

  // The bootstrap fan-out + error handling is owned by useBootstrapRefresh.
  // We just need to clear the local project + summary selection on company
  // change so we don't render stale picks against the new tenant's data.
  const refresh = useCallback(async () => {
    triggerRefresh()
  }, [triggerRefresh])

  useEffect(() => {
    setSelectedProjectId('')
    // Project-selection machine resets summary/blueprints/measurements/etc.
    // automatically on COMPANY_CHANGED.
  }, [companySlug])

  // Auto-pick the first project when bootstrap data arrives and nothing is
  // selected (matches the legacy behaviour after refresh()).
  useEffect(() => {
    if (!bootstrap) return
    setSelectedProjectId((current) => current || bootstrap.projects[0]?.id || '')
  }, [bootstrap])

  // Offline replay loop, the `online` listener, the
  // `sitelayer:offline-queue` event handler, and the 15s timer are all owned
  // by useOfflineReplay (see machines/offline-replay.ts).

  // Surface project-fetch errors into the same banner as bootstrap errors.
  useEffect(() => {
    if (projectError) setActionError(projectError)
  }, [projectError, setActionError])

  // refreshSummary / refreshTakeoff used to be useCallbacks driving the
  // per-project fan-out. The project-selection machine owns that now;
  // these wrappers preserve the call shape for legacy view-prop wiring
  // until the views are updated to read state directly.
  const refreshSummary = useCallback(
    async (_projectId: string) => {
      refreshProject()
    },
    [refreshProject],
  )
  const refreshTakeoff = useCallback(
    async (_projectId: string) => {
      refreshProject()
    },
    [refreshProject],
  )

  // Fetch bootstrap data across all visible schedules so /confirm can
  // aggregate today's schedules without needing a project to be selected.
  const [allSchedules, setAllSchedules] = useState<ScheduleRow[]>([])
  useEffect(() => {
    setAllSchedules((bootstrap?.schedules ?? []) as ScheduleRow[])
  }, [bootstrap?.schedules])

  async function runAction(label: string, action: () => Promise<void>, options?: { skipRefresh?: boolean }) {
    try {
      setBusy(label)
      clearError()
      await action()
      if (!options?.skipRefresh) {
        await refresh()
        if (selectedProjectId) {
          await refreshSummary(selectedProjectId)
        }
      }
      // Surface lightweight success toasts for user-visible high-signal actions.
      // Other labels are mutation-internal and would be noisy.
      if (label === 'create-company') toastSuccess('Company created')
      if (label === 'invite-member') toastSuccess('Invitation sent')
      if (label === 'qbo-sync') toastSuccess('QBO sync triggered')
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : 'unknown error'
      setActionError(message)
      toastError(`${label} failed`, message)
    } finally {
      setBusy(null)
    }
  }

  const divisions = bootstrap?.divisions ?? []
  const serviceItems = bootstrap?.serviceItems ?? []
  const customers = bootstrap?.customers ?? []
  const workers = bootstrap?.workers ?? []
  const pricingProfiles = bootstrap?.pricingProfiles ?? []
  const bonusRules = bootstrap?.bonusRules ?? []
  const integrationMappings = bootstrap?.integrationMappings ?? []
  const mappedCustomerRefs = new Set(
    integrationMappings
      .filter((mapping) => mapping.entity_type === 'customer' && mapping.deleted_at === null)
      .map((mapping) => mapping.local_ref),
  )
  const mappedServiceItemRefs = new Set(
    integrationMappings
      .filter((mapping) => mapping.entity_type === 'service_item' && mapping.deleted_at === null)
      .map((mapping) => mapping.local_ref),
  )
  const mappedDivisionRefs = new Set(
    integrationMappings
      .filter((mapping) => mapping.entity_type === 'division' && mapping.deleted_at === null)
      .map((mapping) => mapping.local_ref),
  )
  const mappedProjectRefs = new Set(
    integrationMappings
      .filter((mapping) => mapping.entity_type === 'project' && mapping.deleted_at === null)
      .map((mapping) => mapping.local_ref),
  )
  const suggestedCustomerMappings = customers.filter(
    (customer) => customer.external_id && !mappedCustomerRefs.has(customer.id),
  )
  const suggestedServiceItemMappings = serviceItems.filter(
    (item) => (item.source === 'qbo' || item.code.startsWith('qbo-')) && !mappedServiceItemRefs.has(item.code),
  )
  const suggestedDivisionMappings = divisions.filter((division) => !mappedDivisionRefs.has(division.code))
  const suggestedProjectMappings = bootstrap?.projects.filter((project) => !mappedProjectRefs.has(project.id)) ?? []

  const primaryDivision = divisions.find((division) => division.code === 'D4')?.code ?? divisions[0]?.code ?? 'D4'
  const measurableServiceItems = serviceItems.filter((item) => item.category === 'measurable')
  const devSurfaceEnabled = features?.tier !== 'prod'
  // Audit nav gate. Fixtures keep it visible so the e2e harness can hit the
  // route; otherwise require an admin/owner session role.
  const sessionRole = session?.user.role
  const auditNavVisible = FIXTURES_ENABLED || sessionRole === 'admin' || sessionRole === 'owner'
  // Rentals is admin/office only. Same fixture bypass so /rentals renders
  // deterministically in the e2e suite.
  const rentalsNavVisible =
    FIXTURES_ENABLED || sessionRole === 'admin' || sessionRole === 'office' || sessionRole === 'owner'
  // Bonus sim is an admin/office tool — same gating as audit.
  const bonusSimNavVisible = FIXTURES_ENABLED || sessionRole === 'admin' || sessionRole === 'owner'

  return (
    <main className="shell">
      <EnvironmentRibbon features={features} />
      <Toaster />
      <div
        className="appHeader"
        style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, padding: '8px 16px' }}
      >
        <CompanySwitcher
          companies={companies}
          activeSlug={companySlug}
          onSelect={(slug) => setCompanySlug(slug)}
          onCreated={() => void refresh()}
        />
        {FIXTURES_ENABLED ? null : <UserButton afterSignOutUrl="/sign-in" />}
      </div>
      <MobileNav
        selectedProjectId={selectedProjectId}
        confirmDoneToday={confirmDoneToday}
        auditNavVisible={auditNavVisible}
        rentalsNavVisible={rentalsNavVisible}
        bonusSimNavVisible={bonusSimNavVisible}
        devSurfaceEnabled={devSurfaceEnabled}
      />
      <Suspense fallback={<RouteFallback />}>
        <SentryRoutes>
          <Route path="/" element={<Navigate to="/confirm" replace />} />
          <Route
            path="/confirm"
            element={
              <ConfirmView
                bootstrap={bootstrap}
                schedules={allSchedules}
                workers={workers}
                serviceItems={serviceItems}
                companySlug={companySlug}
                onConfirmed={async () => {
                  await refresh()
                }}
              />
            }
          />
          <Route path="/clock" element={<ClockView bootstrap={bootstrap} companySlug={companySlug} />} />
          <Route
            path="/schedule"
            element={
              <ScheduleView
                bootstrap={bootstrap}
                schedules={allSchedules}
                workers={workers}
                serviceItems={serviceItems}
                companySlug={companySlug}
                onMutated={async () => {
                  await refresh()
                }}
              />
            }
          />
          <Route
            path="/projects"
            element={
              <ProjectsView
                bootstrap={bootstrap}
                session={session}
                companies={companies}
                companySlug={companySlug}
                busy={busy}
                error={error}
                customers={customers}
                workers={workers}
                serviceItems={serviceItems}
                divisions={divisions}
                pricingProfiles={pricingProfiles}
                bonusRules={bonusRules}
                primaryDivision={primaryDivision}
                setCompanySlug={setCompanySlug}
                runAction={runAction}
              />
            }
          />
          <Route
            path="/takeoffs"
            element={
              <RoutedTakeoffsView
                bootstrap={bootstrap}
                selectedProjectId={selectedProjectId}
                selectedBlueprintId={selectedBlueprintId}
                companySlug={companySlug}
                busy={busy}
                blueprints={blueprints}
                measurements={measurements}
                schedules={schedules}
                materialBills={materialBills}
                workers={workers}
                measurableServiceItems={measurableServiceItems}
                summary={summary}
                setSelectedProjectId={setSelectedProjectId}
                setSelectedBlueprintId={setSelectedBlueprintId}
                refreshTakeoff={refreshTakeoff}
                runAction={runAction}
              />
            }
          />
          <Route
            path="/takeoffs/:projectId"
            element={
              <RoutedTakeoffsView
                bootstrap={bootstrap}
                selectedProjectId={selectedProjectId}
                selectedBlueprintId={selectedBlueprintId}
                companySlug={companySlug}
                busy={busy}
                blueprints={blueprints}
                measurements={measurements}
                schedules={schedules}
                materialBills={materialBills}
                workers={workers}
                measurableServiceItems={measurableServiceItems}
                summary={summary}
                setSelectedProjectId={setSelectedProjectId}
                setSelectedBlueprintId={setSelectedBlueprintId}
                refreshTakeoff={refreshTakeoff}
                runAction={runAction}
              />
            }
          />
          <Route
            path="/estimates"
            element={
              <EstimatesView
                bootstrap={bootstrap}
                summary={summary}
                selectedProjectId={selectedProjectId}
                companySlug={companySlug}
                busy={busy}
                divisions={divisions}
                measurableServiceItems={measurableServiceItems}
                setSelectedProjectId={setSelectedProjectId}
                refresh={refresh}
                refreshSummary={refreshSummary}
                runAction={runAction}
              />
            }
          />
          <Route
            path="/integrations"
            element={
              <IntegrationsView
                companySlug={companySlug}
                busy={busy}
                qboConnection={qboConnection}
                syncStatus={syncStatus}
                integrationMappings={integrationMappings}
                suggestedCustomerMappings={suggestedCustomerMappings}
                suggestedServiceItemMappings={suggestedServiceItemMappings}
                suggestedDivisionMappings={suggestedDivisionMappings}
                suggestedProjectMappings={suggestedProjectMappings}
                selectedProjectId={selectedProjectId}
                offlineQueue={offlineQueue}
                syncRefreshKey={syncRefreshKey}
                refresh={refresh}
                refreshSummary={refreshSummary}
                runAction={runAction}
              />
            }
          />
          <Route
            path="/onboarding"
            element={
              <OnboardingView
                bootstrap={bootstrap}
                activeCompanySlug={companySlug}
                setCompanySlug={setCompanySlug}
                onCompleted={() => {
                  void refresh()
                }}
              />
            }
          />
          <Route
            path="/bonus-sim"
            element={bonusSimNavVisible ? <BonusSimView bootstrap={bootstrap} /> : <Navigate to="/projects" replace />}
          />
          <Route
            path="/audit"
            element={
              FIXTURES_ENABLED ? (
                <AuditView companySlug={companySlug} session={session} />
              ) : (
                <ClerkAuditRoute companySlug={companySlug} session={session} />
              )
            }
          />
          <Route
            path="/rentals"
            element={
              <RentalsView
                companySlug={companySlug}
                bootstrap={bootstrap}
                session={session}
                customers={customers}
                projects={bootstrap?.projects ?? []}
              />
            }
          />
          <Route
            path="/dev/*"
            element={devSurfaceEnabled ? <DevScratchView features={features} /> : <Navigate to="/projects" replace />}
          />
          {/* If a signed-in user lands on a sign-in URL, bounce them home. */}
          <Route path="/sign-in/*" element={<Navigate to="/confirm" replace />} />
          <Route path="/sign-up/*" element={<Navigate to="/confirm" replace />} />
          <Route path="*" element={<Navigate to="/confirm" replace />} />
        </SentryRoutes>
      </Suspense>
      <SyncStatusBadge syncStatus={syncStatus} offlineQueue={offlineQueue} />
    </main>
  )
}

// MobileNav renders the primary <nav>. On phones ≤479px with more than 4
// visible links, it collapses to a hamburger toggle (mobile.css hides the
// non-active links when data-collapsed="true"). Desktop and tablet viewports
// render the full strip exactly like before.
function MobileNav({
  selectedProjectId,
  confirmDoneToday,
  auditNavVisible,
  rentalsNavVisible,
  bonusSimNavVisible,
  devSurfaceEnabled,
}: {
  selectedProjectId: string
  confirmDoneToday: boolean
  auditNavVisible: boolean
  rentalsNavVisible: boolean
  bonusSimNavVisible: boolean
  devSurfaceEnabled: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [isNarrow, setIsNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.matchMedia('(max-width: 479px)').matches : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const mql = window.matchMedia('(max-width: 479px)')
    const onChange = (event: MediaQueryListEvent) => setIsNarrow(event.matches)
    mql.addEventListener('change', onChange)
    setIsNarrow(mql.matches)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const linkCount =
    6 + // Confirm, Clock, Schedule, Projects, Takeoffs, Estimates
    (rentalsNavVisible ? 1 : 0) +
    1 + // Integrations
    (bonusSimNavVisible ? 1 : 0) +
    (auditNavVisible ? 1 : 0) +
    (devSurfaceEnabled ? 1 : 0)
  const showHamburger = isNarrow && linkCount > 4
  const collapsedAttr = showHamburger && collapsed ? 'true' : 'false'

  return (
    <nav className="appNav" aria-label="Primary" data-collapsed={collapsedAttr}>
      {showHamburger ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mobileNavToggle"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          data-testid="mobile-nav-toggle"
          onClick={() => setCollapsed((current) => !current)}
        >
          ☰
        </Button>
      ) : null}
      <NavLink
        to="/confirm"
        data-testid="nav-confirm"
        onMouseEnter={() => preloadRoute('/confirm')}
        onFocus={() => preloadRoute('/confirm')}
      >
        {confirmDoneToday ? '✓ ' : ''}
        Confirm Day
      </NavLink>
      <NavLink
        to="/clock"
        data-testid="nav-clock"
        onMouseEnter={() => preloadRoute('/clock')}
        onFocus={() => preloadRoute('/clock')}
      >
        Clock
      </NavLink>
      <NavLink
        to="/schedule"
        data-testid="nav-schedule"
        onMouseEnter={() => preloadRoute('/schedule')}
        onFocus={() => preloadRoute('/schedule')}
      >
        Schedule
      </NavLink>
      <NavLink to="/projects" onMouseEnter={() => preloadRoute('/projects')} onFocus={() => preloadRoute('/projects')}>
        Projects
      </NavLink>
      <NavLink
        to={selectedProjectId ? `/takeoffs/${selectedProjectId}` : '/takeoffs'}
        onMouseEnter={() => preloadRoute('/takeoffs')}
        onFocus={() => preloadRoute('/takeoffs')}
      >
        Takeoffs
      </NavLink>
      <NavLink
        to="/estimates"
        onMouseEnter={() => preloadRoute('/estimates')}
        onFocus={() => preloadRoute('/estimates')}
      >
        Estimates
      </NavLink>
      {rentalsNavVisible ? (
        <NavLink to="/rentals" onMouseEnter={() => preloadRoute('/rentals')} onFocus={() => preloadRoute('/rentals')}>
          Rentals
        </NavLink>
      ) : null}
      <NavLink
        to="/integrations"
        onMouseEnter={() => preloadRoute('/integrations')}
        onFocus={() => preloadRoute('/integrations')}
      >
        Integrations
      </NavLink>
      {bonusSimNavVisible ? (
        <NavLink
          to="/bonus-sim"
          onMouseEnter={() => preloadRoute('/bonus-sim')}
          onFocus={() => preloadRoute('/bonus-sim')}
        >
          Bonus Sim
        </NavLink>
      ) : null}
      {auditNavVisible ? (
        <NavLink to="/audit" onMouseEnter={() => preloadRoute('/audit')} onFocus={() => preloadRoute('/audit')}>
          Audit
        </NavLink>
      ) : null}
      {devSurfaceEnabled ? <NavLink to="/dev/scratch">Dev</NavLink> : null}
    </nav>
  )
}

function RoutedTakeoffsView(props: ComponentProps<typeof TakeoffsView>) {
  const { projectId } = useParams()
  const navigate = useNavigate()

  useEffect(() => {
    if (projectId && projectId !== props.selectedProjectId) {
      props.setSelectedProjectId(projectId)
    }
  }, [projectId, props])

  return (
    <TakeoffsView
      {...props}
      setSelectedProjectId={(nextProjectId) => {
        props.setSelectedProjectId(nextProjectId)
        navigate(nextProjectId ? `/takeoffs/${nextProjectId}` : '/takeoffs')
      }}
    />
  )
}

function DevScratchUserId() {
  const { user } = useUser()
  return <>{user?.id ?? 'unknown'}</>
}

function DevScratchView({ features }: { features: FeaturesResponse | null }) {
  return (
    <section className="panel">
      <h2>Dev Scratch</h2>
      <div className="grid">
        <article className="devPane">
          <h3>Runtime</h3>
          <dl className="kv compactKv">
            <div>
              <dt>Tier</dt>
              <dd>{features?.tier ?? 'loading'}</dd>
            </div>
            <div>
              <dt>Flags</dt>
              <dd>{features?.flags.join(', ') || 'none'}</dd>
            </div>
            <div>
              <dt>Clerk user</dt>
              <dd>{FIXTURES_ENABLED ? 'fixture-user' : <DevScratchUserId />}</dd>
            </div>
          </dl>
        </article>
        <article className="devPane">
          <h3>Workbench</h3>
          <div className="devDropZone">
            <Dialog>
              <DialogTrigger asChild>
                <Button type="button" variant="secondary">
                  Primitive Check
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Dev Surface</DialogTitle>
                  <DialogDescription className="sr-only">
                    Tailwind and shadcn primitives are available in this route.
                  </DialogDescription>
                </DialogHeader>
                <Input aria-label="Current app tier" readOnly value={features?.tier ?? 'loading'} />
              </DialogContent>
            </Dialog>
          </div>
        </article>
      </div>
    </section>
  )
}
