/**
 * Mobile shell. The single entry point for mobile-first persona screens.
 *
 * This component:
 *   1. Reads the caller's bootstrap (memberships, project assignments).
 *   2. Computes the active context via lib/active-context.ts.
 *   3. Picks the appropriate tab set (admin / foreman / worker).
 *   4. Renders the active tab's screen as nested content.
 *
 * Sub-routes follow `/m/<tab>` and `/m/<tab>/<resource>`. The role-aware
 * shell deliberately hides tabs the active context doesn't surface — a
 * worker never sees Field, a foreman never sees Reports.
 *
 * Implementation note: every per-tab screen is a real, lazy-loaded screen
 * (no remaining placeholders). The canonical app shell is mounted at the
 * App.tsx `/*` route; `/m/*` is retained only as a legacy alias.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import type { CompanyRole } from '@sitelayer/domain'
import {
  availableRoleModes,
  computeActiveContext,
  normalizeRoleMode,
  type ActiveContext,
  type RoleMode,
} from '../lib/active-context.js'
import { MBottomTabs, MChip, MChipRow, MI, MShell } from '../components/m/index.js'
import { CompanySwitcher } from '../components/shell/CompanySwitcher.js'
import { InstallPromptBanner } from '../components/shell/InstallPromptBanner.js'
import { OfflineBanner } from '../components/shell/OfflineBanner.js'
import { PushDeniedBanner } from '../components/shell/PushDeniedBanner.js'
import { UpdateBanner } from '../components/shell/UpdateBanner.js'

// All per-tab screens are lazy. Workers never resolve admin routes (no
// tab linkage, no programmatic navigation), so the projects/estimates/
// schedule chunks never download for them — and vice versa. Each Route's
// element is wrapped under a single <Suspense> below.
//
// Named-export screens use `.then(m => ({ default: m.Name }))` to satisfy
// React.lazy's default-export contract without forcing every screen to
// add a default export.
const MoreRoute = lazy(() => import('../routes/more.js'))
const AdminHome = lazy(() => import('./mobile/admin-home.js').then((m) => ({ default: m.AdminHome })))
const OwnerMoney = lazy(() => import('./mobile/owner-money.js').then((m) => ({ default: m.OwnerMoney })))
const MobileChatList = lazy(() => import('./mobile/chat.js').then((m) => ({ default: m.MobileChatList })))
const MobileProjectsList = lazy(() =>
  import('./mobile/projects-list.js').then((m) => ({ default: m.MobileProjectsList })),
)
const MobileEstimatesSent = lazy(() =>
  import('./mobile/estimates-sent.js').then((m) => ({ default: m.MobileEstimatesSent })),
)
const MobileProjectDetail = lazy(() =>
  import('./mobile/project-detail.js').then((m) => ({ default: m.MobileProjectDetail })),
)
const MobilePostMortem = lazy(() =>
  import('./mobile/project-detail/post-mortem.js').then((m) => ({ default: m.MobilePostMortem })),
)
const MobileProjectNew = lazy(() => import('./mobile/project-new.js').then((m) => ({ default: m.MobileProjectNew })))
const MobileTakeoffList = lazy(() => import('./mobile/takeoff-list.js').then((m) => ({ default: m.MobileTakeoffList })))
// Phase C: the takeoff canvas is now ONE responsive component. The mobile route
// mounts it (it renders the phone body below the 1024px gate); the desktop route
// (`/desktop/canvas/:id`) mounts the same component for the command-center body.
const TakeoffMobileScreen = lazy(() =>
  import('./desktop/est-canvas.js').then((m) => ({ default: m.TakeoffMobileScreen })),
)
const MobileSettingsHome = lazy(() =>
  import('./settings/settings-home.js').then((m) => ({ default: m.MobileSettingsHome })),
)
const ProjectAssignmentsScreen = lazy(() =>
  import('./projects/assignments.js').then((m) => ({ default: m.ProjectAssignmentsScreen })),
)
const RentalLifecycleDetailScreen = lazy(() =>
  import('./rentals/detail.js').then((m) => ({ default: m.RentalLifecycleDetailScreen })),
)
const ShipmentDetailScreen = lazy(() =>
  import('./projects/shipment-detail.js').then((m) => ({ default: m.ShipmentDetailScreen })),
)
const MobileEstimateReview = lazy(() =>
  import('./mobile/estimate-review.js').then((m) => ({ default: m.MobileEstimateReview })),
)
const MobileEstimatePush = lazy(() =>
  import('./mobile/estimate-push.js').then((m) => ({ default: m.MobileEstimatePush })),
)
const MobileSchedule = lazy(() => import('./mobile/schedule.js').then((m) => ({ default: m.MobileSchedule })))
const MobileTimeReview = lazy(() => import('./mobile/time-review.js').then((m) => ({ default: m.MobileTimeReview })))
const MobileForemanTimeEntry = lazy(() =>
  import('./mobile/foreman-time-entry.js').then((m) => ({ default: m.MobileForemanTimeEntry })),
)
const WorkerToday = lazy(() => import('./mobile/worker-today.js').then((m) => ({ default: m.WorkerToday })))
const WorkerClockinConfirm = lazy(() =>
  import('./mobile/worker-clockin.js').then((m) => ({ default: m.WorkerClockinConfirm })),
)
const WorkerScope = lazy(() => import('./mobile/worker-scope.js').then((m) => ({ default: m.WorkerScope })))
const WorkerIssue = lazy(() => import('./mobile/worker-issue.js').then((m) => ({ default: m.WorkerIssue })))
const WorkerHours = lazy(() => import('./mobile/worker-hours.js').then((m) => ({ default: m.WorkerHours })))
const WorkerLog = lazy(() => import('./mobile/worker-log.js').then((m) => ({ default: m.WorkerLog })))
const ForemanToday = lazy(() => import('./mobile/foreman-today.js').then((m) => ({ default: m.ForemanToday })))
const ForemanField = lazy(() => import('./mobile/foreman-field.js').then((m) => ({ default: m.ForemanField })))
const ForemanCrew = lazy(() => import('./mobile/foreman-crew.js').then((m) => ({ default: m.ForemanCrew })))
const ForemanMap = lazy(() => import('./mobile/foreman-map.js').then((m) => ({ default: m.ForemanMap })))
const ForemanBrief = lazy(() => import('./mobile/foreman-brief.js').then((m) => ({ default: m.ForemanBrief })))
const ForemanLog = lazy(() => import('./mobile/foreman-log.js').then((m) => ({ default: m.ForemanLog })))
// The mobile shell IS the field/mobile form factor, so it mounts the mobile
// composition directly — mirroring how desktop-workspace mounts the desktop
// `FmBlockerDetail`. The viewport-switching `ForemanBlockerDetail` wrapper would
// otherwise render desktop chrome inside the mobile shell at >=1024px (and
// break the foreman-field-event e2e, which drives this route in a 1280px
// Chromium viewport).
const ForemanBlockerDetail = lazy(() =>
  import('./mobile/foreman-blocker-detail.js').then((m) => ({ default: m.ForemanBlockerDetailMobile })),
)
const MobileRentals = lazy(() => import('./mobile/rentals.js').then((m) => ({ default: m.MobileRentals })))
const MobileRentalDispatch = lazy(() =>
  import('./mobile/rentals-dispatch.js').then((m) => ({ default: m.MobileRentalDispatch })),
)
const MobileRentalsUtilization = lazy(() =>
  import('./mobile/rentals-utilization.js').then((m) => ({ default: m.MobileRentalsUtilization })),
)
const MobileRentalScan = lazy(() => import('./mobile/rentals-scan.js').then((m) => ({ default: m.MobileRentalScan })))
const MobileRentalsAsset = lazy(() =>
  import('./mobile/rentals-asset.js').then((m) => ({ default: m.MobileRentalsAsset })),
)
const MobileRentalsService = lazy(() =>
  import('./mobile/rentals-service.js').then((m) => ({ default: m.MobileRentalsService })),
)
const MobileScaffoldInspectionScreen = lazy(() =>
  import('./mobile/scaffold-inspection.js').then((m) => ({ default: m.MobileScaffoldInspectionScreen })),
)
const MobileRentalsPortal = lazy(() =>
  import('./mobile/rentals-portal.js').then((m) => ({ default: m.MobileRentalsPortal })),
)
const RentalRequestsQueueScreen = lazy(() =>
  import('./rentals/rental-requests-queue.js').then((m) => ({ default: m.RentalRequestsQueueScreen })),
)
const MobileRentalBillingList = lazy(() =>
  import('./mobile/rentals-billing-list.js').then((m) => ({ default: m.MobileRentalBillingList })),
)
const MobileRentalBillingDetail = lazy(() =>
  import('./mobile/rentals-billing-detail.js').then((m) => ({ default: m.MobileRentalBillingDetail })),
)
const MobileQuickInvoice = lazy(() =>
  import('./mobile/invoice-quick.js').then((m) => ({ default: m.MobileQuickInvoice })),
)
const MobileWorkRequests = lazy(() =>
  import('./mobile/work-requests.js').then((m) => ({ default: m.MobileWorkRequests })),
)
const MobileOps = lazy(() => import('./mobile/ops.js').then((m) => ({ default: m.MobileOps })))
const MobileIssueBoard = lazy(() => import('./mobile/issue-board.js').then((m) => ({ default: m.MobileIssueBoard })))
const MobileAppIssues = lazy(() => import('./mobile/app-issues.js').then((m) => ({ default: m.MobileAppIssuesGate })))
const MobileAppIssueDetail = lazy(() =>
  import('./mobile/app-issue-detail.js').then((m) => ({ default: m.MobileAppIssueDetailGate })),
)
const MobileWorkRequestDetail = lazy(() =>
  import('./mobile/work-request-detail.js').then((m) => ({ default: m.MobileWorkRequestDetail })),
)
const TakeoffAiChooser = lazy(() =>
  import('./mobile/takeoff-ai-chooser.js').then((m) => ({ default: m.TakeoffAiChooser })),
)
const TakeoffAutoDetect = lazy(() =>
  import('./mobile/takeoff-auto-detect.js').then((m) => ({ default: m.TakeoffAutoDetect })),
)
const TakeoffAiCountSetup = lazy(() =>
  import('./mobile/takeoff-ai-count.js').then((m) => ({ default: m.TakeoffAiCountSetup })),
)
const TakeoffAiCountReview = lazy(() =>
  import('./mobile/takeoff-ai-count.js').then((m) => ({ default: m.TakeoffAiCountReview })),
)
const TakeoffAiTakeoffSetup = lazy(() =>
  import('./mobile/takeoff-ai-takeoff.js').then((m) => ({ default: m.TakeoffAiTakeoffSetup })),
)
const TakeoffAiTakeoffReview = lazy(() =>
  import('./mobile/takeoff-ai-takeoff.js').then((m) => ({ default: m.TakeoffAiTakeoffReview })),
)
const TakeoffAutoscale = lazy(() =>
  import('./mobile/takeoff-autoscale.js').then((m) => ({ default: m.TakeoffAutoscale })),
)
const TakeoffIngest = lazy(() => import('./mobile/takeoff-ingest.js').then((m) => ({ default: m.TakeoffIngest })))
const TakeoffScaleManual = lazy(() =>
  import('./mobile/takeoff-scale-manual.js').then((m) => ({ default: m.TakeoffScaleManual })),
)
const TakeoffCrossLink = lazy(() =>
  import('./mobile/takeoff-cross-link.js').then((m) => ({ default: m.TakeoffCrossLink })),
)
const TakeoffItemDetail = lazy(() =>
  import('./mobile/takeoff-item-detail.js').then((m) => ({ default: m.TakeoffItemDetail })),
)
const MobileInvoiceSent = lazy(() => import('./mobile/invoice-sent.js').then((m) => ({ default: m.MobileInvoiceSent })))
const WorkerClockinManual = lazy(() =>
  import('./mobile/worker-clockin.js').then((m) => ({ default: m.WorkerClockinManual })),
)
const WorkerClockoutSuccess = lazy(() =>
  import('./mobile/worker-clockout-success.js').then((m) => ({ default: m.WorkerClockoutSuccess })),
)

export type MobileShellProps = {
  bootstrap: BootstrapResponse | null
  companyRole: CompanyRole
  companySlug: string
  currentUserId?: string | null
  /**
   * Where the shell is mounted. '/m' is the legacy alias kept for any
   * external links that point at the original mobile-only entry; '' (or
   * undefined) means mounted at the app root, which is the canonical
   * location post-2026-05-05 when the desktop AppShell was retired.
   */
  basePath?: string
}

