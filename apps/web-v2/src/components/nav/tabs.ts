import { Briefcase, Calendar, Grid3x3, Home, Package } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

export interface TabDef {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

/**
 * The five permanent tabs per the design audit: Home / Projects /
 * Schedule / Rentals / More. Time and Crew were demoted out of the
 * bottom bar — both stay reachable via the drawer's primary list and
 * via per-project surfaces (prj-detail Crew sub-tab links to
 * /time/burden and /time/vs).
 *
 * Note: `/crew` remains a valid route and renders the same role-aware
 * screen as `/time` (cross-project approval queue / batch entry /
 * personal hours). It just isn't a tab.
 */
export const TABS: ReadonlyArray<TabDef> = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/projects', label: 'Projects', icon: Briefcase },
  { to: '/schedule', label: 'Schedule', icon: Calendar },
  { to: '/rentals', label: 'Rentals', icon: Package },
  { to: '/more', label: 'More', icon: Grid3x3 },
]
