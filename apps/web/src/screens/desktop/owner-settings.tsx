/**
 * Owner desktop settings (Desktop v2 · Owner · Settings).
 *
 * A LEFT sub-nav column listing the design's 9 settings sections
 * (Company / Pricing Book / Loaded Labor / Working Hours / Integrations /
 * Roles + Permissions / Notifications / Profile / Help) + a RIGHT content
 * panel for the selected section, all inside the desktop `.d-content`.
 * Defaults to Company, matching steve-desktop-3.
 *
 * Real data is wired where a hook exists (Pricing Book → useServiceItems,
 * Loaded Labor → useLaborBurdenToday, Roles + Permissions → COMPANY_ROLES
 * capability matrix). The other six panels (Company / Working Hours /
 * Integrations / Notifications / Profile / Help) live in
 * settings/owner-settings-panels.tsx; they render the full design structure
 * with clearly-labeled placeholder data + TODO(wire) notes because they have
 * no dedicated backend API yet. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useEffect, useMemo, useState } from 'react'
import { COMPANY_ROLES, type CompanyRole } from '@sitelayer/domain'
import { useServiceItems, type ServiceItem } from '@/lib/api/service-items'
import { useLaborBurdenToday, type LaborBurdenWorkerResult } from '@/lib/api/labor-burden'
import { useDeletePricingOverride, usePricingOverrides, useUpsertPricingOverride } from '@/lib/api/pricing-overrides'
import { DataTable, DEyebrow, DH1, DModal, type DColumn } from '@/components/d'
import { MButton, MInput, MPill } from '@/components/m'
import { formatMoney } from '../mobile/format.js'
import {
  CompanySection,
  HelpSection,
  IntegrationsSection,
  NotificationsSection,
  ProfileSection,
  WorkingHoursSection,
} from './settings/owner-settings-panels'

type SectionKey =
  | 'company'
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

// The 9 entries match the steve-desktop-3 settings nav exactly. There is no
// standalone "Pricing" tab — pricing rates live in the canonical Item Library
// (Pricing Book here is the in-settings view of that catalog).
const SECTIONS: SectionDef[] = [
  { key: 'company', label: 'Company', eyebrow: 'Owner · Settings', title: 'Company' },
  { key: 'pricing-book', label: 'Pricing Book', eyebrow: 'Owner · Settings', title: 'Pricing book' },
  { key: 'loaded-labor', label: 'Loaded Labor', eyebrow: 'Owner · Settings', title: 'Loaded labor' },
  { key: 'hours', label: 'Working Hours', eyebrow: 'Owner · Settings', title: 'Working hours' },
  { key: 'integrations', label: 'Integrations', eyebrow: 'Owner · Settings', title: 'Integrations' },
  { key: 'roles', label: 'Roles + Permissions', eyebrow: 'Owner · Settings', title: 'Roles + permissions' },
  { key: 'notifications', label: 'Notifications', eyebrow: 'Owner · Settings', title: 'Notifications' },
  { key: 'profile', label: 'Profile', eyebrow: 'Owner · Settings', title: 'Profile' },
  { key: 'help', label: 'Help', eyebrow: 'Owner · Settings', title: 'Help' },
]

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

// ---- Pricing Book (company rate book) ------------------------------------
// The COMPANY-level rate book. Every service item shows its catalog default
// rate plus the company-wide override when one is set (the highest-but-one
// rung of the pricing chain: project → customer → company → qbo → default).
// Edit / + Add open the company-rates editor, which upserts
// company_pricing_overrides via /api/company/pricing-overrides. A per-project
// or per-customer rate card still beats the company rate downstream.
const COMPANY_SCOPE = { kind: 'company' as const }

function PricingBookSection() {
  const itemsQuery = useServiceItems()
  const items = useMemo<ServiceItem[]>(() => itemsQuery.data?.serviceItems ?? [], [itemsQuery.data?.serviceItems])
  const overridesQuery = usePricingOverrides(COMPANY_SCOPE)
  const [editorOpen, setEditorOpen] = useState(false)
  const [focusCode, setFocusCode] = useState<string | null>(null)

  // Company override rate per service-item code (string), when set.
  const overrideByCode = useMemo(() => {
    const map = new Map<string, string>()
    for (const o of overridesQuery.data?.overrides ?? []) map.set(o.service_item_code, String(Number(o.rate)))
    return map
  }, [overridesQuery.data])

  const openEditor = (code: string | null) => {
    setFocusCode(code)
    setEditorOpen(true)
  }

  const columns: Array<DColumn<ServiceItem>> = [
    { key: 'name', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'category', header: 'Division / Category', render: (r) => <MPill>{r.category || '—'}</MPill> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    {
      key: 'default_rate',
      header: 'Default',
      numeric: true,
      render: (r) => (r.default_rate == null ? '—' : formatMoney(r.default_rate)),
    },
    {
      key: 'company_rate',
      header: 'Company rate',
      numeric: true,
      render: (r) => {
        const ovr = overrideByCode.get(r.code)
        if (ovr == null) return <span style={{ color: 'var(--m-ink-3)' }}>—</span>
        return <span style={{ color: 'var(--m-accent-ink, #111)', fontWeight: 600 }}>{formatMoney(Number(ovr))}</span>
      },
    },
    {
      key: 'edit',
      header: '',
      render: (r) => (
        <MButton
          size="sm"
          variant="quiet"
          onClick={(e) => {
            e.stopPropagation()
            openEditor(r.code)
          }}
        >
          Edit
        </MButton>
      ),
    },
  ]

  return (
    <>
      <DataTable<ServiceItem>
        title="Service items"
        action={
          <MButton size="sm" variant="quiet" onClick={() => openEditor(null)}>
            + Add item
          </MButton>
        }
        columns={columns}
        rows={items}
        rowKey={(r) => r.code}
        onRowClick={(r) => openEditor(r.code)}
        empty="No service items yet. Items added to your catalog show up here with their billing rates."
      />
      <CompanyRatesModal open={editorOpen} items={items} focusCode={focusCode} onClose={() => setEditorOpen(false)} />
    </>
  )
}

// Company rate-book editor. Mirrors est-project-rates.tsx's ProjectRatesModal
// but for the company scope: each service item shows its catalog default + a
// company override input. Blank clears the override (falls back to default).
// There is no estimate recompute here — the company rate book is a standing
// catalog, not a single project's estimate.
function CompanyRatesModal({
  open,
  items,
  focusCode,
  onClose,
}: {
  open: boolean
  items: ServiceItem[]
  focusCode: string | null
  onClose: () => void
}) {
  const overridesQuery = usePricingOverrides(COMPANY_SCOPE, open)
  const upsert = useUpsertPricingOverride(COMPANY_SCOPE)
  const remove = useDeletePricingOverride(COMPANY_SCOPE)

  const originalByCode = useMemo(() => {
    const map = new Map<string, string>()
    for (const o of overridesQuery.data?.overrides ?? []) map.set(o.service_item_code, String(Number(o.rate)))
    return map
  }, [overridesQuery.data])

  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Seed editable values from the loaded overrides when the modal opens.
  useEffect(() => {
    if (!open) return
    const seed: Record<string, string> = {}
    for (const [code, rate] of originalByCode) seed[code] = rate
    setEdits(seed)
    setError(null)
  }, [open, originalByCode])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      for (const item of items) {
        const code = item.code
        const next = (edits[code] ?? '').trim()
        const original = originalByCode.get(code) ?? ''
        if (next === original) continue
        if (next === '') {
          if (original !== '') await remove.mutateAsync({ service_item_code: code })
          continue
        }
        const rate = Number(next)
        if (!Number.isFinite(rate) || rate < 0) {
          setError(`"${code}" rate must be a non-negative number.`)
          setSaving(false)
          return
        }
        await upsert.mutateAsync({ service_item_code: code, rate })
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DModal
      open={open}
      onClose={onClose}
      title="Company rates"
      width={640}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
          <span style={{ fontSize: 12, color: error ? 'var(--m-red)' : 'var(--m-ink-3)' }}>
            {error ?? 'Blank = use the catalog default. Company rates apply to every project unless overridden.'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <MButton variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </MButton>
            <MButton variant="primary" onClick={() => void handleSave()} disabled={saving || overridesQuery.isLoading}>
              {saving ? 'Saving…' : 'Save rates'}
            </MButton>
          </span>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: 2, maxHeight: '60vh', overflow: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 64px 110px 120px',
            gap: 10,
            padding: '6px 4px',
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
            position: 'sticky',
            top: 0,
            background: 'var(--m-paper)',
          }}
        >
          <span>Service item</span>
          <span>Unit</span>
          <span style={{ textAlign: 'right' }}>Default</span>
          <span style={{ textAlign: 'right' }}>Company rate</span>
        </div>
        {items.length === 0 ? (
          <div style={{ padding: 12, color: 'var(--m-ink-3)', fontSize: 13 }}>Loading items…</div>
        ) : null}
        {items.map((item) => {
          const def = item.default_rate == null ? null : Number(item.default_rate)
          const isFocus = focusCode != null && item.code === focusCode
          return (
            <label
              key={item.code}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1fr) 64px 110px 120px',
                gap: 10,
                alignItems: 'center',
                padding: '6px 4px',
                borderTop: '1px solid var(--m-line, rgba(0,0,0,0.06))',
                background: isFocus ? 'var(--m-card-soft, rgba(0,0,0,0.03))' : undefined,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0 }}>
                {item.code}
                <span style={{ color: 'var(--m-ink-3)', fontWeight: 400 }}> — {item.name}</span>
              </span>
              <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{item.unit || '—'}</span>
              <span className="num" style={{ textAlign: 'right', fontSize: 13, color: 'var(--m-ink-3)' }}>
                {def == null ? '—' : `$${def.toFixed(2)}`}
              </span>
              <MInput
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                autoFocus={isFocus}
                value={edits[item.code] ?? ''}
                placeholder={def == null ? 'default' : def.toFixed(2)}
                onChange={(e) => setEdits((prev) => ({ ...prev, [item.code]: e.target.value }))}
                style={{ width: '100%', textAlign: 'right', fontFamily: 'var(--m-num)' }}
              />
            </label>
          )
        })}
      </div>
    </DModal>
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

function SectionBody({ section }: { section: SectionDef }) {
  switch (section.key) {
    case 'company':
      return <CompanySection />
    case 'pricing-book':
      return <PricingBookSection />
    case 'loaded-labor':
      return <LoadedLaborSection />
    case 'hours':
      return <WorkingHoursSection />
    case 'integrations':
      return <IntegrationsSection />
    case 'roles':
      return <RolesSection />
    case 'notifications':
      return <NotificationsSection />
    case 'profile':
      return <ProfileSection />
    case 'help':
      return <HelpSection />
    default:
      return null
  }
}

export function OwnerSettings() {
  const [active, setActive] = useState<SectionKey>('company')
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
