import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/mobile'
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

/**
 * Settings hub — what the More tab points at.
 *
 * Sitemap.html § 05 lays out three groups: Workflow / Workspace / You.
 * Phase 1D.4 lands the You + Workspace surfaces wired to real APIs:
 *   - Push notifications onboarding
 *   - Notification channel preferences
 *   - Persona override (dev-only convenience until Clerk org wiring lands)
 *
 * Workflow shortcuts (jump-into-takeoff, jump-into-estimates, etc.)
 * land alongside the screens they jump into in Phase 2.
 */
export function SettingsScreen() {
  const role = useRole()
  const [section, setSection] = useState<'home' | 'notifications'>('home')

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
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Settings</h1>

      <div className="mt-6 space-y-3">
        <PushOnboardingCard />

        <button type="button" onClick={() => setSection('notifications')} className="block w-full text-left">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[14px] font-semibold">Notification preferences</div>
                <div className="text-[12px] text-ink-3 mt-0.5">Pick push / SMS / email per event type.</div>
              </div>
              <span className="text-ink-4" aria-hidden="true">
                ›
              </span>
            </div>
          </Card>
        </button>

        <Link to="/more/catalog" className="block">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[14px] font-semibold">Catalog</div>
                <div className="text-[12px] text-ink-3 mt-0.5">
                  Customers, workers, service items, pricing, bonus rules, divisions.
                </div>
              </div>
              <span className="text-ink-4" aria-hidden="true">
                ›
              </span>
            </div>
          </Card>
        </Link>

        <RoleOverrideCard currentRole={role} />
      </div>
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
    // Hard reload so all role-aware queries re-mount with the new value.
    window.location.reload()
  }
  const ROLES: ReadonlyArray<{ value: Role; label: string; detail: string }> = [
    { value: 'owner', label: 'Owner / PM', detail: 'Calm dashboard, time approvals, all surfaces.' },
    { value: 'foreman', label: 'Foreman', detail: 'Crew check-in, daily log, approval queue.' },
    { value: 'worker', label: 'Worker', detail: 'Today, hours, week.' },
  ]

  return (
    <Card>
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
    </Card>
  )
}
