import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { SignedIn, SignedOut, SignIn, SignUp, UserButton, useAuth, useUser } from '@clerk/clerk-react'
import { Sentry } from './instrument.js'
import {
  apiGet,
  DEFAULT_COMPANY_SLUG,
  FIXTURES_ENABLED,
  getStoredCompanySlug,
  readOfflineQueue,
  registerClerkTokenProvider,
  replayOfflineMutations,
  setStoredCompanySlug,
} from './api.js'
import type {
  BlueprintRow,
  BootstrapResponse,
  CompaniesResponse,
  FeaturesResponse,
  MaterialBillRow,
  MeasurementRow,
  OfflineMutation,
  ProjectSummary,
  QboConnectionResponse,
  ScheduleRow,
  SessionResponse,
  SyncStatusResponse,
} from './api.js'
import { CompanySwitcher } from './components/company-switcher.js'
import { EnvironmentRibbon } from './components/environment-ribbon.js'
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
import { Toaster, toastError, toastInfo, toastSuccess } from './components/ui/toast.js'
import { AuditView } from './views/audit.js'
import { ConfirmView } from './views/confirm.js'
import { EstimatesView } from './views/estimates.js'
import { IntegrationsView } from './views/integrations.js'
import { OnboardingView } from './views/onboarding.js'
import { ProjectsView } from './views/projects.js'
import { TakeoffsView } from './views/takeoffs.js'

