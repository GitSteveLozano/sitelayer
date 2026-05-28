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
import { Route, Routes, useLocation } from 'react-router-dom'
import { Bell, Briefcase, Calendar, DollarSign, Home, type LucideProps, Package, Plus, Settings, Users, UserSquare } from 'lucide-react'
import type { ComponentType, SVGProps } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import { DShell, DSidebar, DTopbar, type DNavSection } from '@/components/d'
import { MButton } from '@/components/m'
import { OwnerDashboard } from './owner-dashboard'

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
}

function DComingSoon({ name }: { name: string }) {
  return (
    <div className="d-content">
      <div className="d-eyebrow">{name}</div>
      <div className="d-h1" style={{ marginTop: 10 }}>
        Desktop screen in progress.
      </div>
      <p style={{ color: 'var(--m-ink-3)', marginTop: 12, maxWidth: 520, lineHeight: 1.5 }}>
        This command-center view is being built (Desktop v2 · D2/D3). The mobile version of this
        screen is fully live today.
      </p>
    </div>
  )
}

export function DesktopWorkspace({ bootstrap = null }: { bootstrap?: BootstrapResponse | null }) {
  const location = useLocation()
  const crumb = CRUMB[location.pathname] ?? 'Sitelayer'

  return (
    <DShell sidebar={<DSidebar sections={OWNER_NAV} wearing="Owner" />}>
      <DTopbar
        crumb={crumb}
        actions={
          <>
            <MButton size="sm" variant="primary">
              <PlusIcon /> New project
            </MButton>
            <Bell aria-hidden width={20} height={20} />
            <span className="m-avatar" data-size="sm" aria-hidden>
              SL
            </span>
          </>
        }
      />
      <Routes>
        <Route index element={<OwnerDashboard bootstrap={bootstrap} />} />
        <Route path="projects" element={<DComingSoon name="Projects" />} />
        <Route path="schedule" element={<DComingSoon name="Schedule" />} />
        <Route path="money" element={<DComingSoon name="Money" />} />
        <Route path="approvals" element={<DComingSoon name="Approvals" />} />
        <Route path="team" element={<DComingSoon name="Team" />} />
        <Route path="clients" element={<DComingSoon name="Clients" />} />
        <Route path="rentals" element={<DComingSoon name="Rentals" />} />
        <Route path="settings" element={<DComingSoon name="Settings" />} />
        <Route path="*" element={<DComingSoon name="Screen" />} />
      </Routes>
    </DShell>
  )
}

function PlusIcon() {
  return <Plus aria-hidden width={16} height={16} />
}
