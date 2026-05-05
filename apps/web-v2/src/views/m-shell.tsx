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
import { useMemo } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '../api-v1-compat.js'
import { computeActiveContext, type ActiveContext } from '../lib/active-context.js'
import { MBottomTabs, MBody, MI, MShell, MTopBar } from '../components/m/index.js'
import { InstallPromptBanner } from '../components/shell/InstallPromptBanner.js'
import { OfflineBanner } from '../components/shell/OfflineBanner.js'
import { PushDeniedBanner } from '../components/shell/PushDeniedBanner.js'
import { UpdateBanner } from '../components/shell/UpdateBanner.js'
import { AdminHome } from './m/admin-home.js'
import { MobileProjectsList } from './m/projects-list.js'
import { MobileProjectDetail } from './m/project-detail.js'
import { MobileTakeoffList } from './m/takeoff-list.js'
import { MobileEstimateReview } from './m/estimate-review.js'
import { MobileSchedule } from './m/schedule.js'
import { MobileTimeReview } from './m/time-review.js'
import { WorkerToday } from './m/worker-today.js'
import { WorkerClockinConfirm } from './m/worker-clockin.js'
import { WorkerScope } from './m/worker-scope.js'
import { WorkerIssue } from './m/worker-issue.js'
import { WorkerHours } from './m/worker-hours.js'
import { WorkerLog } from './m/worker-log.js'
import { ForemanToday } from './m/foreman-today.js'
import { ForemanField } from './m/foreman-field.js'
import { ForemanCrew } from './m/foreman-crew.js'
import { ForemanBrief } from './m/foreman-brief.js'
import { ForemanLog } from './m/foreman-log.js'
import { MobileRentals } from './m/rentals.js'
import { MobileRentalDispatch } from './m/rentals-dispatch.js'
import { MobileRentalsUtilization } from './m/rentals-utilization.js'
import { MobileQuickInvoice } from './m/invoice-quick.js'

export type MobileShellProps = {
  bootstrap: BootstrapResponse | null
  companyRole: 'admin' | 'foreman' | 'office' | 'member'
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

export function MobileShell({ bootstrap, companyRole, companySlug, basePath = '' }: MobileShellProps) {
  const params = useParams<{ projectId?: string }>()
  const location = useLocation()
  const navigate = useNavigate()

  const ctx = useMemo<ActiveContext>(() => {
    return computeActiveContext({
      companyRole,
      assignments: bootstrap?.projectAssignments ?? [],
      currentProjectId: params.projectId ?? null,
    })
  }, [companyRole, bootstrap?.projectAssignments, params.projectId])

  const tabs = ctx.kind === 'admin' ? ADMIN_TABS : ctx.kind === 'foreman' ? FOREMAN_TABS : WORKER_TABS

  const activeTab =
    tabs.find((t) => {
      const prefix = `${basePath}/${t.id}`
      return location.pathname === prefix || location.pathname.startsWith(`${prefix}/`)
    })?.id ?? 'today'

  const isWorker = ctx.kind === 'worker'

  return (
    <div data-context={ctx.kind} style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MShell className={isWorker ? 'm-dark' : undefined}>
        <OfflineBanner />
        <UpdateBanner />
        <InstallPromptBanner />
        <PushDeniedBanner />
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
          <Route path="clockin" element={<WorkerClockinConfirm />} />
          <Route path="scope" element={<WorkerScope bootstrap={bootstrap} />} />
          <Route path="issue" element={<WorkerIssue bootstrap={bootstrap} companySlug={companySlug} />} />
          <Route path="projects" element={<MobileProjectsList bootstrap={bootstrap} />} />
          <Route path="projects/:projectId" element={<MobileProjectDetail bootstrap={bootstrap} />} />
          <Route path="projects/:projectId/takeoff" element={<MobileTakeoffList companySlug={companySlug} />} />
          <Route path="projects/:projectId/estimate" element={<MobileEstimateReview companySlug={companySlug} />} />
          <Route path="projects/:projectId/*" element={<MobileProjectDetail bootstrap={bootstrap} />} />
          <Route path="schedule" element={<MobileSchedule bootstrap={bootstrap} />} />
          <Route path="schedule/*" element={<MobileSchedule bootstrap={bootstrap} />} />
          <Route path="rentals" element={<MobileRentals companySlug={companySlug} />} />
          <Route
            path="rentals/dispatch"
            element={<MobileRentalDispatch bootstrap={bootstrap} companySlug={companySlug} />}
          />
          <Route path="rentals/utilization" element={<MobileRentalsUtilization companySlug={companySlug} />} />
          <Route path="rentals/scan" element={<MobileRentals companySlug={companySlug} />} />
          <Route path="rentals/*" element={<MobileRentals companySlug={companySlug} />} />
          <Route path="invoice/new" element={<MobileQuickInvoice bootstrap={bootstrap} />} />
          <Route path="more/*" element={<TabPlaceholder title="More" body="Settings, profile, integrations." />} />
          <Route path="crew" element={<ForemanCrew bootstrap={bootstrap} />} />
          <Route path="crew/*" element={<ForemanCrew bootstrap={bootstrap} />} />
          <Route path="field/*" element={<TabPlaceholder title="Field" body="Phase 8 lands here." />} />
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

function TabPlaceholder({ title, body }: { title: string; body: string }) {
  return (
    <>
      <MTopBar title={title} />
      <MBody pad>
        <div style={{ padding: 24, color: 'var(--m-ink-2)' }}>{body}</div>
      </MBody>
    </>
  )
}
