/**
 * Mobile Settings home — the v3.3.0 estimator `mb-settings` surface
 * (Design Overview/estimator/screenshots/set-home.png +
 * source/mb-screens-3.jsx `SettingsHome`).
 *
 * Built on the `m/` design-system primitives (not the legacy
 * `components/mobile` shells) so it matches the rest of the v3.3.0
 * mobile shell. Sections, top to bottom:
 *   1. Profile card — name / role · company / plan dot.
 *   2. Workspace — Team, Pricing book, Loaded labor cost (jump-offs into
 *      the existing catalog admin surfaces under /more).
 *   3. Integrations — live connection status (QuickBooks Online wired to
 *      `useQboConnection`; others render their design-spec placeholder
 *      status until their connectors ship).
 *   4. Account — Notifications (push/SMS/email per-event) + push enable.
 *
 * Notifications + push are rendered inline as a sub-section so the whole
 * surface is reachable without leaving the screen — push toggle uses the
 * existing PushOnboardingCard, channel prefs use NotificationPreferencesScreen.
 *
 * NOTE FOR INTEGRATOR: this screen is not yet wired into mobile-shell.tsx
 * (read-only for this task). Add a route + a "Settings" entry so the
 * admin shell can reach it. See the REPORT in the task summary.
 */
import { useState } from 'react'
import type { BootstrapResponse } from '@/lib/api'
import type { CompanyRole } from '@sitelayer/domain'
import {
  MAvatar,
  MBody,
  MI,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
  initialsFor,
} from '../../components/m/index.js'
import { useQboConnection } from '@/lib/api'
import { NotificationPreferencesScreen } from './notifications.js'
import { PushOnboardingCard } from './push-onboarding.js'

const ROLE_LABEL: Record<string, string> = {
  admin: 'Owner / PM',
  office: 'Office',
  foreman: 'Foreman',
  member: 'Crew',
  bookkeeper: 'Bookkeeper',
}

export function MobileSettingsHome({
  bootstrap,
  companyRole,
  navigate,
}: {
  bootstrap: BootstrapResponse | null
  companyRole: CompanyRole
  navigate?: (path: string) => void
}) {
  const [section, setSection] = useState<'home' | 'notifications'>('home')

  if (section === 'notifications') {
    return (
      <>
        <MTopBar back title="Notifications" onBack={() => setSection('home')} />
        <MBody>
          <div style={{ padding: '0 4px' }}>
            <PushSection />
            <NotificationPreferencesScreen />
          </div>
        </MBody>
      </>
    )
  }

  const companyName = bootstrap?.company.name ?? 'Sitelayer'
  const roleLabel = ROLE_LABEL[companyRole] ?? 'Member'
  const go = (path: string) => navigate?.(path)

  return (
    <>
      <MTopBar title="Settings" />
      <MBody>
        {/* Profile card */}
        <div style={{ padding: '14px 16px' }}>
          <button
            type="button"
            onClick={() => go('/more')}
            style={{
              width: '100%',
              textAlign: 'left',
              padding: 14,
              background: 'var(--m-card)',
              border: '1px solid var(--m-line)',
              borderRadius: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <MAvatar initials={initialsFor(companyName)} tone="2" size="lg" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{companyName}</div>
              <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
                {roleLabel} · {companyName}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--m-green)',
                  marginTop: 4,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--m-green)' }} />
                Workspace active
              </div>
            </div>
            <MI.ChevRight className="m-chev" size={16} />
          </button>
        </div>

        {/* Workspace group */}
        <MSectionH>Workspace</MSectionH>
        <MListInset>
          <MListRow
            leading={<MI.Users size={18} />}
            leadingTone="blue"
            headline="Team"
            supporting={`${bootstrap?.workers.filter((w) => !w.deleted_at).length ?? 0} members`}
            trailing={<span className="num">{bootstrap?.workers.filter((w) => !w.deleted_at).length ?? 0}</span>}
            chev
            onTap={() => go('/more/catalog/workers')}
          />
          <MListRow
            leading={<MI.Layers size={18} />}
            leadingTone="accent"
            headline="Pricing book"
            supporting="Materials, labor rates, margins"
            chev
            onTap={() => go('/more/catalog/service-items')}
          />
          <MListRow
            leading={<MI.Settings size={18} />}
            leadingTone="green"
            headline="Catalog & divisions"
            supporting="Service items, divisions, bonus rules"
            chev
            onTap={() => go('/more/catalog')}
          />
        </MListInset>

        {/* Integrations group — live status */}
        <MSectionH link="Manage" onLinkClick={() => go('/more/integrations')}>
          Integrations
        </MSectionH>
        <IntegrationsStatusList navigate={go} />

        {/* Account group */}
        <MSectionH>Account</MSectionH>
        <MListInset>
          <MListRow
            leading={<MI.Settings size={18} />}
            headline="Notifications"
            supporting="Push, SMS, email per event"
            chev
            onTap={() => setSection('notifications')}
          />
          <MListRow
            leading={<MI.ShieldAlert size={18} />}
            headline="Privacy & data"
            supporting="How Sitelayer handles your project data"
            chev
            onTap={() => go('/more/audit')}
          />
        </MListInset>

        <div style={{ padding: '14px 16px 30px', textAlign: 'center', fontSize: 11, color: 'var(--m-ink-3)' }}>
          Sitelayer · mobile companion
        </div>
      </MBody>
    </>
  )
}

