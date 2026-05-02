import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Avatar, Card, Row } from '@/components/mobile'
import { ProjectSwitcherSheet } from '@/components/nav/ProjectSwitcherSheet'
import { WORKFLOW_NAV, WORKSPACE_NAV } from '@/components/nav/nav-items'
import { useOnlineStatus } from '@/lib/offline/online-status'
import { useRole, writeRoleOverride, type Role } from '@/lib/role'
import { NotificationPreferencesScreen } from './notifications'
import { PushOnboardingCard } from './push-onboarding'

export { CatalogHubScreen } from './catalog-hub'
export { CatalogCustomersScreen } from './catalog-customers'
export { CatalogWorkersScreen } from './catalog-workers'
export { CatalogServiceItemsScreen } from './catalog-service-items'
export { CatalogPricingProfilesScreen } from './catalog-pricing-profiles'
export { CatalogBonusRulesScreen } from './catalog-bonus-rules'
export { CatalogDivisionsScreen } from './catalog-divisions'
export { BonusSimulatorScreen } from './bonus-sim'
export { AuditLogScreen } from './audit-log'

const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner / PM',
  foreman: 'Foreman',
  worker: 'Worker',
}

/**
 * More tab — Sitemap.html § 02 panel 5 ("More · 5th slot").
 *
 * Layout from the design:
 *   - Page title "More · Everything else"
 *   - User identity card (avatar / name / role · org / synced)
 *   - WORKFLOW group: Takeoff, Estimates, Schedule, Crews — fast jumps
 *     into operational surfaces that don't have a dedicated tab.
 *   - WORKSPACE group: Catalog, Integrations, Inventory, Bonus sim, Audit.
 *   - YOU group: Notifications + Persona override (dev).
 *
 * Workflow + workspace rows read from `nav-items.ts`; the same
 * registry powers `NavDrawer` so the two surfaces stay aligned.
 */
export function SettingsScreen() {
  const role = useRole()
  const online = useOnlineStatus()
  const [section, setSection] = useState<'home' | 'notifications'>('home')
  const [switcherOpen, setSwitcherOpen] = useState(false)

  if (section === 'notifications') {
    return (
      <div>
        <button
          type="button"
          onClick={() => setSection('home')}
          className="text-[13px] text-accent font-medium px-5 pt-5"
        >
          ← Back
        </button>
        <NotificationPreferencesScreen />
      </div>
    )
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">More</div>
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">
        Everything else
      </h1>

      {/* User identity card — taps open the project switcher per panel 4 */}
      <button
        type="button"
        onClick={() => setSwitcherOpen(true)}
        className="mt-5 w-full text-left rounded-[16px] bg-card-soft px-4 py-4 flex items-center gap-3 active:bg-line/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Avatar size="lg" tone="amber" initials="ME" />
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold tracking-tight truncate">Signed-in user</div>
          <div className="text-[11px] text-ink-3 truncate mt-0.5">{ROLE_LABEL[role]} · Sitelayer</div>
          <div className="mt-1.5 inline-flex items-center gap-1.5 text-[11px]">
            <span
              aria-hidden="true"
              className={`inline-block w-1.5 h-1.5 rounded-full ${online ? 'bg-good' : 'bg-warn'}`}
            />
            <span className={online ? 'text-good' : 'text-warn'}>
              {online ? 'Synced' : 'Offline · queued'}
            </span>
          </div>
        </div>
        <span aria-hidden="true" className="text-ink-4 text-[18px]">›</span>
      </button>

      {/* WORKFLOW group */}
      <NavGroup title="Workflow" rows={WORKFLOW_NAV} />

      {/* WORKSPACE group */}
      <NavGroup title="Workspace" rows={WORKSPACE_NAV} />

      {/* YOU group */}
      <div className="mt-6">
        <div className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">You</div>
        <Card>
          <PushOnboardingCard />
          <button type="button" onClick={() => setSection('notifications')} className="block w-full text-left mt-3">
            <Row
              headline="Notification preferences"
              supporting="Pick push / SMS / email per event type."
              chev
              noBorder
            />
          </button>
          <RoleOverrideCard currentRole={role} />
        </Card>
      </div>

      <ProjectSwitcherSheet open={switcherOpen} onClose={() => setSwitcherOpen(false)} />
    </div>
  )
}

function NavGroup({
  title,
  rows,
}: {
  title: string
  rows: ReadonlyArray<{ key: string; to: string; label: string; icon: React.ComponentType<React.SVGProps<SVGSVGElement>> }>
}) {
  return (
    <div className="mt-6">
      <div className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">{title}</div>
      <Card tight>
        <ul className="-mx-3 -my-2">
          {rows.map((r, i) => (
            <li key={r.key}>
              <Link to={r.to} className="block">
                <Row
                  leading={<r.icon width={18} height={18} strokeWidth={1.8} />}
                  leadingTone="accent"
                  headline={r.label}
                  chev
                  noBorder={i === rows.length - 1}
                />
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}

/**
 * Persona override card — dev / preview convenience until Clerk org
 * memberships drive role assignment in Phase 1D.4 / 2.
 *
 * Survives sign-out (localStorage) so the dev user can refresh and
 * keep their picked persona.
 */
function RoleOverrideCard({ currentRole }: { currentRole: Role }) {
  const apply = (role: Role | null) => {
    writeRoleOverride(role)
    window.location.reload()
  }
  const ROLES: ReadonlyArray<{ value: Role; label: string; detail: string }> = [
    { value: 'owner', label: 'Owner / PM', detail: 'Calm dashboard, time approvals, all surfaces.' },
    { value: 'foreman', label: 'Foreman', detail: 'Crew check-in, daily log, approval queue.' },
    { value: 'worker', label: 'Worker', detail: 'Today, hours, week.' },
  ]

  return (
    <div className="mt-3 pt-3 border-t border-line">
      <div className="text-[14px] font-semibold">Persona override (dev)</div>
      <div className="text-[12px] text-ink-3 mt-1 mb-3">
        Until Clerk org-membership wiring lands, pick the persona you want to preview. Stored locally; cleared by
        signing out.
      </div>
      <div className="flex flex-wrap gap-2">
        {ROLES.map((r) => (
          <button
            key={r.value}
            type="button"
            onClick={() => apply(r.value)}
            className={`px-3.5 py-1.5 rounded-full text-[13px] font-medium border transition-colors ${
              currentRole === r.value
                ? 'bg-accent text-white border-transparent'
                : 'bg-card-soft text-ink-2 border-line'
            }`}
          >
            {r.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => apply(null)}
          className="px-3.5 py-1.5 rounded-full text-[13px] font-medium border border-line text-ink-3"
        >
          Clear
        </button>
      </div>
    </div>
  )
}
