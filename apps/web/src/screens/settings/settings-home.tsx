/**
 * Mobile Settings home — the v3.3.0 estimator `mb-settings` surface
 * (Design Overview/estimator/screenshots/set-home.png +
 * source/mb-screens-3.jsx `SettingsHome`).
 *
 * Built on the `m/` design-system primitives (not the retired legacy
 * wave-2 kit shells) so it matches the rest of the v3.3.0
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
 */
import { useState, type CSSProperties } from 'react'
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
import { traceBeaconConsentGranted, setTraceBeaconConsent } from '../../lib/product-trace-consent.js'
import { useActiveCompanyId } from '@/lib/api/active-company'
import {
  useCompanyFeedbackInvites,
  useCreateFeedbackInvite,
  useRevokeFeedbackInvite,
  type FeedbackInviteCaptureMode,
} from '@/lib/api/feedback-invites'

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
  const [section, setSection] = useState<'home' | 'notifications' | 'feedback-invites'>('home')
  // T1 "help debug my session": opt into anonymized in-app diagnostics (the
  // observability client beacon). OFF by default; flips setTraceBeaconConsent.
  const [debugConsent, setDebugConsent] = useState(traceBeaconConsentGranted())

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

  if (section === 'feedback-invites') {
    return (
      <>
        <MTopBar back title="External reviewers" onBack={() => setSection('home')} />
        <MBody>
          <FeedbackInvitesSection />
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
            onClick={() => go('/more/profile')}
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

        {/* Money & comms group (v2 net-new surfaces) */}
        <MSectionH>Money &amp; comms</MSectionH>
        <MListInset>
          <MListRow
            leading={<MI.FileText size={18} />}
            leadingTone="accent"
            headline="Money"
            supporting="Cash flow, net, pending"
            chev
            onTap={() => go('/money')}
          />
          <MListRow
            leading={<MI.Users size={18} />}
            leadingTone="blue"
            headline="Clients"
            supporting="Profiles, lifetime value, win rate"
            chev
            onTap={() => go('/clients')}
          />
          <MListRow
            leading={<MI.Mic size={18} />}
            headline="Messages"
            supporting="Project chat threads"
            chev
            onTap={() => go('/chat')}
          />
          <MListRow
            leading={<MI.Alert size={18} />}
            leadingTone="amber"
            headline="Broadcast"
            supporting="One-way crew announcement"
            chev
            onTap={() => go('/broadcast')}
          />
          <MListRow
            leading={<MI.Clock size={18} />}
            headline="Activity"
            supporting="Company-wide audit timeline"
            chev
            onTap={() => go('/activity')}
          />
          <MListRow
            leading={<MI.Check size={18} />}
            leadingTone="green"
            headline="Approvals"
            supporting="Owner authorization inbox"
            chev
            onTap={() => go('/approvals')}
          />
          <MListRow
            leading={<MI.Alert size={18} />}
            headline="Inbox"
            supporting="Notifications addressed to you"
            chev
            onTap={() => go('/notifications')}
          />
        </MListInset>

        {/* Workflow group — operational jump-offs the retired "Everything
            else" More hub used to carry; kept here so every destination it
            linked stays reachable (audit M12 reachability constraint). */}
        <MSectionH>Workflow</MSectionH>
        <MListInset>
          <MListRow
            leading={<MI.MapPin size={18} />}
            headline="Ops"
            supporting="Phone diagnostics and routing"
            chev
            onTap={() => go('/ops')}
          />
          <MListRow
            leading={<MI.FileText size={18} />}
            headline="Work queue"
            supporting="Field material, equipment and issue requests"
            chev
            onTap={() => go('/work')}
          />
          <MListRow
            leading={<MI.Layers size={18} />}
            headline="Measurements"
            supporting="Takeoff focus across projects"
            chev
            onTap={() => go('/projects?focus=takeoff')}
          />
          <MListRow
            leading={<MI.FileText size={18} />}
            leadingTone="accent"
            headline="Estimates"
            supporting="Estimate focus across projects"
            chev
            onTap={() => go('/projects?focus=estimate')}
          />
          <MListRow
            leading={<MI.Users size={18} />}
            leadingTone="blue"
            headline="Live crew"
            supporting="Who's clocked in right now"
            chev
            onTap={() => go('/live-crew')}
          />
          <MListRow
            leading={<MI.FileText size={18} />}
            leadingTone="green"
            headline="Financial"
            supporting="Invoices, payroll, job costing"
            chev
            onTap={() => go('/financial')}
          />
          <MListRow
            leading={<MI.Users size={18} />}
            headline="Assignments"
            supporting="Project crew assignments"
            chev
            onTap={() => go('/projects/assignments')}
          />
        </MListInset>

        {/* Workspace group — mirrors the design's settings hub
            (Company / Pricing book / Loaded labor / Working hours / Team). */}
        <MSectionH>Workspace</MSectionH>
        <MListInset>
          <MListRow
            leading={<MI.Layers size={18} />}
            leadingTone="accent"
            headline="Pricing book"
            supporting="Materials, labor rates, margins"
            chev
            onTap={() => go('/more/pricing-book')}
          />
          <MListRow
            leading={<MI.FileText size={18} />}
            leadingTone="amber"
            headline="Loaded labor · burden"
            supporting="Your real hourly cost — base + all burdens"
            chev
            onTap={() => go('/more/loaded-labor')}
          />
          <MListRow
            leading={<MI.Clock size={18} />}
            headline="Working hours"
            supporting="Work days, daily window, holidays"
            chev
            onTap={() => go('/more/working-hours')}
          />
          <MListRow
            leading={<MI.ShieldAlert size={18} />}
            leadingTone="green"
            headline="Roles & permissions"
            supporting="Built-in roles + custom role editor"
            chev
            onTap={() => go('/more/roles')}
          />
          {companyRole === 'admin' ? (
            <MListRow
              leading={<MI.Alert size={18} />}
              leadingTone="blue"
              headline="External reviewers"
              supporting="Signed feedback links"
              chev
              onTap={() => setSection('feedback-invites')}
            />
          ) : null}
          <MListRow
            leading={<MI.Users size={18} />}
            leadingTone="blue"
            headline="Team"
            supporting={`${bootstrap?.workers.filter((w) => !w.deleted_at).length ?? 0} members`}
            trailing={<span className="num">{bootstrap?.workers.filter((w) => !w.deleted_at).length ?? 0}</span>}
            chev
            onTap={() => go('/more/catalog/workers')}
          />
          {/* Invite teammate — design msg__94: "From → Settings → Invite".
              The send screen at /invite/teammate was complete but had zero
              inbound links (audit M01 #19). */}
          <MListRow
            leading={<MI.Plus size={18} />}
            leadingTone="accent"
            headline="Invite teammate"
            supporting="Send a role-scoped invite link"
            chev
            onTap={() => go('/invite/teammate')}
          />
          <MListRow
            leading={<MI.Settings size={18} />}
            leadingTone="green"
            headline="Catalog & divisions"
            supporting="Service items, divisions, bonus rules"
            chev
            onTap={() => go('/more/catalog')}
          />
          <MListRow
            leading={<MI.Truck size={18} />}
            leadingTone="amber"
            headline="Inventory admin"
            supporting="Items, locations, movements, branches"
            chev
            onTap={() => go('/more/inventory')}
          />
          <MListRow
            leading={<MI.Layers size={18} />}
            headline="Bonus simulator"
            supporting="Model bonus rules against real hours"
            chev
            onTap={() => go('/more/bonus-sim')}
          />
          <MListRow
            leading={<MI.Truck size={18} />}
            headline="Dispatch lanes"
            supporting="Rental dispatch lane admin"
            chev
            onTap={() => go('/more/dispatch-lanes')}
          />
          <MListRow
            leading={<MI.FileText size={18} />}
            headline="Notification queue"
            supporting="Outbound delivery queue health"
            chev
            onTap={() => go('/more/notifications-queue')}
          />
        </MListInset>

        {/* Integrations group — live status. (No "Manage" header link: the
            legacy QBO-only hub at /more/integrations was retired and that path
            now redirects back to this screen; each row navigates itself.) */}
        <MSectionH>Integrations</MSectionH>
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
            leading={<MI.Alert size={18} />}
            leadingTone="blue"
            headline="Help debug my session"
            supporting={
              debugConsent
                ? 'On — sharing anonymized in-app diagnostics'
                : 'Off — opt in to share anonymized diagnostics that help us fix issues'
            }
            trailing={<MPill>{debugConsent ? 'On' : 'Off'}</MPill>}
            onTap={() => {
              const next = !debugConsent
              setTraceBeaconConsent(next)
              setDebugConsent(next)
            }}
          />
          <MListRow
            leading={<MI.Users size={18} />}
            headline="Profile"
            supporting="Your name, email, phone, password"
            chev
            onTap={() => go('/more/profile')}
          />
          <MListRow
            leading={<MI.ShieldAlert size={18} />}
            headline="Privacy & data"
            supporting="How Sitelayer handles your project data"
            chev
            onTap={() => go('/more/audit')}
          />
          <MListRow
            leading={<MI.Alert size={18} />}
            leadingTone="amber"
            headline="Help & support"
            supporting="Chat, book a call, email — we talk back quick"
            chev
            onTap={() => go('/more/help')}
          />
        </MListInset>

        <div style={{ padding: '14px 16px 30px', textAlign: 'center', fontSize: 11, color: 'var(--m-ink-3)' }}>
          Sitelayer · mobile companion
        </div>
      </MBody>
    </>
  )
}

