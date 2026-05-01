import { useRole } from '@/lib/role'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'
import { WorkerTodayScreen } from '@/screens/worker'
import { ForemanTodayScreen } from '@/screens/foreman'

/**
 * Role-aware Home tab. Three Homes, three design IDs from `Sitemap.html`:
 *   - owner   → db-calm-default (Phase 2)
 *   - foreman → fm-today-v2     (1D.3 — wired below)
 *   - worker  → wk-today        (1D.2 — wired below)
 */
export default function HomeRoute() {
  const role = useRole()

  if (role === 'worker') {
    return <WorkerTodayScreen />
  }

  if (role === 'foreman') {
    return <ForemanTodayScreen />
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
