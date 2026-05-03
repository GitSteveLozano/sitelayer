import { Briefcase, Calendar, Grid3x3, Home, Package } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

export interface TabDef {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

/**
 * The five permanent tabs from `Sitemap.html` § 02 panel 1. Order is
 * canonical: Home / Projects / Schedule / Rentals / More. Time was
 * demoted out of the tab bar in the updated sitemap — it's still a
 * primary destination via the drawer + More tab.
 *
 * Settings was demoted to a More row in the design — don't add it
 * back as a sixth tab.
 */
export const TABS: ReadonlyArray<TabDef> = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/projects', label: 'Projects', icon: Briefcase },
  { to: '/schedule', label: 'Schedule', icon: Calendar },
  { to: '/rentals', label: 'Rentals', icon: Package },
  { to: '/more', label: 'More', icon: Grid3x3 },
]