const FEEDBACK_CAPTURE_MODES: FeedbackInviteCaptureMode[] = ['text', 'state', 'audio', 'screen']

function FeedbackInvitesSection() {
  const companyId = useActiveCompanyId()
  const invites = useCompanyFeedbackInvites(companyId)
  const create = useCreateFeedbackInvite(companyId ?? '')
  const revoke = useRevokeFeedbackInvite(companyId ?? '')
  const [reviewerRef, setReviewerRef] = useState('steve')
  const [targetRoute, setTargetRoute] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('14')
  const [modes, setModes] = useState<FeedbackInviteCaptureMode[]>(['text', 'state'])
  const [createdUrl, setCreatedUrl] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const activeInvites = (invites.data?.invites ?? []).filter((invite) => !invite.revoked_at)

  async function createLink() {
    if (!companyId || create.isPending) return
    setCreatedUrl(null)
    setCopied(false)
    try {
      const route = targetRoute.trim()
      const result = await create.mutateAsync({
        reviewer_ref: reviewerRef.trim() || 'reviewer',
        source: 'settings_external_reviewer',
        ...(route ? { target_route: route } : {}),
        expires_in_days: Math.max(1, Math.min(90, Number(expiresInDays) || 14)),
        allowed_capture_modes: modes.length ? modes : ['text'],
        metadata: { created_from: 'settings_external_reviewers' },
      })
      setCreatedUrl(result.invite_url)
    } catch {
      // React Query owns the rendered error state.
    }
  }

  function toggleMode(mode: FeedbackInviteCaptureMode) {
    setModes((current) => {
      if (mode === 'text') return current.includes('text') ? current : ['text', ...current]
      const next = current.includes(mode) ? current.filter((entry) => entry !== mode) : [...current, mode]
      return next.includes('text') ? next : ['text', ...next]
    })
  }

  function copyUrl(url: string) {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }

  if (!companyId) {
    return <div style={{ padding: 16, color: 'var(--m-ink-3)', fontSize: 13 }}>No active company loaded.</div>
  }

  return (
    <div style={{ padding: '12px 16px 30px' }}>
      <div style={feedbackStyles.card}>
        <label style={feedbackStyles.label}>
          Reviewer
          <input
            value={reviewerRef}
            onChange={(event) => setReviewerRef(event.target.value)}
            style={feedbackStyles.input}
            maxLength={120}
          />
        </label>
        <label style={feedbackStyles.label}>
          Target route
          <input
            value={targetRoute}
            onChange={(event) => setTargetRoute(event.target.value)}
            placeholder="/desktop"
            style={feedbackStyles.input}
            maxLength={500}
          />
        </label>
        <label style={feedbackStyles.label}>
          Expires
          <input
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
            inputMode="numeric"
            style={feedbackStyles.input}
          />
        </label>
        <div style={feedbackStyles.modeGrid}>
          {FEEDBACK_CAPTURE_MODES.map((mode) => (
            <label key={mode} style={feedbackStyles.check}>
              <input
                type="checkbox"
                checked={modes.includes(mode)}
                disabled={mode === 'text'}
                onChange={() => toggleMode(mode)}
              />
              {mode}
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void createLink()}
          disabled={create.isPending}
          style={{ ...feedbackStyles.primary, opacity: create.isPending ? 0.7 : 1 }}
        >
          {create.isPending ? 'Creating...' : 'Create feedback link'}
        </button>
        {create.isError ? <div style={feedbackStyles.error}>{create.error.message}</div> : null}
        {createdUrl ? (
          <div style={feedbackStyles.result}>
            <div style={feedbackStyles.url}>{createdUrl}</div>
            <button type="button" style={feedbackStyles.secondary} onClick={() => copyUrl(createdUrl)}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        ) : null}
      </div>

      <MSectionH>Active links</MSectionH>
      <MListInset>
        {invites.isPending ? (
          <div style={feedbackStyles.empty}>Loading...</div>
        ) : invites.isError ? (
          <div style={feedbackStyles.error}>{invites.error.message}</div>
        ) : activeInvites.length === 0 ? (
          <div style={feedbackStyles.empty}>No active feedback links.</div>
        ) : (
          activeInvites.map((invite) => (
            <div key={invite.id} style={feedbackStyles.inviteRow}>
              <div style={{ minWidth: 0 }}>
                <div style={feedbackStyles.inviteTitle}>{invite.reviewer_ref}</div>
                <div style={feedbackStyles.inviteMeta}>
                  {invite.allowed_capture_modes.join(', ')} · expires {shortDate(invite.expires_at)}
                </div>
                {invite.last_used_at ? (
                  <div style={feedbackStyles.inviteMeta}>Last used {relativeTime(invite.last_used_at)}</div>
                ) : null}
              </div>
              <button
                type="button"
                style={feedbackStyles.revoke}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate({ inviteId: invite.id })}
              >
                Revoke
              </button>
            </div>
          ))
        )}
      </MListInset>
    </div>
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
        leading={<IntegrationGlyph label="G" connected={false} tone="green" />}
        headline="Gusto"
        supporting="Payroll · burden auto"
        trailing={
          <MPill dot tone={undefined}>
            Soon
          </MPill>
        }
      />
      <MListRow
        leading={<IntegrationGlyph label="ST" connected={false} tone="blue" />}
        headline="Stripe"
        supporting="Collect payments — card + ACH on invoices"
        trailing={
          <MPill dot tone={undefined}>
            Connect
          </MPill>
        }
      />
      <MListRow
        leading={<IntegrationGlyph label="X" connected={false} tone="accent" />}
        headline="Xero"
        supporting="Books · alternative"
        trailing={
          <MPill dot tone={undefined}>
            Connect
          </MPill>
        }
      />
      <MListRow
        leading={<IntegrationGlyph label="P" connected={false} tone="amber" />}
        headline="Procore"
        supporting="GC project import"
        trailing={
          <MPill dot tone={undefined}>
            Connect
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

function shortDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10)
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const feedbackStyles: Record<string, CSSProperties> = {
  card: {
    border: '1px solid var(--m-line)',
    borderRadius: 12,
    background: 'var(--m-card)',
    padding: 12,
    marginBottom: 18,
  },
  label: {
    display: 'grid',
    gap: 5,
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--m-ink-2)',
    marginBottom: 10,
  },
  input: {
    border: '1px solid var(--m-line)',
    borderRadius: 8,
    padding: '9px 10px',
    font: 'inherit',
    fontSize: 14,
    background: '#fff',
    color: 'var(--m-ink)',
  },
  modeGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8, marginBottom: 12 },
  check: { display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--m-ink)' },
  primary: {
    width: '100%',
    border: 0,
    borderRadius: 9,
    padding: '10px 12px',
    background: 'var(--m-accent)',
    color: 'var(--m-accent-ink)',
    fontWeight: 700,
  },
  secondary: {
    border: '1px solid var(--m-line)',
    borderRadius: 8,
    padding: '8px 10px',
    background: '#fff',
    color: 'var(--m-ink)',
    fontWeight: 700,
  },
  result: { marginTop: 10, display: 'grid', gap: 8 },
  url: {
    border: '1px solid var(--m-line)',
    borderRadius: 8,
    padding: 8,
    background: 'var(--m-card-soft)',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
    overflowWrap: 'anywhere',
  },
  error: {
    marginTop: 8,
    color: '#b91c1c',
    background: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: 8,
    fontSize: 12,
  },
  empty: { padding: 12, fontSize: 13, color: 'var(--m-ink-3)' },
  inviteRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '11px 12px',
    borderBottom: '1px solid var(--m-line)',
  },
  inviteTitle: { fontSize: 14, fontWeight: 700, color: 'var(--m-ink)' },
  inviteMeta: { fontSize: 12, color: 'var(--m-ink-3)', marginTop: 2 },
  revoke: {
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: '7px 9px',
    background: '#fff',
    color: '#b91c1c',
    fontSize: 12,
    fontWeight: 700,
  },
}
