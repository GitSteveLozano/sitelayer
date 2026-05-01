import { useRole } from '@/lib/role'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'
import { WorkerTodayScreen } from '@/screens/worker'

/**
 * Role-aware Home tab. Three Homes, three design IDs from `Sitemap.html`:
 *   - owner   → db-calm-default (Phase 2)
 *   - foreman → fm-today-v2     (Phase 1D.3)
 *   - worker  → wk-today        (1D.2 — wired below)
 */
export default function HomeRoute() {
  const role = useRole()

  if (role === 'worker') {
    return <WorkerTodayScreen />
  }

  if (role === 'foreman') {
    return (
      <PlaceholderScreen
        eyebrow="Foreman · Home"
        title="Crew today"
        designId="fm-today-v2"
      >
        Phase 1D.3 lands here: live geofence card, today's crew assignments, WTD
        burden, end-of-day daily log entry.
      </PlaceholderScreen>
    )
  }

  return (
    <PlaceholderScreen
      eyebrow="Owner / PM · Home"
      title="Today"
      designId="db-calm-default"
    >
      Phase 2 lands here: calm dashboard, KPIs, three of today's projects,
      and the "What needs me?" pivot driven by Phase 1's anomaly data.
    </PlaceholderScreen>
  )
}
