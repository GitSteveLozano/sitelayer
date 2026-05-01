import { useRole } from '@/lib/role'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'
import { WorkerHoursScreen } from '@/screens/worker'
import { ApprovalQueueScreen } from '@/screens/foreman'

/**
 * Time tab — role-aware default per `Sitemap.html` § 03:
 *   - owner   → t-approve  (approval queue)         — 1D.3 (wired below)
 *   - foreman → t-foreman  (batch entry)            — Phase 1D.4 needs new endpoint
 *   - worker  → wk-hours   (read-only personal)     — 1D.2 (wired below)
 *
 * Foreman sees the approval queue too — they REOPEN runs they need to
 * correct. Owner sees it as their primary surface.
 */
export default function TimeRoute() {
  const role = useRole()

  if (role === 'worker') {
    return <WorkerHoursScreen />
  }

  if (role === 'foreman' || role === 'owner') {
    return <ApprovalQueueScreen />
  }

  return (
    <PlaceholderScreen
      eyebrow="Time"
      title="Approval queue"
      designId="t-approve"
    >
      Phase 1D.4 wires the foreman batch entry surface (t-foreman) once the
      foreman batch-clock endpoint lands.
    </PlaceholderScreen>
  )
}
