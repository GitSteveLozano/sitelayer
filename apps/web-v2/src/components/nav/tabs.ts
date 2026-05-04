import { Briefcase, Calendar, Grid3x3, Home, Users } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

export interface TabDef {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

/**
 * The five permanent tabs from the post-audit IA: Home / Projects /
 * Schedule / Crew / More. Time and Rentals were demoted out of the
 * bottom bar — Time is reachable from the drawer (label "Time", route
 * /time which serves the same cross-project queue as Crew), Rentals
 * lives under More + the workspace nav group.
 */
export const TABS: ReadonlyArray<TabDef> = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/projects', label: 'Projects', icon: Briefcase },
  { to: '/schedule', label: 'Schedule', icon: Calendar },
  { to: '/crew', label: 'Crew', icon: Users },
  { to: '/more', label: 'More', icon: Grid3x3 },
]
