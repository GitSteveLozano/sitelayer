/**
 * Foreman route-base resolution for the responsive (Phase B) foreman screens.
 *
 * The 6 foreman desktop↔mobile twin pairs were collapsed into ONE responsive
 * screen each (see screens/mobile/foreman-*.tsx). Both the desktop route table
 * (screens/desktop/desktop-workspace.tsx, `/desktop/fm/*`) and the mobile shell
 * (screens/mobile-shell.tsx, root `/*`) now mount the SAME component, so the
 * screen can't hard-code one navigation prefix the way each twin used to.
 *
 * This resolver reads the live pathname and returns the navigation targets for
 * whichever shell mounted the screen, preserving each twin's original links:
 *
 *   - desktop shell (`/desktop/...`): today → /desktop/fm/today, brief →
 *     /desktop/fm/brief/:id, blocker → /desktop/fm/blocker/:id, project →
 *     /desktop/projects/:id, schedule → /desktop/fm/schedule, field → the FM
 *     today board (desktop has no separate /field tab), crew map → /desktop/fm/crew,
 *     time → /desktop/fm/time.
 *   - mobile shell (root): today → /today, brief → /brief/:id, blocker →
 *     /foreman/blocker/:id, project → /projects/:id, schedule → /schedule,
 *     field → /field, crew map → /map, time → /time, time-new → /time/new.
 *
 * The prefixes mirror the original per-twin hrefs exactly — this is a
 * layout-only consolidation, so no destination changes, only their resolution.
 */
export interface ForemanNav {
  /** True when mounted under the `/desktop/*` command-center shell. */
  isDesktopShell: boolean
  today: string
  schedule: string
  /** The "see field issues" target — /field on mobile, FM Today on desktop. */
  field: string
  /** The crew map target — /map on mobile, the in-screen Crew map on desktop. */
  crewMap: string
  time: string
  /** Manual time-entry form (mobile-only route; desktop falls back to time). */
  timeNew: string
  brief: (projectId?: string) => string
  blocker: (issueId: string) => string
  project: (projectId: string) => string
}

export function resolveForemanNav(pathname: string): ForemanNav {
  const isDesktopShell = pathname.startsWith('/desktop')
  if (isDesktopShell) {
    return {
      isDesktopShell: true,
      today: '/desktop/fm/today',
      schedule: '/desktop/fm/schedule',
      field: '/desktop/fm/today',
      crewMap: '/desktop/fm/crew',
      time: '/desktop/fm/time',
      timeNew: '/desktop/fm/time',
      brief: (projectId) => (projectId ? `/desktop/fm/brief/${projectId}` : '/desktop/fm/today'),
      blocker: (issueId) => `/desktop/fm/blocker/${issueId}`,
      project: (projectId) => `/desktop/projects/${projectId}`,
    }
  }
  return {
    isDesktopShell: false,
    today: '/today',
    schedule: '/schedule',
    field: '/field',
    crewMap: '/map',
    time: '/time',
    timeNew: '/time/new',
    brief: (projectId) => (projectId ? `/brief/${projectId}` : '/brief'),
    blocker: (issueId) => `/foreman/blocker/${issueId}`,
    project: (projectId) => `/projects/${projectId}`,
  }
}
