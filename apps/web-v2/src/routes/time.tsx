import { useRole } from '@/lib/role'
import { WorkerHoursScreen } from '@/screens/worker'
import { ApprovalQueueScreen, ForemanBatchEntryScreen } from '@/screens/foreman'

/**
 * Time tab — role-aware default per `Sitemap.html` § 03:
 *   - owner   → t-approve  (approval queue)        — 1D.3
 *   - foreman → t-foreman  (batch entry)           — 1E.2 (wired below)
 *   - worker  → wk-hours   (read-only personal)    — 1D.2
 *
 * Foreman lands on the batch-entry surface. The approval queue is
 * owner-only by default; foremen reach REOPEN actions when their
 * REJECT push a run back through the workflow event endpoint.
 */
export default function TimeRoute() {
  const role = useRole()

  if (role === 'worker') {
    return <WorkerHoursScreen />
  }

  if (role === 'foreman') {
    return <ForemanBatchEntryScreen />
  }

  return <ApprovalQueueScreen />
}
