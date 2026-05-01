import { useRole } from '@/lib/role'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'

/**
 * Time tab — role-aware default per `Sitemap.html` § 03:
 *   - owner   → t-approve  (approval queue)
 *   - foreman → t-foreman  (batch entry)
 *   - worker  → wk-hours   (read-only personal)
 */
export default function TimeRoute() {
  const role = useRole()

  if (role === 'foreman') {
    return (
      <PlaceholderScreen eyebrow="Foreman · Time" title="Crew entry" designId="t-foreman">
        Phase 1: foreman-view time entry — crew list, batch clock-in for the day, geofence override.
      </PlaceholderScreen>
    )
  }

  if (role === 'worker') {
    return (
      <PlaceholderScreen eyebrow="Worker · Time" title="My week" designId="wk-hours">
        Phase 1: read-only personal hours, week summary, dispute deep-link.
      </PlaceholderScreen>
    )
  }

  return (
    <PlaceholderScreen eyebrow="Owner / PM · Time" title="Approval queue" designId="t-approve">
      Phase 1: approval queue with anomaly flags (overtime, geofence breach, no-clock-out). Sub-tabs for burden and
      live-vs-budget.
    </PlaceholderScreen>
  )
}