const ADMIN_TABS = [
  { id: 'today', label: 'Today', Icon: MI.Home },
  { id: 'projects', label: 'Projects', Icon: MI.FileText },
  { id: 'schedule', label: 'Schedule', Icon: MI.Clock },
  { id: 'rentals', label: 'Rentals', Icon: MI.Truck },
  { id: 'more', label: 'More', Icon: MI.Settings },
] as const

const FOREMAN_TABS = [
  { id: 'today', label: 'Today', Icon: MI.Home },
  { id: 'crew', label: 'Crew', Icon: MI.Users },
  { id: 'field', label: 'Field', Icon: MI.AlertTri },
  { id: 'log', label: 'Log', Icon: MI.FileText },
  { id: 'time', label: 'Time', Icon: MI.Clock },
] as const

const WORKER_TABS = [
  { id: 'today', label: 'Today', Icon: MI.Home },
  { id: 'scope', label: 'Scope', Icon: MI.Layers },
  { id: 'hours', label: 'Hours', Icon: MI.Clock },
  { id: 'log', label: 'Log', Icon: MI.Camera },
] as const

const ROLE_MODE_STORAGE_KEY = 'sitelayer.roleMode'
const ROLE_MODE_LABEL: Record<RoleMode, string> = {
  admin: 'Admin',
  foreman: 'Foreman',
  worker: 'Worker',
}

