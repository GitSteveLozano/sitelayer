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
import { useState } from 'react'
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
import { getActiveCompanySlug, queryKeys, request, type BootstrapResponse } from '@/lib/api'
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
} from '@/components/d'
import { MButton } from '@/components/m'
import { EstAiTakeoffSetup, EstAiTakeoffReview } from './est-ai-takeoff'
import { EstAiCountSetup, EstAiCountReview } from './est-ai-count'
import { OwnerDashboard } from './owner-dashboard'
import { OwnerProjects } from './owner-projects'
import { OwnerTeam } from './owner-team'
import { OwnerApprovals } from './owner-approvals'
import { OwnerClients } from './owner-clients'
import { OwnerMoney } from './owner-money'
import { OwnerSchedule } from './owner-schedule'
import { OwnerRentals } from './owner-rentals'
import { OwnerSettings } from './owner-settings'
import { OwnerProjectDetail } from './owner-project-detail'
import { EstTakeoffProjects } from './est-takeoff-projects'
import { EstAiQueue } from './est-ai-queue'
import { EstItemLibrary } from './est-item-library'
import { EstClientProfile } from './est-client-profile'
import { EstQuantities } from './est-quantities'
import { EstScaleVerify } from './est-scale-verify'
import { FmToday } from './fm-today'
import { FmCrew } from './fm-crew'
import { EstCanvas } from './est-canvas'
import { FmSchedule } from './fm-schedule'
import { FmTime } from './fm-time'
import { FmBrief } from './fm-brief'
import { FmLog } from './fm-log'
import { OwnerRentalsUtilization } from './owner-rentals-utilization'
import { OwnerNewProject } from './owner-new-project'
import { OwnerMessages } from './owner-messages'
import { OwnerActivity } from './owner-activity'
import { OwnerBroadcast } from './owner-broadcast'

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
  const crumb = CRUMB[location.pathname] ?? 'Sitelayer'
  const [wearingOpen, setWearingOpen] = useState(false)
  const [cmdkOpen, setCmdkOpen] = useState(false)
  const [cmdkQuery, setCmdkQuery] = useState('')
  const [notifOpen, setNotifOpen] = useState(false)
  const [avatarOpen, setAvatarOpen] = useState(false)
  useCommandPaletteHotkey(setCmdkOpen)

  // WEARING ▾ — solo operators switch which hat they're in. On the desktop
  // command center each hat routes to its home surface.
  const HATS: Array<{ label: string; to: string }> = [
    { label: 'Owner', to: '/desktop' },
    { label: 'Estimator', to: '/desktop/takeoff' },
    { label: 'Foreman', to: '/desktop/fm/today' },
  ]
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
        { id: 'go-settings', label: 'Settings', to: '/desktop/settings' },
      ]
        .filter((i) => has(i.label))
        .map((i) => ({ id: i.id, label: i.label, onSelect: () => closeCmdk(i.to) })),
    },
  ]
  const notifGroups: DNotifGroup[] = [
    {
      label: 'Today',
      items: [{ id: 'welcome', title: 'Welcome to the command center', meta: 'Desktop v2', tone: null }],
    },
  ]
  const signOut = () => {
    setAvatarOpen(false)
    const clerk = (window as unknown as { Clerk?: { signOut: (cb?: () => void) => void } }).Clerk
    if (clerk && typeof clerk.signOut === 'function') clerk.signOut(() => navigate('/sign-in'))
    else navigate('/sign-in')
  }

  return (
    <DShell
      sidebar={<DSidebar sections={OWNER_NAV} wearing="Owner" onWearingClick={() => setWearingOpen((v) => !v)} />}
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
              padding: '10px 12px 4px',
            }}
          >
            Switch hat
          </div>
          {HATS.map((h) => (
            <button
              key={h.to}
              type="button"
              role="menuitem"
              onClick={() => goHat(h.to)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '10px 12px',
                background: 'transparent',
                border: 'none',
                borderTop: '1px solid var(--m-line-2)',
                fontFamily: 'var(--m-font-display)',
                fontWeight: 700,
                fontSize: 15,
                color: 'var(--m-ink)',
                cursor: 'pointer',
              }}
            >
              {h.label}
            </button>
          ))}
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
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                color: 'var(--m-ink)',
              }}
            >
              <Bell aria-hidden width={20} height={20} />
            </button>
            <button
              type="button"
              aria-label="Account menu"
              onClick={() => setAvatarOpen((v) => !v)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
            >
              <span className="m-avatar" data-size="sm" aria-hidden>
                SL
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
        onMarkAll={() => setNotifOpen(false)}
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
            SL
          </span>
          <div>
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 }}>
              {bootstrap?.company?.name ?? 'Sitelayer'}
            </div>
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 9, color: 'var(--m-ink-3)', marginTop: 2 }}>
              OWNER · ALL HATS
            </div>
          </div>
        </div>
        {[
          { label: 'Profile', onClick: () => goHat('/desktop'), danger: false },
          {
            label: 'Settings',
            onClick: () => {
              setAvatarOpen(false)
              navigate('/desktop/settings')
            },
            danger: false,
          },
          {
            label: 'Switch role',
            onClick: () => {
              setAvatarOpen(false)
              setWearingOpen(true)
            },
            danger: false,
          },
          { label: 'Sign out', onClick: signOut, danger: true },
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
          </button>
        ))}
      </DMenu>
      <Routes>
        <Route index element={<OwnerDashboard bootstrap={bootstrap} />} />
        <Route path="projects" element={<OwnerProjects bootstrap={bootstrap} />} />
        <Route path="projects/new" element={<OwnerNewProject />} />
        <Route path="projects/:projectId" element={<OwnerProjectDetail bootstrap={bootstrap} />} />
        <Route path="rentals/utilization" element={<OwnerRentalsUtilization />} />
        <Route path="fm/log" element={<FmLog bootstrap={bootstrap} />} />
        <Route path="messages" element={<OwnerMessages bootstrap={bootstrap} />} />
        <Route path="broadcast" element={<OwnerBroadcast />} />
        <Route path="activity" element={<OwnerActivity />} />
        <Route path="schedule" element={<OwnerSchedule bootstrap={bootstrap} />} />
        <Route path="money" element={<OwnerMoney bootstrap={bootstrap} />} />
        <Route path="approvals" element={<OwnerApprovals bootstrap={bootstrap} />} />
        <Route path="team" element={<OwnerTeam bootstrap={bootstrap} />} />
        <Route path="clients" element={<OwnerClients />} />
        <Route path="rentals" element={<OwnerRentals />} />
        <Route path="settings" element={<OwnerSettings />} />
        <Route path="takeoff" element={<EstTakeoffProjects bootstrap={bootstrap} />} />
        <Route path="ai-queue" element={<EstAiQueue bootstrap={bootstrap} />} />
        <Route path="item-library" element={<EstItemLibrary />} />
        <Route path="clients/:clientId" element={<EstClientProfile />} />
        <Route path="estimate/:projectId" element={<EstQuantities />} />
        <Route path="scale/:projectId" element={<EstScaleVerify />} />
        <Route path="canvas/:projectId" element={<EstCanvas />} />
        <Route path="fm/today" element={<FmToday bootstrap={bootstrap} />} />
        <Route path="fm/crew" element={<FmCrew bootstrap={bootstrap} />} />
        <Route path="fm/schedule" element={<FmSchedule bootstrap={bootstrap} />} />
        <Route path="fm/time" element={<FmTime bootstrap={bootstrap} />} />
        <Route path="fm/brief/:projectId" element={<FmBrief />} />
        <Route path="ai-takeoff/:projectId" element={<EstAiTakeoffSetup />} />
        <Route path="ai-takeoff/:projectId/review" element={<EstAiTakeoffReview />} />
        <Route path="ai-count/:projectId" element={<EstAiCountSetup />} />
        <Route path="ai-count/:projectId/review" element={<EstAiCountReview />} />
        <Route path="*" element={<DComingSoon name="Screen" />} />
      </Routes>
    </DShell>
  )
}

function PlusIcon() {
  return <Plus aria-hidden width={16} height={16} />
}
