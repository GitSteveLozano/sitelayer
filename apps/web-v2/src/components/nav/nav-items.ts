import {
  Briefcase,
  Calendar,
  ClipboardList,
  Clock,
  FileText,
  Home,
  Layers,
  Package,
  Plug,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Warehouse,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'

/**
 * Nav-item registry shared by `NavDrawer` (Sitemap §02 panel 3) and the
 * `MoreScreen` (panel 5). Both surfaces render the same destinations,
 * so they must read from one source.
 *
 * Group order matches the design:
 *   - PRIMARY  — the same five tabs as the bottom bar, always shown in
 *                the drawer so the drawer is a complete index of the IA.
 *   - WORKFLOW — operational shortcuts (Takeoff, Estimates, Schedule,
 *                Crews). These don't have their own tab — they hang off
 *                the project / time / live-crew screens.
 *   - WORKSPACE — admin-flavoured surfaces (Catalog / Integrations /
 *                Inventory admin / Bonus simulator / Audit).
 *   - YOU      — per-user prefs.
 */
export type NavGroupKey = 'primary' | 'workflow' | 'workspace' | 'you'

export interface NavItem {
  key: string
  to: string
  label: string
  /** Optional supporting line under the label (e.g. "18 active"). */
  detail?: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  /** Optional badge rendered as a pill on the right of the row. */
  badge?: string | number
}

export interface NavGroup {
  key: NavGroupKey
  /** Section title rendered above the rows. Omit for the primary group. */
  title?: string
  items: ReadonlyArray<NavItem>
}

export const PRIMARY_NAV: ReadonlyArray<NavItem> = [
  { key: 'home', to: '/', label: 'Today', icon: Home },
  { key: 'projects', to: '/projects', label: 'Projects', icon: Briefcase },
  { key: 'schedule', to: '/schedule', label: 'Schedule', icon: Calendar },
  { key: 'time', to: '/time', label: 'Time', icon: Clock },
  { key: 'rentals', to: '/rentals', label: 'Rentals', icon: Package },
]

export const WORKFLOW_NAV: ReadonlyArray<NavItem> = [
  { key: 'takeoff', to: '/projects?focus=takeoff', label: 'Takeoff', icon: Layers },
  { key: 'estimates', to: '/projects?focus=estimate', label: 'Estimates', icon: FileText },
  { key: 'schedule-w', to: '/schedule', label: 'Schedule', icon: Calendar },
  { key: 'crews', to: '/live-crew', label: 'Crews', icon: Users },
]

export const WORKSPACE_NAV: ReadonlyArray<NavItem> = [
  { key: 'catalog', to: '/more/catalog', label: 'Catalog', icon: ClipboardList },
  { key: 'integrations', to: '/more/integrations', label: 'Integrations', icon: Plug },
  { key: 'inventory', to: '/more/inventory', label: 'Inventory admin', icon: Warehouse },
  { key: 'bonus', to: '/more/bonus-sim', label: 'Bonus simulator', icon: SlidersHorizontal },
  { key: 'audit', to: '/more/audit', label: 'Audit log', icon: ShieldCheck },
]

export const YOU_NAV: ReadonlyArray<NavItem> = [
  { key: 'notifications', to: '/more', label: 'Notifications', icon: ScrollText },
  { key: 'settings', to: '/more', label: 'Settings', icon: SettingsIcon },
]

export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  { key: 'primary', items: PRIMARY_NAV },
  { key: 'workflow', title: 'Workflow', items: WORKFLOW_NAV },
  { key: 'workspace', title: 'Workspace', items: WORKSPACE_NAV },
  { key: 'you', title: 'You', items: YOU_NAV },
]
