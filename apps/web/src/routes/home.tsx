import { useRole } from '@/lib/role'
import { WorkerTodayScreen } from '@/screens/worker'
import { ForemanTodayScreen } from '@/screens/foreman'
import { OwnerTodayScreen } from '@/screens/owner'

/**
 * Role-aware Home tab. Three Homes, three design IDs from `Sitemap.html`:
 *   - owner   → db-calm-default (Phase 2A — wired below)
 *   - foreman → fm-today-v2     (1D.3)
 *   - worker  → wk-today        (1D.2)
 */
export default function HomeRoute() {
  const role = useRole()

  if (role === 'worker') {
    return <WorkerTodayScreen />
  }

  if (role === 'foreman') {
    return <ForemanTodayScreen />
  }

  return <OwnerTodayScreen />
}
