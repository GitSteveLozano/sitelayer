/**
 * Field / mobile section of the unified app shell (Phase D).
 *
 * MobileShell's bottom-tab chrome plus the operator probe + feedback dock that
 * the former `routes/workspace.tsx` `CompanyWorkspace` mounted around it. The
 * command-center section (screens/desktop/desktop-workspace.tsx) installs its
 * own copies of these internally, so they live here — not in AppShell — to avoid
 * double-mounting across sections.
 *
 * Lives in its own module so the unified AppShell can lazy-load it: the field
 * bundle (MobileShell + ~80 persona screens) stays a separate chunk from the
 * owner/estimator command-center chunk, the same split the pre-Phase-D
 * `/m`/`/*` vs `/desktop/*` lazy routes had.
 */
import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { ControlPlaneProbe } from '@/components/ControlPlaneProbe'
import { AuthenticatedFeedbackDock } from '@/components/capture/AuthenticatedFeedbackDock'
import type { BootstrapResponse } from '@/lib/api'
import type { normalizeMobileShellRole } from '@/lib/active-context'
import { RoleContext, type Role } from '@/lib/role'
import { MobileShell } from '@/screens/mobile-shell'

export type FieldSurfaceProps = {
  bootstrap: BootstrapResponse | null
  companyRole: ReturnType<typeof normalizeMobileShellRole>
  companySlug: string
  currentUserId: string | null
  persona: Role
  sessionRole: string | null
}

export default function FieldSurface({
  bootstrap,
  companyRole,
  companySlug,
  currentUserId,
  persona,
  sessionRole,
}: FieldSurfaceProps) {
  const location = useLocation()
  const probeRoute = useMemo(() => parseProbeRoute(location.pathname), [location.pathname])
  const activeProjectName =
    probeRoute.projectId && bootstrap
      ? (bootstrap.projects.find((p) => p.id === probeRoute.projectId)?.name ?? null)
      : null

  return (
    <RoleContext.Provider value={persona}>
      {/* Operator probe — installs `window.__controlPlaneProbe` for the
          browser-bridge capture-modal. */}
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
      <AuthenticatedFeedbackDock companySlug={companySlug} />
      <MobileShell
        bootstrap={bootstrap}
        companyRole={companyRole}
        companySlug={companySlug}
        currentUserId={currentUserId}
      />
    </RoleContext.Provider>
  )
}

/**
 * Parse the route into the two fields the probe carries on `path`:
 *   /projects/abc123/... -> { projectId: 'abc123', currentTab: 'projects' }
 *   /estimates           -> { projectId: null,     currentTab: 'estimates' }
 *   /                    -> { projectId: null,     currentTab: null }
 * Intentionally lossy — the probe only needs enough coordinates to label the
 * captured tab.
 */
function parseProbeRoute(pathname: string): { projectId: string | null; currentTab: string | null } {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) return { projectId: null, currentTab: null }
  const [first, second] = segments
  const currentTab = first ?? null
  const projectId = first === 'projects' && second ? second : null
  return { projectId, currentTab }
}