const SentryRoutes = Sentry.withSentryReactRouterV7Routing(Routes)

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
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null)
  const [summary, setSummary] = useState<ProjectSummary | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [selectedBlueprintId, setSelectedBlueprintId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [companySlug, setCompanySlug] = useState(() => getStoredCompanySlug() || DEFAULT_COMPANY_SLUG)
  const [blueprints, setBlueprints] = useState<BlueprintRow[]>([])
  const [measurements, setMeasurements] = useState<MeasurementRow[]>([])
  const [schedules, setSchedules] = useState<ScheduleRow[]>([])
  const [materialBills, setMaterialBills] = useState<MaterialBillRow[]>([])
  const [session, setSession] = useState<SessionResponse | null>(null)
  const [companies, setCompanies] = useState<CompaniesResponse['companies']>([])
  const [syncStatus, setSyncStatus] = useState<SyncStatusResponse | null>(null)
  const [qboConnection, setQboConnection] = useState<QboConnectionResponse['connection'] | null>(null)
  const [offlineQueue, setOfflineQueue] = useState<OfflineMutation[]>([])
  const [syncRefreshKey, setSyncRefreshKey] = useState(0)
  const [features, setFeatures] = useState<FeaturesResponse | null>(null)
  const [confirmDoneToday, setConfirmDoneToday] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      const today = new Date().toISOString().slice(0, 10)
      return window.localStorage.getItem('sitelayer.lastConfirmedDay') === today
    } catch {
      return false
    }
  })

  useEffect(() => {
    function refreshConfirmState() {
      if (typeof window === 'undefined') return
      try {
        const today = new Date().toISOString().slice(0, 10)
        setConfirmDoneToday(window.localStorage.getItem('sitelayer.lastConfirmedDay') === today)
      } catch {
        setConfirmDoneToday(false)
      }
    }
    refreshConfirmState()
    const handler = () => refreshConfirmState()
    window.addEventListener('sitelayer:day-confirmed', handler)
    return () => window.removeEventListener('sitelayer:day-confirmed', handler)
  }, [])

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

  const refresh = useCallback(async () => {
    const [sessionData, data] = await Promise.all([
      apiGet<SessionResponse>('/api/session', companySlug),
      apiGet<BootstrapResponse>('/api/bootstrap', companySlug),
    ])
    setSession(sessionData)
    try {
      const companyData = await apiGet<CompaniesResponse>('/api/companies', companySlug)
      setCompanies(companyData.companies)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    }
    setBootstrap(data)
    setSelectedProjectId((current) => current || data.projects[0]?.id || '')
    try {
      const status = await apiGet<SyncStatusResponse>('/api/sync/status', companySlug)
      setSyncStatus(status)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    }
    try {
      const qbo = await apiGet<QboConnectionResponse>('/api/integrations/qbo', companySlug)
      setQboConnection(qbo.connection)
      setSyncStatus(qbo.status)
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    }
    setOfflineQueue(await readOfflineQueue())
    setSyncRefreshKey((current) => current + 1)
  }, [companySlug])

  useEffect(() => {
    setSelectedProjectId('')
    setSummary(null)
    void refresh()
      .then(() => setError(null))
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : 'unknown error')
      })
  }, [refresh])

  useEffect(() => {
    let active = true
    let previousDepth = 0
    const refreshQueueState = () => {
      void readOfflineQueue().then((queue) => {
        if (!active) return
        // When depth drops, emit an info toast so crews know offline edits synced.
        if (previousDepth > 0 && queue.length < previousDepth) {
          const synced = previousDepth - queue.length
          toastInfo(
            `${synced} offline change${synced === 1 ? '' : 's'} synced`,
            queue.length > 0 ? `${queue.length} pending` : undefined,
          )
        }
        previousDepth = queue.length
        setOfflineQueue(queue)
      })
    }
    const replay = () => {
      replayOfflineMutations(companySlug)
        .then(refreshQueueState)
        .catch((caught: unknown) => {
          refreshQueueState()
          toastError('Offline sync failed', caught instanceof Error ? caught.message : 'Will retry automatically')
        })
    }

    replay()
    window.addEventListener('online', replay)
    window.addEventListener('sitelayer:offline-queue', refreshQueueState as EventListener)
    const timer = window.setInterval(replay, 15000)
    return () => {
      active = false
      window.removeEventListener('online', replay)
      window.removeEventListener('sitelayer:offline-queue', refreshQueueState as EventListener)
      window.clearInterval(timer)
    }
  }, [companySlug])

  const refreshSummary = useCallback(
    async (projectId: string) => {
      if (!projectId) {
        setSummary(null)
        return
      }
      const data = await apiGet<ProjectSummary>(`/api/projects/${projectId}/summary`, companySlug)
      setSummary(data)
    },
    [companySlug],
  )

  const refreshTakeoff = useCallback(
    async (projectId: string) => {
      if (!projectId) {
        setBlueprints([])
        setMeasurements([])
        setSchedules([])
        setMaterialBills([])
        setSelectedBlueprintId('')
        return
      }
      const [blueprintData, measurementData, billData] = await Promise.all([
        apiGet<{ blueprints: BlueprintRow[] }>(`/api/projects/${projectId}/blueprints`, companySlug),
        apiGet<{ measurements: MeasurementRow[] }>(`/api/projects/${projectId}/takeoff/measurements`, companySlug),
        apiGet<{ materialBills: MaterialBillRow[] }>(`/api/projects/${projectId}/material-bills`, companySlug),
      ])
      setBlueprints(blueprintData.blueprints)
      setMeasurements(measurementData.measurements)
      setMaterialBills(billData.materialBills)
      setSelectedBlueprintId((current) =>
        current && blueprintData.blueprints.some((blueprint) => blueprint.id === current)
          ? current
          : (blueprintData.blueprints[0]?.id ?? ''),
      )
      const scheduleData = await apiGet<{ schedules: ScheduleRow[] }>(
        `/api/projects/${projectId}/schedules`,
        companySlug,
      )
      setSchedules(scheduleData.schedules)
    },
    [companySlug],
  )

  useEffect(() => {
    void refreshSummary(selectedProjectId).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    })
    void refreshTakeoff(selectedProjectId).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : 'unknown error')
    })
  }, [refreshSummary, refreshTakeoff, selectedProjectId])

  // Fetch bootstrap data across all visible schedules so /confirm can
  // aggregate today's schedules without needing a project to be selected.
  const [allSchedules, setAllSchedules] = useState<ScheduleRow[]>([])
  useEffect(() => {
    setAllSchedules((bootstrap?.schedules ?? []) as ScheduleRow[])
  }, [bootstrap?.schedules])

  async function runAction(label: string, action: () => Promise<void>, options?: { skipRefresh?: boolean }) {
    try {
      setBusy(label)
      setError(null)
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
      setError(message)
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
      <nav className="appNav" aria-label="Primary">
        <NavLink to="/confirm" data-testid="nav-confirm">
          {confirmDoneToday ? '✓ ' : ''}
          Confirm Day
        </NavLink>
        <NavLink to="/projects">Projects</NavLink>
        <NavLink to={selectedProjectId ? `/takeoffs/${selectedProjectId}` : '/takeoffs'}>Takeoffs</NavLink>
        <NavLink to="/estimates">Estimates</NavLink>
        <NavLink to="/integrations">Integrations</NavLink>
        {auditNavVisible ? <NavLink to="/audit">Audit</NavLink> : null}
        {devSurfaceEnabled ? <NavLink to="/dev/scratch">Dev</NavLink> : null}
      </nav>
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
          path="/dev/*"
          element={devSurfaceEnabled ? <DevScratchView features={features} /> : <Navigate to="/projects" replace />}
        />
        {/* If a signed-in user lands on a sign-in URL, bounce them home. */}
        <Route path="/sign-in/*" element={<Navigate to="/confirm" replace />} />
        <Route path="/sign-up/*" element={<Navigate to="/confirm" replace />} />
        <Route path="*" element={<Navigate to="/confirm" replace />} />
      </SentryRoutes>
    </main>
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
