import { useRole } from '@/lib/role'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'
import { WorkerHoursScreen } from '@/screens/worker'

/**
 * Time tab — role-aware default per `Sitemap.html` § 03:
 *   - owner   → t-approve  (approval queue) — Phase 1D.3 / 2
 *   - foreman → t-foreman  (batch entry)    — Phase 1D.3
 *   - worker  → wk-hours   (read-only personal) — 1D.2 (wired below)
 */
export default function TimeRoute() {
  const role = useRole()

  if (role === 'worker') {
    return <WorkerHoursScreen />
  }

  if (role === 'foreman') {
    return (
      <PlaceholderScreen
        eyebrow="Foreman · Time"
        title="Crew entry"
        designId="t-foreman"
      >
        Phase 1D.3: foreman-view time entry — crew list, batch clock-in for the
        day, geofence override.
      </PlaceholderScreen>
    )
  }

  return (
    <PlaceholderScreen
      eyebrow="Owner / PM · Time"
      title="Approval queue"
      designId="t-approve"
    >
      Phase 1D.3: approval queue with anomaly flags (overtime, geofence breach,
      no-clock-out). Sub-tabs for burden and live-vs-budget.
    </PlaceholderScreen>
  )
}
