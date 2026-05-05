import { Route, Routes } from 'react-router-dom'
import { useRole } from '@/lib/role'
import { WorkerHoursScreen } from '@/screens/worker'
import { ApprovalQueueScreen, ForemanBatchEntryScreen } from '@/screens/foreman'
import { OwnerLaborBurdenScreen, OwnerLiveVsBudgetScreen, OwnerTimeAnomaliesScreen } from '@/screens/owner'

/**
 * Time tab — role-aware default per `Sitemap.html` § 03:
 *   - owner   → t-approve  (approval queue)        — 1D.3
 *   - foreman → t-foreman  (batch entry)           — 1E.2
 *   - worker  → wk-hours   (read-only personal)    — 1D.2
 *
 * `/time/anomalies` is a sub-route the owner reaches from the
 * approval queue when the badge is non-zero.
 */
function TimeIndex() {
  const role = useRole()

  if (role === 'worker') {
    return <WorkerHoursScreen />
  }

  if (role === 'foreman') {
    return <ForemanBatchEntryScreen />
  }

  return <ApprovalQueueScreen />
}

export default function TimeRoute() {
  return (
    <Routes>
      <Route index element={<TimeIndex />} />
      <Route path="anomalies" element={<OwnerTimeAnomaliesScreen />} />
      <Route path="burden" element={<OwnerLaborBurdenScreen />} />
      <Route path="vs" element={<OwnerLiveVsBudgetScreen />} />
    </Routes>
  )
}