function PushSection() {
  return (
    <div style={{ padding: '8px 12px 0' }}>
      <PushOnboardingCard />
    </div>
  )
}

/**
 * Live integration status. QuickBooks Online reflects the real
 * connection state + last-sync time from `useQboConnection`. The other
 * tiles match the design's catalogue of planned connectors and render a
 * "Coming soon" affordance rather than a fake "Connect" CTA, since their
 * connectors aren't wired yet.
 */
function IntegrationsStatusList({ navigate }: { navigate: (path: string) => void }) {
  const qbo = useQboConnection()
  const status = qbo.data?.connection?.status ?? (qbo.isError ? 'error' : 'disconnected')
  const connected = status === 'connected'
  const lastSync = qbo.data?.connection?.last_synced_at ?? null

  const qboSupporting = qbo.isPending
    ? 'Checking connection…'
    : connected
      ? lastSync
        ? `Last sync ${relativeTime(lastSync)}`
        : 'Connected · awaiting first sync'
      : status === 'error'
        ? 'Reconnect needed — auth lapsed'
        : 'Not connected'

  return (
    <MListInset>
      <MListRow
        leading={<IntegrationGlyph label="QB" connected={connected} tone="green" />}
        headline="QuickBooks Online"
        supporting={qboSupporting}
        trailing={
          connected ? (
            <MPill tone="green" dot>
              Connected
            </MPill>
          ) : (
            <MPill tone={status === 'error' ? 'red' : 'amber'} dot>
              {status === 'error' ? 'Reconnect' : 'Connect'}
            </MPill>
          )
        }
        chev
        onTap={() => navigate('/more/integrations/qbo')}
      />
      <MListRow
        leading={<IntegrationGlyph label="ST" connected={false} tone="blue" />}
        headline="Stripe"
        supporting="Card + ACH payments on invoices"
        trailing={
          <MPill dot tone={undefined}>
            Soon
          </MPill>
        }
      />
      <MListRow
        leading={<IntegrationGlyph label="EM" connected={false} tone="accent" />}
        headline="Email provider"
        supporting="Send estimates + invoices from your domain"
        trailing={
          <MPill dot tone={undefined}>
            Soon
          </MPill>
        }
      />
    </MListInset>
  )
}

function IntegrationGlyph({ label, connected, tone }: { label: string; connected: boolean; tone: string }) {
  const bg = connected ? `var(--m-${tone})` : 'var(--m-card-soft)'
  return (
    <span
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        background: bg,
        color: connected ? '#fff' : 'var(--m-ink-3)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
      }}
    >
      {label}
    </span>
  )
}

/**
 * Compact relative-time formatter for sync timestamps ("2 min ago",
 * "3 hr ago", "yesterday"). Falls back to a short date past a week.
 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'recently'
  const diffMs = Date.now() - then
  const min = Math.round(diffMs / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const day = Math.round(hr / 24)
  if (day === 1) return 'yesterday'
  if (day < 7) return `${day} days ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
