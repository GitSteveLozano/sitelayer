import { Briefcase, Clock, Grid3x3, Home, Package } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

export interface TabDef {
  to: string
  label: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
}

/**
 * The five permanent tabs from `Sitemap.html` § 00. Order is canonical:
 * Home / Projects / Time / Rentals / More. Settings was demoted to a
 * More row in the design — don't add it back as a sixth tab.
 */
export const TABS: ReadonlyArray<TabDef> = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/projects', label: 'Projects', icon: Briefcase },
  { to: '/time', label: 'Time', icon: Clock },
  { to: '/rentals', label: 'Rentals', icon: Package },
  { to: '/more', label: 'More', icon: Grid3x3 },
]
