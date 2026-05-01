import { useRole } from '@/lib/role'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'

/**
 * Role-aware Home tab. Three Homes, three design IDs from `Sitemap.html`:
 *   - owner   → db-calm-default
 *   - foreman → fm-today-v2
 *   - worker  → wk-today
 *
 * Real content lands in Phase 1 (foreman + worker) and Phase 2 (owner).
 */
export default function HomeRoute() {
  const role = useRole()

  if (role === 'foreman') {
    return (
      <PlaceholderScreen
        eyebrow="Foreman · Home"
        title="Crew today"
        designId="fm-today-v2"
      >
        Phase 1 lands here: live geofence card, today's crew assignments, WTD
        burden, end-of-day daily log entry.
      </PlaceholderScreen>
    )
  }

  if (role === 'worker') {
    return (
      <PlaceholderScreen
        eyebrow="Worker · Home"
        title="Today"
        designId="wk-today"
      >
        Phase 1 lands here: auto clock-in confirmation, today's scope, flag
        a problem, this week's hours.
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
