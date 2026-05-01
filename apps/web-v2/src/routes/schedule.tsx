import { ScheduleScreen } from '@/screens/projects/schedule'

/**
 * `/schedule` — workspace-wide schedule destination from More tab.
 *
 * Per-project schedule is also reachable via prj-detail's Schedule
 * sub-tab; this is the top-level surface that shows everything
 * across the company.
 */
export default function ScheduleRoute() {
  return <ScheduleScreen />
}
