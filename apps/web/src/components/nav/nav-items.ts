import {
  Activity,
  Bell,
  Briefcase,
  Calendar,
  CheckSquare,
  ClipboardList,
  Clock,
  DollarSign,
  FileText,
  Home,
  Layers,
  MessageSquare,
  Megaphone,
  Package,
  Plug,
  Receipt,
  Route,
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
 * Bottom-nav per the design audit: Home / Projects / Schedule /
 * Rentals / More. Time and Crew were demoted out of the bottom bar
 * but stay reachable via the drawer's primary list. /crew and /time
 * route to the same role-aware screen (cross-project queue / batch
 * entry / personal hours).
 *
 * Group order matches the design:
 *   - PRIMARY  — the bottom tabs plus drawer-only Crew + Time so the
 *                drawer is a complete index of the IA.
 *   - WORKFLOW — operational shortcuts (Measurements, Estimates,
 *                Live crew). These don't have their own tab.
 *   - WORKSPACE — admin-flavoured surfaces (Catalog / Integrations /
 *                Inventory admin / Bonus simulator / Audit).
 *   - YOU      — per-user prefs.
 */
export type NavGroupKey = 'primary' | 'workflow' | 'money-comms' | 'workspace' | 'you'

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
  { key: 'rentals', to: '/rentals', label: 'Rentals', icon: Package },
  { key: 'crew', to: '/crew', label: 'Crew', icon: Users },
  { key: 'time', to: '/time', label: 'Time', icon: Clock },
]

export const WORKFLOW_NAV: ReadonlyArray<NavItem> = [
  { key: 'work', to: '/work', label: 'Work queue', icon: ScrollText },
  { key: 'takeoff', to: '/projects?focus=takeoff', label: 'Measurements', icon: Layers },
  { key: 'estimates', to: '/projects?focus=estimate', label: 'Estimates', icon: FileText },
  { key: 'live-crew', to: '/live-crew', label: 'Live crew', icon: Users },
  { key: 'financial', to: '/financial', label: 'Financial', icon: Receipt },
  { key: 'assignments', to: '/projects/assignments', label: 'Assignments', icon: Users },
]

/**
 * Money & comms — owner-facing surfaces that were net-new in v2 and were
 * previously only reachable from the orphaned MobileSettingsHome. Surfacing
 * them in the More tab (the live admin "More" destination) is the fix for
 * the dead owner screens: Money / Clients / Messages / Broadcast / Activity /
 * Notifications / Approvals all resolve to routes registered in App.tsx
 * (or the shell, for Money). Owner-only IA, so this group is rendered for
 * the admin/owner persona.
 */
export const MONEY_COMMS_NAV: ReadonlyArray<NavItem> = [
  { key: 'money', to: '/money', label: 'Money', detail: 'Cash flow, net, pending', icon: DollarSign },
  { key: 'approvals', to: '/approvals', label: 'Approvals', detail: 'Owner authorization inbox', icon: CheckSquare },
  { key: 'clients', to: '/clients', label: 'Clients', detail: 'Profiles, lifetime value, win rate', icon: Users },
  { key: 'messages', to: '/chat', label: 'Messages', detail: 'Project chat threads', icon: MessageSquare },
  { key: 'broadcast', to: '/broadcast', label: 'Broadcast', detail: 'One-way crew announcement', icon: Megaphone },
  { key: 'activity', to: '/activity', label: 'Activity', detail: 'Company-wide audit timeline', icon: Activity },
  { key: 'notifications-inbox', to: '/notifications', label: 'Notifications', detail: 'Your inbox', icon: Bell },
]

export const WORKSPACE_NAV: ReadonlyArray<NavItem> = [
  { key: 'catalog', to: '/more/catalog', label: 'Catalog', icon: ClipboardList },
  { key: 'integrations', to: '/more/integrations', label: 'Integrations', icon: Plug },
  { key: 'inventory', to: '/more/inventory', label: 'Inventory admin', icon: Warehouse },
  { key: 'bonus', to: '/more/bonus-sim', label: 'Bonus simulator', icon: SlidersHorizontal },
  { key: 'audit', to: '/more/audit', label: 'Audit log', icon: ShieldCheck },
  { key: 'dispatch', to: '/more/dispatch-lanes', label: 'Dispatch lanes', icon: Route },
  { key: 'notify-queue', to: '/more/notifications-queue', label: 'Notification queue', icon: ScrollText },
]

export const YOU_NAV: ReadonlyArray<NavItem> = [
  { key: 'notifications', to: '/more', label: 'Notifications', icon: ScrollText },
  { key: 'settings', to: '/more', label: 'Settings', icon: SettingsIcon },
]

export const NAV_GROUPS: ReadonlyArray<NavGroup> = [
  { key: 'primary', items: PRIMARY_NAV },
  { key: 'workflow', title: 'Workflow', items: WORKFLOW_NAV },
  { key: 'money-comms', title: 'Money & comms', items: MONEY_COMMS_NAV },
  { key: 'workspace', title: 'Workspace', items: WORKSPACE_NAV },
  { key: 'you', title: 'You', items: YOU_NAV },
]
