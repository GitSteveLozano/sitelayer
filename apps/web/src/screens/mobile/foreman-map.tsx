/**
 * Crew-on-site map — `fm-map`. The dedicated standalone version of the
 * "Map" view-mode that also lives inside `foreman-crew.tsx`. Reached from
 * the Crew screen's "Map" toggle (which navigates to `/map`).
 *
 * Header reads "Crew on site" with a sub of `<primary site> · N of M in
 * fence`; the body is the shared stylized map (`ForemanCrewMap`) — roads,
 * geofence rings, worker pins colored by clock status, project anchors,
 * and a live roster. There are no map-provider keys in this environment,
 * so the map is the same SVG/CSS stylization used by foreman-crew; no
 * Mapbox/Google dependency is introduced.
 *
 * In-fence vs off-map status is derived from bootstrap labor counts as a
 * proxy until the /api/clock/timeline geofence call is wired (same proxy
 * foreman-crew uses for its status dots).
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { MBody, MI, MTopBar } from '../../components/m/index.js'
import { ForemanCrewMap } from './foreman-crew.js'
import { todayIso } from './format.js'

export function ForemanMap({
  bootstrap,
  companySlug: _companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const today = todayIso()

  // Mirror the site-selection ForemanCrewMap uses so the header sub-line
  // ("Hillcrest · 3 of 4 in fence") matches the geofence ring the body
  // draws first. The primary site is the first active project (falling
  // back to the first project overall when none are flagged active).
  const activeProjects = useMemo(() => projects.filter((p) => /progress|active/i.test(p.status)), [projects])
  const mappedProjects = activeProjects.length > 0 ? activeProjects : projects.slice(0, 3)
  const primarySite = mappedProjects[0] ?? null

  // Workers with any logged time today on the primary site count as
  // "in fence"; the rest of the site's expected crew are the denominator.
  const todayLabor = useMemo(
    () => labor.filter((l) => l.occurred_on === today && !l.deleted_at && l.worker_id),
    [labor, today],
  )
  const inFenceCount = primarySite
    ? new Set(todayLabor.filter((l) => l.project_id === primarySite.id).map((l) => l.worker_id)).size
    : 0
  const onSiteTotal = new Set(todayLabor.map((l) => l.worker_id)).size

  const siteName = primarySite ? primarySite.name.split(/\s+/).slice(0, 2).join(' ') : null
  const sub = primarySite
    ? `${siteName} · ${inFenceCount} of ${Math.max(inFenceCount, onSiteTotal)} in fence`
    : `${mappedProjects.length} site${mappedProjects.length === 1 ? '' : 's'}`

  return (
    <>
      <MTopBar
        back
        onBack={() => navigate('/crew')}
        title="Crew on site"
        sub={sub}
        actionIcon={<MI.Search size={20} />}
        actionLabel="Filter"
      />
      <MBody>
        <ForemanCrewMap
          projects={projects}
          workers={workers}
          labor={labor}
          today={today}
          onOpenProject={(projectId) => navigate(`/projects/${projectId}`)}
        />
      </MBody>
    </>
  )
}
