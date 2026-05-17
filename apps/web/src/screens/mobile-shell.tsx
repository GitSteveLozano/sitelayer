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
 * Implementation note: for Phase 2 the per-tab screens are placeholders.
 * Each phase from 3 onward replaces a placeholder with a real screen.
 */
import { lazy, useEffect, useMemo, useState } from 'react'
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

// MoreRoute lives outside the shell historically; we mount it inside so
// the bottom-tab chrome stays visible while the user is in settings,
// catalog, integrations, etc. Lazy-loaded so the More tab doesn't pull
// the settings-screen bundle into the initial paint.
const MoreRoute = lazy(() => import('../routes/more.js'))
import { InstallPromptBanner } from '../components/shell/InstallPromptBanner.js'
import { OfflineBanner } from '../components/shell/OfflineBanner.js'
import { PushDeniedBanner } from '../components/shell/PushDeniedBanner.js'
import { UpdateBanner } from '../components/shell/UpdateBanner.js'
import { AdminHome } from './mobile/admin-home.js'
import { MobileProjectsList } from './mobile/projects-list.js'
import { MobileEstimatesSent } from './mobile/estimates-sent.js'
import { MobileProjectDetail } from './mobile/project-detail.js'
import { MobileProjectNew } from './mobile/project-new.js'
import { MobileTakeoffList } from './mobile/takeoff-list.js'
import { MobileEstimateReview } from './mobile/estimate-review.js'
import { MobileEstimatePush } from './mobile/estimate-push.js'
import { MobileSchedule } from './mobile/schedule.js'
import { MobileTimeReview } from './mobile/time-review.js'
import { MobileForemanTimeEntry } from './mobile/foreman-time-entry.js'
import { WorkerToday } from './mobile/worker-today.js'
import { WorkerClockinConfirm } from './mobile/worker-clockin.js'
import { WorkerScope } from './mobile/worker-scope.js'
import { WorkerIssue } from './mobile/worker-issue.js'
import { WorkerHours } from './mobile/worker-hours.js'
import { WorkerLog } from './mobile/worker-log.js'
import { ForemanToday } from './mobile/foreman-today.js'
import { ForemanField } from './mobile/foreman-field.js'
import { ForemanCrew } from './mobile/foreman-crew.js'
import { ForemanBrief } from './mobile/foreman-brief.js'
import { ForemanLog } from './mobile/foreman-log.js'
import { ForemanBlockerDetail } from './mobile/foreman-blocker-detail.js'
import { MobileRentals } from './mobile/rentals.js'
import { MobileRentalDispatch } from './mobile/rentals-dispatch.js'
import { MobileRentalsUtilization } from './mobile/rentals-utilization.js'
import { MobileRentalScan } from './mobile/rentals-scan.js'
import { MobileScaffoldInspectionScreen } from './mobile/scaffold-inspection.js'
import { MobileRentalsPortal } from './mobile/rentals-portal.js'
import { RentalRequestsQueueScreen } from './rentals/rental-requests-queue.js'
import { MobileQuickInvoice } from './mobile/invoice-quick.js'

export type MobileShellProps = {
  bootstrap: BootstrapResponse | null
  companyRole: CompanyRole
  companySlug: string
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

export function MobileShell({ bootstrap, companyRole, companySlug, basePath = '' }: MobileShellProps) {
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
          <Route path="scope" element={<WorkerScope bootstrap={bootstrap} />} />
          <Route path="issue" element={<WorkerIssue bootstrap={bootstrap} companySlug={companySlug} />} />
          <Route path="projects" element={<MobileProjectsList bootstrap={bootstrap} />} />
          <Route path="projects/sent" element={<MobileEstimatesSent />} />
          <Route path="projects/new" element={<MobileProjectNew companySlug={companySlug} />} />
          <Route path="projects/:projectId" element={<MobileProjectDetail bootstrap={bootstrap} />} />
          <Route path="projects/:projectId/takeoff" element={<MobileTakeoffList companySlug={companySlug} />} />
          <Route path="projects/:projectId/estimate" element={<MobileEstimateReview companySlug={companySlug} />} />
          <Route
            path="projects/:projectId/estimate-push/:pushId"
            element={<MobileEstimatePush companySlug={companySlug} />}
          />
          <Route path="projects/:projectId/*" element={<MobileProjectDetail bootstrap={bootstrap} />} />
          <Route path="schedule" element={<MobileSchedule bootstrap={bootstrap} companySlug={companySlug} />} />
          <Route path="schedule/*" element={<MobileSchedule bootstrap={bootstrap} companySlug={companySlug} />} />
          <Route path="rentals" element={<MobileRentals companySlug={companySlug} />} />
          <Route
            path="rentals/dispatch"
            element={<MobileRentalDispatch bootstrap={bootstrap} companySlug={companySlug} />}
          />
          <Route path="rentals/utilization" element={<MobileRentalsUtilization companySlug={companySlug} />} />
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
          <Route path="rentals/*" element={<MobileRentals companySlug={companySlug} />} />
          <Route path="invoice/new" element={<MobileQuickInvoice bootstrap={bootstrap} />} />
          <Route path="more/*" element={<MoreRoute />} />
          <Route path="crew" element={<ForemanCrew bootstrap={bootstrap} />} />
          <Route path="crew/*" element={<ForemanCrew bootstrap={bootstrap} />} />
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
    segment === 'invoice'
  ) {
    return 'admin'
  }
  if (segment === 'crew' || segment === 'field' || segment === 'brief' || segment === 'foreman') {
    return 'foreman'
  }
  if (segment === 'scope' || segment === 'hours' || segment === 'clockin' || segment === 'issue') {
    return 'worker'
  }
  return null
}
