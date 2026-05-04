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
import type { BootstrapResponse } from '../api.js'
import { computeActiveContext, type ActiveContext } from '../lib/active-context.js'
import { MBottomTabs, MBody, MI, MLargeHead, MShell, MTopBar } from '../components/m/index.js'
import { AdminHome } from './m/admin-home.js'
import { MobileProjectsList } from './m/projects-list.js'

export type MobileShellProps = {
  bootstrap: BootstrapResponse | null
  companyRole: 'admin' | 'foreman' | 'office' | 'member'
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

export function MobileShell({ bootstrap, companyRole }: MobileShellProps) {
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

  const activeTab = tabs.find((t) => location.pathname.startsWith(`/m/${t.id}`))?.id ?? 'today'

  const isWorker = ctx.kind === 'worker'

  return (
    <div data-context={ctx.kind} style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <MShell className={isWorker ? 'm-dark' : undefined}>
        <Routes>
          <Route index element={<Navigate to="today" replace />} />
          <Route
            path="today"
            element={
              ctx.kind === 'admin' ? <AdminHome bootstrap={bootstrap} /> : <TodayPlaceholder ctx={ctx} />
            }
          />
          <Route path="projects" element={<MobileProjectsList bootstrap={bootstrap} />} />
          <Route path="projects/:projectId/*" element={<TabPlaceholder title="Project" body="Phase 4 lands here." />} />
          <Route path="schedule/*" element={<TabPlaceholder title="Schedule" body="Phase 6 lands here." />} />
          <Route path="rentals/*" element={<TabPlaceholder title="Rentals" body="Phase 9 lands here." />} />
          <Route path="more/*" element={<TabPlaceholder title="More" body="Settings, profile, integrations." />} />
          <Route path="crew/*" element={<TabPlaceholder title="Crew" body="Phase 8 lands here." />} />
          <Route path="field/*" element={<TabPlaceholder title="Field" body="Phase 8 lands here." />} />
          <Route path="log/*" element={<TabPlaceholder title="Log" body="Phase 7 / 8 lands here." />} />
          <Route path="time/*" element={<TabPlaceholder title="Time" body="Phase 6 lands here." />} />
          <Route path="scope/*" element={<TabPlaceholder title="Scope" body="Phase 7 lands here." />} />
          <Route path="hours/*" element={<TabPlaceholder title="Hours" body="Phase 7 lands here." />} />
          <Route path="*" element={<Navigate to="today" replace />} />
        </Routes>
        <MBottomTabs tabs={[...tabs]} activeId={activeTab} onSelect={(id) => navigate(`/m/${id}`)} />
      </MShell>
    </div>
  )
}

function TodayPlaceholder({ ctx }: { ctx: ActiveContext }) {
  const eyebrow = ctx.kind === 'admin' ? 'Calm dashboard' : ctx.kind === 'foreman' ? 'Sites today' : "Today's job"
  return (
    <>
      <MTopBar title="Today" />
      <MBody pad>
        <MLargeHead
          eyebrow={eyebrow.toUpperCase()}
          title={ctx.kind === 'admin' ? "You're caught up." : ctx.kind === 'foreman' ? '3 sites · 6 crew' : 'Hillcrest Mews — Phase 4'}
          sub={
            ctx.kind === 'worker'
              ? 'EPS · East elevation · 7:00 AM start'
              : 'Phase 3+ replaces this with the real screen.'
          }
        />
      </MBody>
    </>
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
