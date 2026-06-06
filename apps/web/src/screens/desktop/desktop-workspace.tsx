/**
 * Desktop v2 workspace shell — dark sidebar + breadcrumb topbar + content.
 *
 * Owner + estimator command center (>=1024px). Currently mounted at the
 * `/desktop` preview route while the per-screen desktop builds (D2/D3) land;
 * the production role+viewport gate in routes/workspace.tsx flips to this once
 * the owner screens exist, so we don't regress the working desktop experience
 * in the meantime. Workers stay on MobileShell always.
 *
 * Shares the data layer (hooks, entity APIs) and v2 tokens with mobile; only
 * the composition differs. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  Bell,
  Briefcase,
  Calendar,
  DollarSign,
  FileText,
  Home,
  Layers,
  Library,
  type LucideProps,
  MessageSquare,
  Package,
  Plus,
  Radio,
  Settings,
  Sparkles,
  Users,
  UserSquare,
} from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'
import { getActiveCompanySlug, queryKeys, request, type BootstrapResponse, type SessionResponse } from '@/lib/api'
import { ACTIVE_COMPANY_STORAGE_KEY } from '@/lib/api/client'
import type { MembershipsResponse } from '@/components/shell/CompanySwitcher'
// Lazy: the control-plane probe is an owner-only diagnostic. Keeping it out of
// the static graph holds the desktop-workspace lazy chunk under budget; it
// mounts after the dashboard paints.
const ControlPlaneProbe = lazy(() =>
  import('@/components/ControlPlaneProbe').then((m) => ({ default: m.ControlPlaneProbe })),
)
import { useNotificationFeed, useMarkNotificationRead, type NotificationRow } from '@/lib/api/notifications'
import { usePendingApprovalsSummary } from '@/lib/api/approvals'
import { useInventoryItems } from '@/lib/api/rentals'
import { useUserInitials, useUserFullName } from '@/lib/user'
import { normalizeMobileShellRole } from '@/lib/active-context'
import { registerCaptureStateProvider } from '@/lib/capture-state-providers'
import { membershipRoleToPersona, RoleContext, type Role } from '@/lib/role'
import {
  DCommandPalette,
  DMenu,
  DNotifPanel,
  DShell,
  DSidebar,
  DTopbar,
  useCommandPaletteHotkey,
  type DCommandGroup,
  type DNavSection,
  type DNotifGroup,
  type DNotifItem,
} from '@/components/d'
import { MButton } from '@/components/m'
// Phase B responsive consolidation: the AI takeoff/count screens are now single
// responsive screens living in the mobile (canonical) tree — they render the
// desktop layout at the `lg:` breakpoint. The former desktop twins
// (est-ai-takeoff.tsx / est-ai-count.tsx) were deleted.
import { TakeoffAiTakeoffSetup, TakeoffAiTakeoffReview } from '../mobile/takeoff-ai-takeoff'
import { TakeoffAiCountSetup, TakeoffAiCountReview } from '../mobile/takeoff-ai-count'
import { OwnerDashboard } from '../mobile/admin-home'
import { OwnerProjects } from './owner-projects'
import { OwnerTeam } from './owner-team'
import { OwnerApprovals } from './owner-approvals'
import { OwnerClients } from '../mobile/clients'
import { OwnerMoney } from './owner-money'
import { OwnerJobCosts } from './est-actuals'
import { OwnerBudgetVariance } from './budget-variance'
import { FmConfirmDay } from './fm-confirm-day'
// Phase B responsive consolidation: the foreman desktop↔mobile twin pairs were
// merged into one responsive screen each (the canonical file is the mobile one).
// The desktop command center imports the desktop render from those merged files
// via the preserved `Fm*` aliases; the standalone screens/desktop/fm-*.tsx twin
// files were deleted.
import { FmToday } from '../mobile/foreman-today'
import { FmCrew } from '../mobile/foreman-crew'
import { FmTime } from '../mobile/foreman-time-entry'
import { FmBrief } from '../mobile/foreman-brief'
import { FmBlockerDetail } from '../mobile/foreman-blocker-detail'
import { FmLog } from '../mobile/foreman-log'
import { OwnerSchedule } from './owner-schedule'
import { OwnerRentals } from './owner-rentals'
import { OwnerRentalsAsset } from './owner-rentals-asset'
import { OwnerRentalsDispatch } from './owner-rentals-dispatch'
import { OwnerRentalsReturn } from './owner-rentals-return'
import { OwnerSettings } from './owner-settings'
import { OwnerProjectDetail } from './owner-project-detail'
import { EstTakeoffProjects } from './est-takeoff-projects'
import { EstAiQueue } from './est-ai-queue'
import { EstItemLibrary } from './est-item-library'
import { EstCostLibrary } from './est-cost-library'
import { EstAssemblies } from './est-assemblies'
import { EstClientProfile } from './est-client-profile'
import { EstQuantities } from './est-quantities'
import { EstScaleVerify } from './est-scale-verify'
// Plan ingest is now ONE responsive screen (Phase B merge); the desktop layout
// renders at the `lg:` breakpoint inside the canonical mobile file.
// (FmToday/FmCrew are imported above from the merged foreman mobile screens.)
import { TakeoffIngest } from '../mobile/takeoff-ingest'
import { EstCanvas } from './est-canvas'
import { FmSchedule } from './fm-schedule'
import { OwnerRentalsUtilization } from './owner-rentals-utilization'
import { OwnerNewProject } from '../mobile/project-new'
import { OwnerMessages } from './owner-messages'
// Phase B responsive consolidation: the owner desktop↔mobile twin pairs
// (clients, broadcast, activity, new-project, dashboard) were merged into one
// responsive screen each (canonical file = the mobile one). The desktop
// command center imports the desktop render via the preserved `Owner*`
// aliases re-exported from those merged mobile files; the standalone
// screens/desktop/owner-*.tsx twins were deleted.
import { OwnerActivity } from '../mobile/activity-log'
import { OwnerBroadcast } from '../mobile/broadcast'

// lucide icons type as LucideProps; the DNavItem icon slot wants SVGProps.
const asIcon = (C: ComponentType<LucideProps>) => C as unknown as ComponentType<SVGProps<SVGSVGElement>>

const OWNER_NAV: DNavSection[] = [
  {
    title: 'Work',
    items: [
      { to: '/desktop', label: 'Dashboard', icon: asIcon(Home), end: true },
      { to: '/desktop/projects', label: 'Projects', icon: asIcon(Briefcase) },
      { to: '/desktop/schedule', label: 'Schedule', icon: asIcon(Calendar) },
    ],
  },
  {
    title: 'Money + People',
    items: [
      { to: '/desktop/money', label: 'Money', icon: asIcon(DollarSign) },
      { to: '/desktop/job-costs', label: 'Job costs', icon: asIcon(DollarSign) },
      { to: '/desktop/approvals', label: 'Approvals', icon: asIcon(Users) },
      { to: '/desktop/team', label: 'Team', icon: asIcon(Users) },
      { to: '/desktop/clients', label: 'Clients', icon: asIcon(UserSquare) },
    ],
  },
  {
    title: 'Assets',
    items: [
      { to: '/desktop/rentals', label: 'Rentals', icon: asIcon(Package) },
      { to: '/desktop/settings', label: 'Settings', icon: asIcon(Settings) },
    ],
  },
  {
    title: 'Estimator',
    items: [
      { to: '/desktop/takeoff', label: 'Takeoff', icon: asIcon(Layers) },
      { to: '/desktop/ai-queue', label: 'AI Queue', icon: asIcon(Sparkles) },
      { to: '/desktop/item-library', label: 'Item Library', icon: asIcon(Library) },
      { to: '/desktop/cost-library', label: 'Cost Library', icon: asIcon(Library) },
      { to: '/desktop/assemblies', label: 'Assemblies', icon: asIcon(Package) },
    ],
  },
  {
    title: 'Comms',
    items: [
      { to: '/desktop/messages', label: 'Messages', icon: asIcon(MessageSquare) },
      { to: '/desktop/broadcast', label: 'Broadcast', icon: asIcon(Radio) },
      { to: '/desktop/activity', label: 'Activity', icon: asIcon(Activity) },
    ],
  },
  {
    title: 'Foreman',
    items: [
      { to: '/desktop/fm/today', label: 'FM Today', icon: asIcon(Home) },
      { to: '/desktop/fm/crew', label: 'FM Crew', icon: asIcon(Users) },
      { to: '/desktop/fm/schedule', label: 'FM Schedule', icon: asIcon(Calendar) },
      { to: '/desktop/fm/time', label: 'FM Time', icon: asIcon(Calendar) },
      { to: '/desktop/fm/confirm', label: 'FM Confirm Day', icon: asIcon(Calendar) },
      { to: '/desktop/fm/log', label: 'FM Log', icon: asIcon(FileText) },
    ],
  },
]

const CRUMB: Record<string, string> = {
  '/desktop': 'Dashboard',
  '/desktop/projects': 'Projects',
  '/desktop/schedule': 'Schedule',
  '/desktop/money': 'Money',
  '/desktop/approvals': 'Approvals',
  '/desktop/team': 'Team',
  '/desktop/clients': 'Clients',
  '/desktop/rentals': 'Rentals',
  '/desktop/settings': 'Settings',
  '/desktop/takeoff': 'Takeoff',
  '/desktop/ai-queue': 'AI Queue',
  '/desktop/item-library': 'Item Library',
  '/desktop/cost-library': 'Cost Library',
  '/desktop/assemblies': 'Assemblies',
  '/desktop/fm/today': 'Foreman · Today',
  '/desktop/fm/crew': 'Foreman · Crew',
  '/desktop/fm/schedule': 'Foreman · Schedule',
  '/desktop/fm/time': 'Foreman · Time',
  '/desktop/fm/log': 'Foreman · Daily Log',
  '/desktop/projects/new': 'New project',
  '/desktop/rentals/utilization': 'Rentals · Utilization',
  '/desktop/messages': 'Comms · Messages',
  '/desktop/broadcast': 'Comms · Broadcast',
  '/desktop/activity': 'Comms · Activity',
}

// Dynamic rentals sub-routes (asset detail / dispatch / return) want a
// screen-specific contextual breadcrumb ('RENTALS · SCAFFOLD A · DISPATCH')
// rather than the static exact-pathname CRUMB fallback ('Sitelayer'). Resolve
// the asset segment + action label from the pathname; the asset code is looked
// up from the inventory catalog when loaded (falls back to the bare 'Rentals ·
// Asset' shape while items are still in flight).
function resolveRentalsCrumb(pathname: string, assetCode: string | null): string | null {
  const match = /^\/desktop\/rentals\/([^/]+)(?:\/([^/]+))?\/?$/.exec(pathname)
  if (!match) return null
  const [, segment, action] = match
  // /desktop/rentals/utilization is a static (non-dynamic) route handled by CRUMB.
  if (segment === 'utilization') return null
  const asset = assetCode ?? 'Asset'
  const actionLabel = action === 'dispatch' ? 'Dispatch' : action === 'return' ? 'Return' : 'Detail'
  return `Rentals · ${asset} · ${actionLabel}`
}

// Project-/client-anchored dynamic routes (projects/:id, estimate/:id,
// scale/:id, canvas/:id, ai-takeoff/:id[/review], ai-count/:id[/review],
// fm/brief/:id, clients/:id) otherwise fall through to the static CRUMB map
// and land on the bare 'Sitelayer' fallback. Resolve a section label + the
// entity's display name (project or client name from the warm bootstrap cache)
// so deep desktop routes show a proper contextual crumb. Falls back to a
// generic 'Project'/'Client' label while bootstrap is still in flight or the
// entity isn't in the cached payload (e.g. a freshly created row).
const DYNAMIC_ROUTE_PATTERNS: Array<{ re: RegExp; section: string; entity: 'project' | 'client' }> = [
  { re: /^\/desktop\/projects\/([^/]+)\/?$/, section: 'Projects', entity: 'project' },
  { re: /^\/desktop\/estimate\/([^/]+)\/?$/, section: 'Takeoff · Quantities', entity: 'project' },
  { re: /^\/desktop\/scale\/([^/]+)\/?$/, section: 'Takeoff · Verify scale', entity: 'project' },
  { re: /^\/desktop\/canvas\/([^/]+)\/?$/, section: 'Takeoff · Canvas', entity: 'project' },
  { re: /^\/desktop\/ai-takeoff\/([^/]+)\/review\/?$/, section: 'AI Takeoff · Review', entity: 'project' },
  { re: /^\/desktop\/ai-takeoff\/([^/]+)\/?$/, section: 'AI Takeoff', entity: 'project' },
  { re: /^\/desktop\/ai-count\/([^/]+)\/review\/?$/, section: 'AI Count · Review', entity: 'project' },
  { re: /^\/desktop\/ai-count\/([^/]+)\/?$/, section: 'AI Count', entity: 'project' },
  { re: /^\/desktop\/fm\/brief\/([^/]+)\/?$/, section: 'Foreman · Brief', entity: 'project' },
  { re: /^\/desktop\/clients\/([^/]+)\/?$/, section: 'Clients', entity: 'client' },
]

function resolveEntityCrumb(
  pathname: string,
  projectName: Map<string, string>,
  clientName: Map<string, string>,
): string | null {
  for (const { re, section, entity } of DYNAMIC_ROUTE_PATTERNS) {
    const match = re.exec(pathname)
    if (!match) continue
    const id = match[1] ?? ''
    const lookup = entity === 'project' ? projectName : clientName
    const name = lookup.get(id) ?? (entity === 'project' ? 'Project' : 'Client')
    return `${section} · ${name}`
  }
  return null
}

function DComingSoon({ name }: { name: string }) {
  return (
    <div className="d-content">
      <div className="d-eyebrow">{name}</div>
      <div className="d-h1" style={{ marginTop: 10 }}>
        Desktop screen in progress.
      </div>
      <p style={{ color: 'var(--m-ink-3)', marginTop: 12, maxWidth: 520, lineHeight: 1.5 }}>
        This command-center view is being built (Desktop v2 · D2/D3). The mobile version of this screen is fully live
        today.
      </p>
    </div>
  )
}

export function DesktopWorkspace({ bootstrap: bootstrapProp = null }: { bootstrap?: BootstrapResponse | null }) {
  const location = useLocation()
  const navigate = useNavigate()
  // Dashboard breadcrumb carries a today's day/date prefix per the design
  // ("MON · MAY 4 · DASHBOARD"); other sections keep the bare section label.
  const now = new Date()
  const dateCrumb = `${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][now.getDay()]} · ${
    ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][now.getMonth()]
  } ${now.getDate()}`
  // Inventory catalog backs the contextual rentals breadcrumb (asset code on
  // the dynamic /desktop/rentals/:itemId[/...] routes). Cached query, shared
  // with the rentals screens; only its `description`/`code` are read here.
  const inventoryItemsQuery = useInventoryItems()
  const rentalsItemMatch = /^\/desktop\/rentals\/([^/]+)/.exec(location.pathname)
  const rentalsItemId = rentalsItemMatch && rentalsItemMatch[1] !== 'utilization' ? rentalsItemMatch[1] : null
  const rentalsAssetCode = rentalsItemId
    ? ((inventoryItemsQuery.data?.inventoryItems ?? []).find((i) => i.id === rentalsItemId)?.code ?? null)
    : null
  const dynamicRentalsCrumb = resolveRentalsCrumb(location.pathname, rentalsAssetCode)
  // Plan-ingest is a dynamic /desktop/ingest/:projectId route (not in the
  // static CRUMB map). It reads as the "New takeoff" entry step (dsg__44/45).
  const ingestCrumb = /^\/desktop\/ingest\/[^/]+\/?$/.test(location.pathname) ? 'New takeoff · Reading plan set' : null
  const [wearingOpen, setWearingOpen] = useState(false)
  const [companyOpen, setCompanyOpen] = useState(false)
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [cmdkQuery, setCmdkQuery] = useState('')
  const [notifOpen, setNotifOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  useCommandPaletteHotkey(setCmdkOpen)

  // WEARING ▾ — solo operators switch which hat they're in. On the desktop
  // command center each hat routes to its home surface.
  const HATS: Array<{ key: string; label: string; letter: string; desc: string; to: string }> = [
    { key: 'owner', label: 'Owner', letter: 'O', desc: 'Business · money · approvals', to: '/desktop' },
    { key: 'estimator', label: 'Estimator', letter: 'E', desc: 'Takeoff · bids · clients', to: '/desktop/takeoff' },
    { key: 'foreman', label: 'Foreman', letter: 'F', desc: 'Crew · briefs · logs', to: '/desktop/fm/today' },
  ]
  // Which hat the operator is currently wearing, inferred from the route, so
  // the switch menu can show a selected indicator (design: TOPBAR ROLE SWITCHER).
  const activeHat = location.pathname.startsWith('/desktop/fm')
    ? 'foreman'
    : /\/desktop\/(takeoff|ai-queue|item-library|cost-library|assemblies|estimate|scale|ingest|canvas)/.test(
          location.pathname,
        )
      ? 'estimator'
      : 'owner'
  const goHat = (to: string) => {
    setWearingOpen(false)
    navigate(to)
  }

  // Self-fetch bootstrap when not passed (the /desktop route mounts this
  // standalone). When workspace.tsx redirects a desktop owner here, the
  // bootstrap query is already warm in the cache from CompanyWorkspace.
  const companySlug = getActiveCompanySlug()
  const bootstrapQuery = useQuery({
    queryKey: queryKeys.bootstrap(companySlug ?? ''),
    queryFn: () => request<BootstrapResponse>('/api/bootstrap', { companySlug: companySlug ?? undefined }),
    enabled: bootstrapProp === null && Boolean(companySlug),
  })
  const bootstrap = bootstrapProp ?? bootstrapQuery.data ?? null

  // Company switch — multi-company operators (a sub building for several GCs,
  // or the dev act-as fixtures that span tenants) need an in-app way to change
  // the active company. Desktop had none, so it lived only in localStorage. We
  // reuse the same `/api/me/memberships` source + localStorage-write+reload
  // contract as the mobile CompanySwitcher; the menu item only appears when
  // there's an actual choice (>= 2 companies).
  const membershipsQuery = useQuery<MembershipsResponse>({
    queryKey: ['me', 'memberships'],
    queryFn: () => request<MembershipsResponse>('/api/me/memberships'),
    staleTime: 5 * 60_000,
  })
  const memberships = membershipsQuery.data?.memberships ?? []
  const canSwitchCompany = memberships.length >= 2
  const switchCompany = (slug: string) => {
    setCompanyOpen(false)
    if (!slug || slug === companySlug) return
    try {
      window.localStorage.setItem(ACTIVE_COMPANY_STORAGE_KEY, slug)
    } catch {
      // localStorage can throw in private-browsing / sandboxed iframes; without
      // it the switch can't survive the reload, so bail rather than reload into
      // the old company silently.
      console.warn('[desktop-workspace] localStorage unavailable; cannot persist company switch')
      return
    }
    window.location.reload()
  }
  // Avatar initials: the signed-in user's name first (design shows 'MD' for
  // Mike Davis), then the active company mark, then the 'SL' fallback. The
  // user-name source is Clerk (`useUserInitials`); in local dev / before a
  // name is set it returns null and we fall through to the company initials.
  const userInitials = useUserInitials()
  // Identity-header display name for the avatar dropdown (design shows the
  // person's name "Mike Davis", not the company). Falls back to the company
  // name, then a generic mark, the same precedence as the avatar initials.
  const userFullName = useUserFullName()
  const avatarInitials =
    userInitials ||
    (bootstrap?.company?.name ?? '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() ||
    'SL'

  // Pending-approvals count → sidebar "Approvals" nav badge (design shows '3').
  // Same cheap rails (guardrails + open field requests) the dashboard KPI uses;
  // TanStack Query shares the cache so this adds no extra fetch.
  const projectName = useMemo(
    () => new Map((bootstrap?.projects ?? []).map((p) => [p.id, p.name])),
    [bootstrap?.projects],
  )
  // Customer roster → contextual crumb on the dynamic /desktop/clients/:id
  // route (and any other client-anchored deep route). Warm bootstrap cache,
  // same payload the ⌘K palette + clients screen read.
  const clientName = useMemo(
    () => new Map((bootstrap?.customers ?? []).map((c) => [c.id, c.name])),
    [bootstrap?.customers],
  )
  // Contextual breadcrumb for project-/client-anchored dynamic routes
  // (projects/:id, estimate/:id, scale/:id, canvas/:id, ai-takeoff/:id,
  // ai-count/:id, fm/brief/:id, clients/:id). Resolves the entity name from
  // the warm bootstrap maps; rentals + ingest keep their bespoke resolvers.
  const entityCrumb = resolveEntityCrumb(location.pathname, projectName, clientName)
  const sectionCrumb = ingestCrumb ?? dynamicRentalsCrumb ?? entityCrumb ?? CRUMB[location.pathname] ?? 'Sitelayer'
  const crumb = location.pathname === '/desktop' ? `${dateCrumb} · ${sectionCrumb}` : sectionCrumb
  const probeRoute = useMemo(() => parseDesktopProbeRoute(location.pathname), [location.pathname])
  const activeProjectName = probeRoute.projectId ? (projectName.get(probeRoute.projectId) ?? null) : null
  const pendingApprovals = usePendingApprovalsSummary(projectName)
  const navSections = useMemo<DNavSection[]>(
    () =>
      OWNER_NAV.map((section) => ({
        ...section,
        items: section.items.map((item) =>
          item.to === '/desktop/approvals'
            ? { ...item, badge: pendingApprovals.count > 0 ? pendingApprovals.count : undefined }
            : item,
        ),
      })),
    [pendingApprovals.count],
  )

  // RoleContext for the desktop command-center tree. App.tsx mounts this
  // surface directly at `/desktop/*` (NOT through routes/workspace.tsx), so
  // without this provider every role-gated control underneath falls back to
  // `useRole()`'s default `'worker'` — which hides owner/foreman affordances
  // like the est-canvas "Upload blueprint" button. Resolve the persona from
  // the real session membership role the same way CompanyWorkspace does.
  // The desktop surface is owner-gated (workspace.tsx only sends owners here),
  // so the safe default while the session loads is `'owner'`. Shares the same
  // `['session', slug]` cache key as CompanyWorkspace, so when a redirected
  // owner lands here the role is already warm. The local act-as / role
  // override still wins inside `useRole()`, keeping the dev RoleSwitcher and
  // the WEARING hat-switch's route navigation intact.
  const sessionQuery = useQuery({
    queryKey: queryKeys.session(companySlug ?? ''),
    queryFn: () => request<SessionResponse>('/api/session', { companySlug: companySlug ?? undefined }),
    enabled: Boolean(companySlug),
  })
  const session = sessionQuery.data ?? null
  const sessionRole =
    session?.memberships?.find((membership) => membership.slug === companySlug)?.role ?? session?.user?.role ?? null
  const persona = useMemo<Role>(() => {
    if (sessionRole === null) return 'owner'
    const companyRole = normalizeMobileShellRole(sessionRole)
    return companyRole === 'admin' || companyRole === 'office' ? 'owner' : membershipRoleToPersona(companyRole)
  }, [sessionRole])

  // Redacted state-provider for the desktop workspace shell — the surface a
  // reviewer (e.g. Steve) lands on by default (`/desktop`), which previously
  // captured no operator context on feedback submit (G10). Snapshots only the
  // active route + human section label + persona/role + active project, so a
  // capture from any `/desktop/*` route carries "where the reviewer was".
  // Low-PII; the registry sanitizer strips sensitive keys + caps strings.
  useEffect(() => {
    return registerCaptureStateProvider('desktop-workspace', ({ reason }) => ({
      schema: 'sitelayer.capture.desktop-workspace.v1',
      kind: 'state_snapshot',
      piiLevel: 'internal',
      payload: {
        reason,
        route_path: location.pathname,
        section: sectionCrumb,
        crumb,
        persona,
        session_role: sessionRole,
        active_project_id: probeRoute.projectId ?? null,
        active_project_name: activeProjectName,
        pending_approvals: pendingApprovals.count,
      },
    }))
  }, [
    location.pathname,
    sectionCrumb,
    crumb,
    persona,
    sessionRole,
    probeRoute.projectId,
    activeProjectName,
    pendingApprovals.count,
  ])

  // ⌘K command palette — fuzzy over projects/clients/items + nav targets.
  const q = cmdkQuery.trim().toLowerCase()
  const has = (s: string | null | undefined) => !q || (s ?? '').toLowerCase().includes(q)
  const closeCmdk = (to: string) => {
    setCmdkOpen(false)
    setCmdkQuery('')
    navigate(to)
  }
  const cmdkGroups: DCommandGroup[] = [
    {
      label: 'Projects',
      items: (bootstrap?.projects ?? [])
        .filter((p) => has(p.name) || has(p.customer_name))
        .slice(0, 6)
        .map((p) => ({
          id: `proj-${p.id}`,
          label: p.name,
          hint: p.customer_name ?? undefined,
          onSelect: () => closeCmdk(`/desktop/projects/${p.id}`),
        })),
    },
    {
      label: 'Clients',
      items: (bootstrap?.customers ?? [])
        .filter((c) => !c.deleted_at && has(c.name))
        .slice(0, 5)
        .map((c) => ({ id: `cust-${c.id}`, label: c.name, onSelect: () => closeCmdk('/desktop/clients') })),
    },
    {
      label: 'Items',
      items: (bootstrap?.serviceItems ?? [])
        .filter((it) => has(it.name) || has(it.code))
        .slice(0, 5)
        .map((it) => ({
          id: `item-${it.code}`,
          label: it.name,
          hint: it.code,
          onSelect: () => closeCmdk('/desktop/item-library'),
        })),
    },
    {
      label: 'Go to',
      items: [
        { id: 'go-dash', label: 'Dashboard', to: '/desktop' },
        { id: 'go-projects', label: 'Projects', to: '/desktop/projects' },
        { id: 'go-money', label: 'Money', to: '/desktop/money' },
        { id: 'go-schedule', label: 'Schedule', to: '/desktop/schedule' },
        { id: 'go-takeoff', label: 'Takeoff', to: '/desktop/takeoff' },
        { id: 'go-cost-library', label: 'Cost Library', to: '/desktop/cost-library' },
        { id: 'go-settings', label: 'Settings', to: '/desktop/settings' },
      ]
        .filter((i) => has(i.label))
        .map((i) => ({ id: i.id, label: i.label, onSelect: () => closeCmdk(i.to) })),
    },
  ]
  // Real recipient feed for the topbar bell (replaces the hardcoded
  // placeholder). Grouped URGENT / TODAY / THIS WEEK per the design
  // (dsg__66), with a colored left bar tone (red for action-needed /
  // failures, green for cleared/synced wins) and an unread-count badge.
  const notifFeed = useNotificationFeed({ limit: 20 })
  const notifRows: NotificationRow[] = notifFeed.data?.notifications ?? []
  const unreadRows = useMemo(() => notifRows.filter((n) => !n.read_at), [notifRows])
  const unreadCount = unreadRows.length
  const markAllRead = useMarkNotificationRead()
  const notifGroups: DNotifGroup[] = useMemo(() => {
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const startOfDayMs = startOfDay.getTime()
    // Design buckets: URGENT (unread + action-needed), TODAY (since
    // midnight), THIS WEEK (older, last ~7d). An unread row that signals an
    // action/failure goes to URGENT; everything else falls into the recency
    // bucket so the panel mirrors dsg__66's three-section shape.
    const buckets: Record<'URGENT' | 'TODAY' | 'THIS WEEK', DNotifItem[]> = {
      URGENT: [],
      TODAY: [],
      'THIS WEEK': [],
    }
    const toneFor = (n: NotificationRow): 'good' | 'bad' | null => {
      const text = `${n.kind} ${n.subject}`.toLowerCase()
      if ((n.state && n.state.startsWith('failed')) || n.failure_kind) return 'bad'
      if (/guardrail|over|auth|approval|blocker|lost|risk|escalat/.test(text)) return 'bad'
      if (/cleared|synced|paid|deposit|posted|approved|complete/.test(text)) return 'good'
      return null
    }
    for (const n of notifRows) {
      const tone = toneFor(n)
      const ts = new Date(n.created_at).getTime()
      const item: DNotifItem = {
        id: n.id,
        title: n.subject,
        meta: n.state && n.state.startsWith('failed') ? 'Delivery failed' : n.body_text || undefined,
        tone,
      }
      const urgent = !n.read_at && tone === 'bad'
      if (urgent) buckets.URGENT.push(item)
      else if (ts >= startOfDayMs) buckets.TODAY.push(item)
      else buckets['THIS WEEK'].push(item)
    }
    return (['URGENT', 'TODAY', 'THIS WEEK'] as const)
      .map((label) => ({ label, items: buckets[label] }))
      .filter((g) => g.items.length > 0)
  }, [notifRows])
  const handleMarkAll = () => {
    for (const n of unreadRows) markAllRead.mutate(n.id)
    setNotifOpen(false)
  }
  const signOut = () => {
    setAvatarOpen(false)
    const clerk = (window as unknown as { Clerk?: { signOut: (cb?: () => void) => void } }).Clerk
    if (clerk && typeof clerk.signOut === 'function') clerk.signOut(() => navigate('/sign-in'))
    else navigate('/sign-in')
  }

  return (
    <DShell
      sidebar={<DSidebar sections={navSections} wearing="Owner" onWearingClick={() => setWearingOpen((v) => !v)} />}
    >
      {wearingOpen ? (
        <div
          role="menu"
          aria-label="Switch hat"
          style={{
            position: 'fixed',
            left: 14,
            bottom: 64,
            width: 204,
            zIndex: 60,
            background: 'var(--m-sand)',
            border: '2px solid var(--m-ink)',
            boxShadow: 'var(--m-shadow-offset)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              padding: '10px 12px 6px',
            }}
          >
            Switch hat · {HATS.length} on desktop
          </div>
          {HATS.map((h) => {
            const selected = h.key === activeHat
            return (
              <button
                key={h.to}
                type="button"
                role="menuitem"
                aria-current={selected || undefined}
                onClick={() => goHat(h.to)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: selected ? 'var(--m-card-soft)' : 'transparent',
                  border: 'none',
                  borderTop: '1px solid var(--m-line-2)',
                  color: 'var(--m-ink)',
                  cursor: 'pointer',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    flex: '0 0 auto',
                    width: 26,
                    height: 26,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: selected ? 'var(--m-accent)' : 'var(--m-ink)',
                    color: selected ? 'var(--m-ink)' : 'var(--m-sand)',
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 800,
                    fontSize: 13,
                  }}
                >
                  {h.letter}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{ display: 'block', fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 15 }}
                  >
                    {h.label}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--m-ink-3)' }}>{h.desc}</span>
                </span>
                {selected ? (
                  <span aria-hidden style={{ color: 'var(--m-ink)', fontSize: 13 }}>
                    ●
                  </span>
                ) : null}
              </button>
            )
          })}
          {/* Footer: crew (jobsite) role lives only on the phone app, so it's
              not switchable here on desktop (design dsg__67). */}
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 9,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              padding: '10px 12px',
              borderTop: '1px solid var(--m-line-2)',
            }}
          >
            ● Crew (jobsite) lives on the phone app.
          </div>
        </div>
      ) : null}
      {companyOpen ? (
        <div
          role="menu"
          aria-label="Switch company"
          style={{
            position: 'fixed',
            top: 56,
            right: 24,
            width: 240,
            zIndex: 60,
            background: 'var(--m-sand)',
            border: '2px solid var(--m-ink)',
            boxShadow: 'var(--m-shadow-offset)',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 10,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              padding: '10px 12px 6px',
            }}
          >
            Switch company · {memberships.length}
          </div>
          {memberships.map((m) => {
            const selected = m.company_slug === companySlug
            return (
              <button
                key={m.company_id}
                type="button"
                role="menuitem"
                aria-current={selected || undefined}
                onClick={() => switchCompany(m.company_slug)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 12px',
                  background: selected ? 'var(--m-card-soft)' : 'transparent',
                  border: 'none',
                  borderTop: '1px solid var(--m-line-2)',
                  color: 'var(--m-ink)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{ display: 'block', fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 15 }}
                  >
                    {m.company_name}
                  </span>
                  <span style={{ display: 'block', fontSize: 11, color: 'var(--m-ink-3)' }}>{m.role}</span>
                </span>
                {selected ? (
                  <span aria-hidden style={{ color: 'var(--m-ink)', fontSize: 13 }}>
                    ●
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      ) : null}
      <DTopbar
        crumb={crumb}
        actions={
          <>
            <MButton size="sm" variant="quiet" onClick={() => setCmdkOpen(true)}>
              Search ⌘K
            </MButton>
            <MButton size="sm" variant="primary" onClick={() => navigate('/desktop/projects/new')}>
              <PlusIcon /> New project
            </MButton>
            <button
              type="button"
              aria-label="Notifications"
              onClick={() => setNotifOpen(true)}
              style={{
                position: 'relative',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                color: 'var(--m-ink)',
              }}
            >
              <Bell aria-hidden width={20} height={20} />
              {unreadCount > 0 ? (
                <span
                  aria-hidden
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -2,
                    width: 8,
                    height: 8,
                    background: 'var(--m-red)',
                  }}
                />
              ) : null}
            </button>
            <button
              type="button"
              aria-label="Account menu"
              onClick={() => setAvatarOpen((v) => !v)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              <span className="m-avatar" data-size="sm" aria-hidden>
                {avatarInitials}
              </span>
            </button>
          </>
        }
      />
      <DCommandPalette
        open={cmdkOpen}
        onClose={() => setCmdkOpen(false)}
        query={cmdkQuery}
        onQueryChange={setCmdkQuery}
        groups={cmdkGroups}
      />
      <DNotifPanel
        open={notifOpen}
        onClose={() => setNotifOpen(false)}
        groups={notifGroups}
        onMarkAll={handleMarkAll}
      />
      <DMenu
        open={avatarOpen}
        onClose={() => setAvatarOpen(false)}
        label="Account"
        style={{ top: 56, right: 24, width: 240 }}
      >
        <div
          style={{
            padding: '14px 16px',
            borderBottom: '2px solid var(--m-ink)',
            background: 'var(--m-card-soft)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span className="m-avatar" data-size="sm" aria-hidden>
            {avatarInitials}
          </span>
          <div>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>
              {userFullName ?? bootstrap?.company?.name ?? 'Sitelayer'}
            </div>
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 9, color: 'var(--m-ink-3)', marginTop: 2 }}>
              {activeHat.toUpperCase()} · ALL HATS
            </div>
          </div>
        </div>
        {[
          {
            label: 'Profile',
            sub: 'Settings · Profile',
            onClick: () => {
              setAvatarOpen(false)
              navigate('/desktop/settings')
            },
            danger: false,
          },
          {
            label: 'Switch role',
            sub: `${HATS.length} hats on desktop`,
            onClick: () => {
              setAvatarOpen(false)
              setWearingOpen(true)
            },
            danger: false,
          },
          ...(canSwitchCompany
            ? [
                {
                  label: 'Switch company',
                  sub: `${memberships.length} companies`,
                  onClick: () => {
                    setAvatarOpen(false)
                    setCompanyOpen(true)
                  },
                  danger: false,
                },
              ]
            : []),
          { label: 'Sign out', sub: undefined, onClick: signOut, danger: true },
        ].map((it) => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            onClick={it.onClick}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '12px 16px',
              background: 'transparent',
              border: 'none',
              borderTop: '1px solid var(--m-line-2)',
              cursor: 'pointer',
              fontFamily: 'var(--m-font-display)',
              fontWeight: 700,
              fontSize: 15,
              color: it.danger ? 'var(--m-red)' : 'var(--m-ink)',
            }}
          >
            {it.label}
            {it.sub ? (
              <span
                style={{
                  display: 'block',
                  fontFamily: 'var(--m-num)',
                  fontWeight: 600,
                  fontSize: 9,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--m-ink-3)',
                  marginTop: 2,
                }}
              >
                {it.sub}
              </span>
            ) : null}
          </button>
        ))}
      </DMenu>
      <RoleContext.Provider value={persona}>
        <Suspense fallback={null}>
          <ControlPlaneProbe
            companySlug={companySlug ?? ''}
            projectId={probeRoute.projectId}
            currentTab={probeRoute.currentTab}
            userRole={sessionRole}
            activeProjectName={activeProjectName}
            projectState={null}
            timeReviewState={null}
            billingReviewState={null}
          />
        </Suspense>
        {/* Command-center route table. Phase D mounts this shell as the
            `/desktop` section of the unified AppShell (screens/app-shell.tsx) —
            ONE shell resolves identity once and dispatches here for the command
            center, or to the field shell otherwise. The table stays inline (and
            this whole file stays its own lazy chunk) so the owner/estimator
            command-center code never weighs on the field bundle. */}
        <Routes>
          <Route index element={<OwnerDashboard bootstrap={bootstrap} />} />
          <Route path="projects" element={<OwnerProjects bootstrap={bootstrap} />} />
          <Route path="projects/new" element={<OwnerNewProject bootstrap={bootstrap} />} />
          <Route path="projects/:projectId" element={<OwnerProjectDetail bootstrap={bootstrap} />} />
          <Route path="rentals/utilization" element={<OwnerRentalsUtilization />} />
          <Route path="rentals/:itemId" element={<OwnerRentalsAsset />} />
          <Route path="rentals/:itemId/dispatch" element={<OwnerRentalsDispatch bootstrap={bootstrap} />} />
          <Route path="rentals/:itemId/return" element={<OwnerRentalsReturn />} />
          <Route path="fm/log" element={<FmLog bootstrap={bootstrap} />} />
          <Route path="messages" element={<OwnerMessages bootstrap={bootstrap} />} />
          <Route path="broadcast" element={<OwnerBroadcast />} />
          <Route path="activity" element={<OwnerActivity />} />
          <Route path="schedule" element={<OwnerSchedule bootstrap={bootstrap} />} />
          <Route path="money" element={<OwnerMoney bootstrap={bootstrap} />} />
          <Route path="job-costs" element={<OwnerJobCosts />} />
          <Route path="approvals" element={<OwnerApprovals bootstrap={bootstrap} />} />
          <Route path="team" element={<OwnerTeam bootstrap={bootstrap} />} />
          <Route path="clients" element={<OwnerClients />} />
          <Route path="rentals" element={<OwnerRentals />} />
          <Route path="settings" element={<OwnerSettings />} />
          <Route path="takeoff" element={<EstTakeoffProjects bootstrap={bootstrap} />} />
          <Route path="ai-queue" element={<EstAiQueue bootstrap={bootstrap} />} />
          <Route path="item-library" element={<EstItemLibrary />} />
          <Route path="cost-library" element={<EstCostLibrary />} />
          <Route path="assemblies" element={<EstAssemblies />} />
          <Route path="clients/:clientId" element={<EstClientProfile />} />
          <Route path="estimate/:projectId" element={<EstQuantities />} />
          <Route path="budget/:projectId" element={<OwnerBudgetVariance />} />
          <Route path="ingest/:projectId" element={<TakeoffIngest />} />
          <Route path="scale/:projectId" element={<EstScaleVerify />} />
          <Route path="canvas/:projectId" element={<EstCanvas />} />
          <Route path="fm/today" element={<FmToday bootstrap={bootstrap} companySlug={companySlug ?? ''} />} />
          <Route path="fm/crew" element={<FmCrew bootstrap={bootstrap} />} />
          <Route path="fm/schedule" element={<FmSchedule bootstrap={bootstrap} />} />
          <Route path="fm/time" element={<FmTime bootstrap={bootstrap} />} />
          <Route path="fm/confirm" element={<FmConfirmDay bootstrap={bootstrap} />} />
          <Route path="fm/brief/:projectId" element={<FmBrief />} />
          <Route
            path="fm/blocker/:issueId"
            element={<FmBlockerDetail bootstrap={bootstrap} companySlug={companySlug ?? ''} />}
          />
          <Route path="ai-takeoff/:projectId" element={<TakeoffAiTakeoffSetup companySlug={companySlug ?? ''} />} />
          <Route
            path="ai-takeoff/:projectId/review"
            element={<TakeoffAiTakeoffReview companySlug={companySlug ?? ''} />}
          />
          <Route path="ai-count/:projectId" element={<TakeoffAiCountSetup companySlug={companySlug ?? ''} />} />
          <Route path="ai-count/:projectId/review" element={<TakeoffAiCountReview companySlug={companySlug ?? ''} />} />
          <Route path="*" element={<DComingSoon name="Screen" />} />
        </Routes>
      </RoleContext.Provider>
    </DShell>
  )
}

function parseDesktopProbeRoute(pathname: string): { projectId: string | null; currentTab: string | null } {
  const segments = pathname.split('/').filter(Boolean)
  const [, section, id] = segments
  const projectSections = new Set(['projects', 'estimate', 'ingest', 'scale', 'canvas', 'ai-takeoff', 'ai-count'])
  return {
    currentTab: section ?? null,
    projectId: section && projectSections.has(section) && id ? id : null,
  }
}

function PlusIcon() {
  return <Plus aria-hidden width={16} height={16} />
}
