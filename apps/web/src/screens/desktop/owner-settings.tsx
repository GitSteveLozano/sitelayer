/**
 * Owner desktop settings (Desktop v2 · Owner · Settings).
 *
 * Fuller spec: a LEFT sub-nav column listing every settings section
 * (Company / Pricing Book / Loaded Labor / Working Hours / Integrations /
 * Roles + Permissions / Notifications / Profile / Help) + a RIGHT content
 * panel for the selected section, all inside the desktop `.d-content`.
 *
 * Real data is wired where a hook exists (Pricing Book → useServiceItems,
 * Loaded Labor → useLaborBurdenToday, Roles + Permissions → COMPANY_ROLES
 * capability matrix). Every other section renders a clean structured
 * placeholder card — no fake data. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { COMPANY_ROLES, type CompanyRole } from '@sitelayer/domain'
import { useServiceItems, type ServiceItem } from '@/lib/api/service-items'
import { useLaborBurdenToday, type LaborBurdenWorkerResult } from '@/lib/api/labor-burden'
import { DataTable, DEyebrow, DH1, type DColumn } from '@/components/d'
import { MButton, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'

type SectionKey =
  | 'company'
  | 'pricing'
  | 'pricing-book'
  | 'loaded-labor'
  | 'hours'
  | 'integrations'
  | 'roles'
  | 'notifications'
  | 'profile'
  | 'help'

interface SectionDef {
  key: SectionKey
  label: string
  eyebrow: string
  title: string
}

const SECTIONS: SectionDef[] = [
  { key: 'company', label: 'Company', eyebrow: 'Owner · Settings', title: 'Company' },
  { key: 'pricing', label: 'Pricing', eyebrow: 'Owner · Settings', title: 'Pricing' },
  { key: 'pricing-book', label: 'Pricing Book', eyebrow: 'Owner · Settings', title: 'Pricing book' },
  { key: 'loaded-labor', label: 'Loaded Labor', eyebrow: 'Owner · Settings', title: 'Loaded labor' },
  { key: 'hours', label: 'Working Hours', eyebrow: 'Owner · Settings', title: 'Working hours' },
  { key: 'integrations', label: 'Integrations', eyebrow: 'Owner · Settings', title: 'Integrations' },
  { key: 'roles', label: 'Roles + Permissions', eyebrow: 'Owner · Settings', title: 'Roles + permissions' },
  { key: 'notifications', label: 'Notifications', eyebrow: 'Owner · Settings', title: 'Notifications' },
  { key: 'profile', label: 'Profile', eyebrow: 'Owner · Settings', title: 'Profile' },
  { key: 'help', label: 'Help', eyebrow: 'Owner · Settings', title: 'Help' },
]

const PLACEHOLDER_COPY: Partial<Record<SectionKey, string>> = {
  company:
    'Configure your company name, address, license numbers, and branding here. Settings entered here flow through to estimates and invoices.',
  hours:
    'Configure standard working hours, overtime thresholds, and holiday calendars used to compute crew schedules and loaded labor.',
  integrations:
    'Connect and manage external systems (QuickBooks Online, etc.). Connection status and sync controls will appear here once an integration is linked.',
  notifications:
    'Configure which events send notifications, the channels used (email / SMS / push), and per-role delivery preferences.',
  profile: 'Manage your own account: display name, email, and personal notification preferences.',
  help: 'Documentation, keyboard shortcuts, and support contact. Configure how your team reaches support here.',
}

// ---- Roles + Permissions matrix ------------------------------------------
// Static capability matrix across the 5 canonical COMPANY_ROLES. This mirrors
// the role model in @sitelayer/domain (roles.ts); it is a display matrix, not
// an enforcement surface — server-side RBAC remains authoritative.
interface CapabilityRow {
  capability: string
  allowed: Record<CompanyRole, boolean>
}

const CAPABILITY_MATRIX: CapabilityRow[] = [
  {
    capability: 'View projects',
    allowed: { admin: true, foreman: true, office: true, member: true, bookkeeper: true },
  },
  {
    capability: 'Edit takeoffs',
    allowed: { admin: true, foreman: true, office: false, member: true, bookkeeper: false },
  },
  {
    capability: 'Approve estimates',
    allowed: { admin: true, foreman: false, office: true, member: false, bookkeeper: false },
  },
  {
    capability: 'Manage crew schedule',
    allowed: { admin: true, foreman: true, office: true, member: false, bookkeeper: false },
  },
  {
    capability: 'Review labor / time',
    allowed: { admin: true, foreman: true, office: true, member: false, bookkeeper: false },
  },
  {
    capability: 'Push to QuickBooks',
    allowed: { admin: true, foreman: false, office: false, member: false, bookkeeper: true },
  },
  {
    capability: 'Manage billing / invoices',
    allowed: { admin: true, foreman: false, office: true, member: false, bookkeeper: true },
  },
  {
    capability: 'Manage company settings',
    allowed: { admin: true, foreman: false, office: false, member: false, bookkeeper: false },
  },
]

function PlaceholderCard({ section }: { section: SectionDef }) {
  return (
    <div className="d-card" style={{ color: 'var(--m-ink-3)' }}>
      <div className="d-eyebrow">{section.label}</div>
      <div style={{ fontSize: 14, marginTop: 8, lineHeight: 1.5 }}>
        {PLACEHOLDER_COPY[section.key] ?? 'This section is in progress.'}
      </div>
    </div>
  )
}

function PricingBookSection() {
  const itemsQuery = useServiceItems()
  const rows = useMemo<ServiceItem[]>(() => itemsQuery.data?.serviceItems ?? [], [itemsQuery.data?.serviceItems])

  const columns: Array<DColumn<ServiceItem>> = [
    { key: 'name', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'category', header: 'Division / Category', render: (r) => <MPill>{r.category || '—'}</MPill> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    {
      key: 'default_rate',
      header: 'Rate',
      numeric: true,
      render: (r) => (r.default_rate == null ? '—' : formatMoney(r.default_rate)),
    },
    {
      key: 'edit',
      header: '',
      render: () => (
        <MButton
          size="sm"
          variant="quiet"
          onClick={(e) => {
            e.stopPropagation()
            // TODO: wire to a pricing-item editor sheet (usePatchServiceItem).
          }}
        >
          Edit
        </MButton>
      ),
    },
  ]

  return (
    <DataTable<ServiceItem>
      title="Service items"
      action={
        <MButton
          size="sm"
          variant="quiet"
          onClick={() => {
            // TODO: wire to a new-pricing-item editor sheet (useCreateServiceItem).
          }}
        >
          + Add item
        </MButton>
      }
      columns={columns}
      rows={rows}
      rowKey={(r) => r.code}
      empty="No service items yet. Items added to your catalog show up here with their billing rates."
    />
  )
}

function LoadedLaborSection() {
  const burdenQuery = useLaborBurdenToday()
  const summary = burdenQuery.data
  const workers = useMemo<LaborBurdenWorkerResult[]>(() => summary?.per_worker ?? [], [summary?.per_worker])

  if (!summary) {
    return (
      <div className="d-card" style={{ color: 'var(--m-ink-3)' }}>
        <div className="d-eyebrow">Loaded Labor</div>
        <div style={{ fontSize: 14, marginTop: 8 }}>
          {burdenQuery.isError ? 'Could not load today’s labor burden.' : 'Loading today’s loaded-labor burden…'}
        </div>
      </div>
    )
  }

  const columns: Array<DColumn<LaborBurdenWorkerResult>> = [
    { key: 'worker', header: 'Worker', render: (r) => <span className="d-table-cell-strong">{r.worker_id}</span> },
    { key: 'straight', header: 'ST hrs', numeric: true, render: (r) => r.straight_hours.toFixed(1) },
    { key: 'ot', header: 'OT hrs', numeric: true, render: (r) => r.ot_hours.toFixed(1) },
    {
      key: 'loaded',
      header: 'Loaded $/hr',
      numeric: true,
      render: (r) => formatMoney(r.loaded_hourly_cents / 100),
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      render: (r) => formatMoney(r.total_cents / 100),
    },
  ]

  return (
    <DataTable<LaborBurdenWorkerResult>
      title={`Loaded labor — today (${summary.total_hours.toFixed(1)} hrs · ${formatMoney(summary.total_cents / 100)})`}
      columns={columns}
      rows={workers}
      rowKey={(r) => r.worker_id}
      empty="No labor logged today. Burden is computed from clocked time × each worker’s loaded hourly rate."
    />
  )
}

function RolesSection() {
  const columns: Array<DColumn<CapabilityRow>> = [
    {
      key: 'capability',
      header: 'Capability',
      render: (r) => <span className="d-table-cell-strong">{r.capability}</span>,
    },
    ...COMPANY_ROLES.map<DColumn<CapabilityRow>>((role) => ({
      key: role,
      header: role.charAt(0).toUpperCase() + role.slice(1),
      numeric: true,
      render: (r) =>
        r.allowed[role] ? (
          <span style={{ color: 'var(--m-accent)' }} aria-label="allowed">
            ✓
          </span>
        ) : (
          <span style={{ color: 'var(--m-ink-3)' }} aria-label="not allowed">
            —
          </span>
        ),
    })),
  ]

  return (
    <DataTable<CapabilityRow>
      title="Roles + permissions"
      columns={columns}
      rows={CAPABILITY_MATRIX}
      rowKey={(r) => r.capability}
      empty="No capabilities defined."
    />
  )
}

// ---- Pricing overview ----------------------------------------------------
// Per the v2 spec, "Settings → Pricing" is the SAME canonical item library —
// there is no second pricebook. This panel gives a short overview (item count
// + category spread from the live catalog) and a context note, then deep-links
// to the Item Library at /desktop/item-library where owners write rates.
function PricingOverviewSection() {
  const navigate = useNavigate()
  const itemsQuery = useServiceItems()
  const items = useMemo<ServiceItem[]>(() => itemsQuery.data?.serviceItems ?? [], [itemsQuery.data?.serviceItems])

  const categoryCount = useMemo(() => {
    const set = new Set<string>()
    for (const it of items) {
      if (it.category) set.add(it.category)
    }
    return set.size
  }, [items])

  const ratedCount = useMemo(() => items.filter((it) => it.default_rate != null).length, [items])

  return (
    <div className="d-stack">
      <div
        className="d-card"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          borderLeft: '3px solid var(--m-accent)',
        }}
      >
        <MPill tone="blue">Canonical</MPill>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--m-ink-2)' }}>
          Settings → Pricing = canonical item library · owner write. There is no second pricebook — rates live in the
          shared Item Library so estimates, takeoffs, and invoices all read the same source of truth.
        </div>
      </div>

      <div className="d-card">
        <div className="d-eyebrow">Item library overview</div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
            gap: 16,
            marginTop: 14,
          }}
        >
          {[
            { label: 'Items', value: items.length },
            { label: 'Categories', value: categoryCount },
            { label: 'With a rate', value: ratedCount },
          ].map((stat) => (
            <div key={stat.label}>
              <div
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontWeight: 800,
                  fontSize: 32,
                  lineHeight: 1,
                  color: 'var(--m-ink)',
                }}
              >
                {itemsQuery.isLoading ? '—' : stat.value}
              </div>
              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--m-ink-3)',
                  marginTop: 6,
                }}
              >
                {stat.label}
              </div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 18 }}>
          <MButton
            variant="primary"
            size="sm"
            onClick={() => navigate('/desktop/item-library')}
            aria-label="Open the canonical item library"
          >
            Open Item Library →
          </MButton>
        </div>
      </div>
    </div>
  )
}

function SectionBody({ section }: { section: SectionDef }) {
  switch (section.key) {
    case 'pricing':
      return <PricingOverviewSection />
    case 'pricing-book':
      return <PricingBookSection />
    case 'loaded-labor':
      return <LoadedLaborSection />
    case 'roles':
      return <RolesSection />
    default:
      return <PlaceholderCard section={section} />
  }
}

export function OwnerSettings() {
  const [active, setActive] = useState<SectionKey>('pricing')
  const section = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0]!

  return (
    <div className="d-content">
      <div
        style={{
          display: 'flex',
          gap: 'var(--m-4, 24px)',
          alignItems: 'flex-start',
        }}
      >
        {/* Left sub-nav column */}
        <nav
          aria-label="Settings sections"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--m-1, 4px)',
            flex: '0 0 220px',
            position: 'sticky',
            top: 'var(--m-3, 16px)',
          }}
        >
          {SECTIONS.map((s) => {
            const isActive = s.key === active
            return (
              <button
                key={s.key}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => setActive(s.key)}
                style={{
                  textAlign: 'left',
                  padding: 'var(--m-2, 10px) var(--m-3, 14px)',
                  borderRadius: 'var(--m-radius, 10px)',
                  border: '1px solid transparent',
                  cursor: 'pointer',
                  fontSize: 14,
                  fontWeight: isActive ? 600 : 500,
                  background: isActive ? 'var(--m-accent)' : 'transparent',
                  color: isActive ? 'var(--m-on-accent, #111)' : 'var(--m-ink-2)',
                }}
              >
                {s.label}
              </button>
            )
          })}
        </nav>

        {/* Right content panel */}
        <div className="d-stack" style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div>
            <DEyebrow>{section.eyebrow}</DEyebrow>
            <DH1>{section.title}</DH1>
          </div>
          <SectionBody section={section} />
        </div>
      </div>
    </div>
  )
}