export function MobileShell({
  bootstrap,
  companyRole,
  companySlug,
  currentUserId = null,
  basePath = '',
}: MobileShellProps) {
  const params = useParams<{ projectId?: string }>()
  const location = useLocation()
  const navigate = useNavigate()
  const [modeOverride, setModeOverride] = useState<RoleMode | null>(() => readStoredRoleMode())

  const roleModes = useMemo(
    () =>
      availableRoleModes({
        companyRole,
        assignments: bootstrap?.projectAssignments ?? [],
      }),
    [companyRole, bootstrap?.projectAssignments],
  )

  useEffect(() => {
    if (modeOverride && !roleModes.includes(modeOverride)) {
      setModeOverride(null)
      writeStoredRoleMode(null)
    }
  }, [modeOverride, roleModes])

  useEffect(() => {
    const routeMode = inferRoleModeFromPath(location.pathname, basePath)
    if (!routeMode || !roleModes.includes(routeMode) || routeMode === modeOverride) return
    setModeOverride(routeMode)
    writeStoredRoleMode(routeMode)
  }, [basePath, location.pathname, modeOverride, roleModes])

  const ctx = useMemo<ActiveContext>(() => {
    return computeActiveContext({
      companyRole,
      assignments: bootstrap?.projectAssignments ?? [],
      currentProjectId: params.projectId ?? null,
      modeOverride,
    })
  }, [companyRole, bootstrap?.projectAssignments, params.projectId, modeOverride])

  const tabs = ctx.kind === 'admin' ? ADMIN_TABS : ctx.kind === 'foreman' ? FOREMAN_TABS : WORKER_TABS

  const activeTab =
    tabs.find((t) => {
      const prefix = `${basePath}/${t.id}`
      return location.pathname === prefix || location.pathname.startsWith(`${prefix}/`)
    })?.id ?? 'today'

  const isWorker = ctx.kind === 'worker'

  return (
    <div data-context={ctx.kind} className="m-host">
      <MShell className={isWorker ? 'm-dark' : undefined}>
        <OfflineBanner />
        <UpdateBanner />
        <InstallPromptBanner />
        <PushDeniedBanner />
        {/* Multi-company switcher — renders nothing for single-company
            users. Mounted above the role-mode switcher so the tenancy
            choice precedes the persona choice (you pick which company
            you're acting on, then which hat you're wearing inside it). */}
        <CompanySwitcher />
        {roleModes.length > 1 ? (
          <RoleModeSwitcher
            modes={roleModes}
            active={ctx.kind}
            onSelect={(mode) => {
              setModeOverride(mode)
              writeStoredRoleMode(mode)
              navigate(`${basePath}/today`)
            }}
          />
        ) : null}
        <Suspense fallback={<div className="p-4 text-ink-3">Loading…</div>}>
          <Routes>
            <Route index element={<Navigate to="today" replace />} />
            <Route
              path="today"
              element={
                ctx.kind === 'admin' ? (
                  <AdminHome bootstrap={bootstrap} />
                ) : ctx.kind === 'worker' ? (
                  <WorkerToday bootstrap={bootstrap} companySlug={companySlug} />
                ) : (
                  <ForemanToday bootstrap={bootstrap} companySlug={companySlug} />
                )
              }
            />
            <Route path="brief" element={<ForemanBrief bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="brief/:projectId" element={<ForemanBrief bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="field" element={<ForemanField bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="field/*" element={<ForemanField bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route
              path="foreman/blocker/:issueId"
              element={<ForemanBlockerDetail bootstrap={bootstrap} companySlug={companySlug} />}
            />
            <Route path="clockin" element={<WorkerClockinConfirm />} />
            <Route
              path="clockin/manual"
              element={<WorkerClockinManual bootstrap={bootstrap} companySlug={companySlug} />}
            />
            <Route path="clockout" element={<WorkerClockoutSuccess bootstrap={bootstrap} />} />
            <Route path="scope" element={<WorkerScope bootstrap={bootstrap} />} />
            <Route path="issue" element={<WorkerIssue bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="projects" element={<MobileProjectsList bootstrap={bootstrap} />} />
            <Route path="projects/sent" element={<MobileEstimatesSent />} />
            <Route path="projects/new" element={<MobileProjectNew companySlug={companySlug} />} />
            <Route path="projects/assignments" element={<ProjectAssignmentsScreen />} />
            <Route
              path="projects/:projectId"
              element={<MobileProjectDetail bootstrap={bootstrap} companyRole={companyRole} />}
            />
            <Route path="projects/:projectId/takeoff" element={<MobileTakeoffList companySlug={companySlug} />} />
            <Route
              path="projects/:projectId/takeoff-mobile"
              element={<TakeoffMobileScreen companySlug={companySlug} />}
            />
            <Route path="projects/:projectId/estimate" element={<MobileEstimateReview companySlug={companySlug} />} />
            <Route
              path="projects/:projectId/estimate-push/:pushId"
              element={<MobileEstimatePush companySlug={companySlug} companyRole={companyRole} />}
            />
            <Route path="projects/:projectId/shipments/:shipmentId" element={<ShipmentDetailScreen />} />
            <Route path="projects/:projectId/takeoff-ai" element={<TakeoffAiChooser companySlug={companySlug} />} />
            <Route
              path="projects/:projectId/takeoff-ai/detect"
              element={<TakeoffAutoDetect companySlug={companySlug} />}
            />
            <Route
              path="projects/:projectId/takeoff-ai/count"
              element={<TakeoffAiCountSetup companySlug={companySlug} />}
            />
            <Route
              path="projects/:projectId/takeoff-ai/count/review"
              element={<TakeoffAiCountReview companySlug={companySlug} />}
            />
            <Route
              path="projects/:projectId/takeoff-ai/takeoff"
              element={<TakeoffAiTakeoffSetup companySlug={companySlug} />}
            />
            <Route
              path="projects/:projectId/takeoff-ai/takeoff/review"
              element={<TakeoffAiTakeoffReview companySlug={companySlug} />}
            />
            <Route
              path="projects/:projectId/takeoff-ai/autoscale"
              element={<TakeoffAutoscale companySlug={companySlug} />}
            />
            <Route path="projects/:projectId/takeoff-ai/ingest" element={<TakeoffIngest companySlug={companySlug} />} />
            <Route
              path="projects/:projectId/takeoff-ai/scale-manual"
              element={<TakeoffScaleManual companySlug={companySlug} />}
            />
            <Route
              path="projects/:projectId/takeoff-ai/cross-link"
              element={<TakeoffCrossLink companySlug={companySlug} />}
            />
            <Route
              path="projects/:projectId/takeoff-item/:code"
              element={<TakeoffItemDetail companySlug={companySlug} />}
            />
            <Route path="projects/:projectId/post-mortem" element={<MobilePostMortem />} />
            <Route
              path="projects/:projectId/*"
              element={<MobileProjectDetail bootstrap={bootstrap} companyRole={companyRole} />}
            />
            <Route path="schedule" element={<MobileSchedule bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="schedule/*" element={<MobileSchedule bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="rentals" element={<MobileRentals companySlug={companySlug} companyRole={companyRole} />} />
            <Route
              path="rentals/dispatch"
              element={<MobileRentalDispatch bootstrap={bootstrap} companySlug={companySlug} />}
            />
            <Route path="rentals/utilization" element={<MobileRentalsUtilization companySlug={companySlug} />} />
            <Route path="rentals/service" element={<MobileRentalsService />} />
            <Route path="rentals/service/:assetId" element={<MobileRentalsService />} />
            <Route path="rentals/asset/:assetId" element={<MobileRentalsAsset />} />
            <Route
              path="rentals/scan"
              element={<MobileRentalScan bootstrap={bootstrap} companySlug={companySlug} initialMode="deliver" />}
            />
            <Route
              path="rentals/return"
              element={<MobileRentalScan bootstrap={bootstrap} companySlug={companySlug} initialMode="return" />}
            />
            <Route path="scaffold-inspections" element={<MobileScaffoldInspectionScreen />} />
            <Route path="scaffold-inspections/:token" element={<MobileScaffoldInspectionScreen />} />
            <Route path="rentals/portal" element={<MobileRentalsPortal companySlug={companySlug} />} />
            <Route path="rentals/requests" element={<RentalRequestsQueueScreen />} />
            <Route path="rentals/lifecycle/:id" element={<RentalLifecycleDetailScreen />} />
            {/* Headless rental_billing_run renderer — registered BEFORE the
                rentals/* catchall below, otherwise the catchall swallows it
                (CLAUDE.md routing rule). */}
            <Route path="rentals/billing" element={<MobileRentalBillingList />} />
            <Route
              path="rentals/billing/:id"
              element={<MobileRentalBillingDetail companySlug={companySlug} companyRole={companyRole} />}
            />
            <Route path="rentals/*" element={<MobileRentals companySlug={companySlug} companyRole={companyRole} />} />
            <Route path="invoice/new" element={<MobileQuickInvoice bootstrap={bootstrap} />} />
            <Route path="invoice-sent/:projectId" element={<MobileInvoiceSent bootstrap={bootstrap} />} />
            <Route path="money" element={<OwnerMoney bootstrap={bootstrap} />} />
            <Route path="chat" element={<MobileChatList bootstrap={bootstrap} />} />
            <Route path="ops" element={<MobileOps companyRole={companyRole} companySlug={companySlug} />} />
            <Route
              path="work"
              element={<MobileWorkRequests companyRole={companyRole} currentUserId={currentUserId} />}
            />
            <Route path="work/board" element={<MobileIssueBoard companyRole={companyRole} />} />
            <Route path="work/:workItemId" element={<MobileWorkRequestDetail companyRole={companyRole} />} />
            {/* Internal APP-ISSUE board + detail — capability-gated to
                app_issue.view (the gate components redirect non-platform-admins);
                the API 403s regardless. The :issueId detail mounts the "go
                deeper" escalation + per-issue cost ledger (STEP6-UI). The
                catchall keeps any other /issues/* path on the board. */}
            <Route path="issues" element={<MobileAppIssues />} />
            <Route path="issues/:issueId" element={<MobileAppIssueDetail />} />
            <Route path="issues/*" element={<MobileAppIssues />} />
            <Route path="more/*" element={<MoreRoute />} />
            <Route
              path="settings/*"
              element={<MobileSettingsHome bootstrap={bootstrap} companyRole={companyRole} navigate={navigate} />}
            />
            <Route path="crew" element={<ForemanCrew bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="crew/*" element={<ForemanCrew bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="map" element={<ForemanMap bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route path="map/*" element={<ForemanMap bootstrap={bootstrap} companySlug={companySlug} />} />
            <Route
              path="log"
              element={
                ctx.kind === 'worker' ? (
                  <WorkerLog bootstrap={bootstrap} companySlug={companySlug} />
                ) : (
                  <ForemanLog bootstrap={bootstrap} companySlug={companySlug} />
                )
              }
            />
            <Route
              path="log/*"
              element={
                ctx.kind === 'worker' ? (
                  <WorkerLog bootstrap={bootstrap} companySlug={companySlug} />
                ) : (
                  <ForemanLog bootstrap={bootstrap} companySlug={companySlug} />
                )
              }
            />
            <Route path="time" element={<MobileTimeReview bootstrap={bootstrap} />} />
            <Route path="time/new" element={<MobileForemanTimeEntry bootstrap={bootstrap} />} />
            <Route path="time/*" element={<MobileTimeReview bootstrap={bootstrap} />} />
            <Route path="scope/*" element={<WorkerScope bootstrap={bootstrap} />} />
            <Route path="hours" element={<WorkerHours bootstrap={bootstrap} />} />
            <Route path="hours/*" element={<WorkerHours bootstrap={bootstrap} />} />
            <Route path="*" element={<Navigate to="today" replace />} />
          </Routes>
        </Suspense>
        <MBottomTabs tabs={[...tabs]} activeId={activeTab} onSelect={(id) => navigate(`${basePath}/${id}`)} />
      </MShell>
    </div>
  )
}

function RoleModeSwitcher({
  modes,
  active,
  onSelect,
}: {
  modes: readonly RoleMode[]
  active: RoleMode
  onSelect: (mode: RoleMode) => void
}) {
  return (
    <div
      style={{
        borderBottom: '1px solid var(--m-line)',
        background: 'var(--m-bg)',
      }}
    >
      <MChipRow>
        {modes.map((mode) => (
          <MChip key={mode} active={active === mode} onClick={() => onSelect(mode)}>
            {ROLE_MODE_LABEL[mode]}
          </MChip>
        ))}
      </MChipRow>
    </div>
  )
}

function readStoredRoleMode(): RoleMode | null {
  if (typeof window === 'undefined') return null
  try {
    return normalizeRoleMode(window.sessionStorage.getItem(ROLE_MODE_STORAGE_KEY))
  } catch {
    return null
  }
}

function writeStoredRoleMode(mode: RoleMode | null): void {
  if (typeof window === 'undefined') return
  try {
    if (mode) {
      window.sessionStorage.setItem(ROLE_MODE_STORAGE_KEY, mode)
    } else {
      window.sessionStorage.removeItem(ROLE_MODE_STORAGE_KEY)
    }
  } catch {
    // Private-mode storage failures should not block navigation.
  }
}

function inferRoleModeFromPath(pathname: string, basePath: string): RoleMode | null {
  const base = basePath.replace(/\/+$/, '')
  const relative =
    base && pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1) : pathname.replace(/^\/+/, '')
  const segment = relative.split('/')[0] ?? ''
  if (
    segment === 'projects' ||
    segment === 'schedule' ||
    segment === 'rentals' ||
    segment === 'more' ||
    segment === 'settings' ||
    segment === 'invoice' ||
    segment === 'invoice-sent' ||
    segment === 'work'
  ) {
    return 'admin'
  }
  if (segment === 'crew' || segment === 'map' || segment === 'field' || segment === 'brief' || segment === 'foreman') {
    return 'foreman'
  }
  if (
    segment === 'scope' ||
    segment === 'hours' ||
    segment === 'clockin' ||
    segment === 'clockout' ||
    segment === 'issue'
  ) {
    return 'worker'
  }
  return null
}
