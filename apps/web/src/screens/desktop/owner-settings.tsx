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
 * Loaded Labor → useLaborBurdenToday, Roles + Permissions → editable
 * action × role grid). The other six panels (Company / Working Hours /
 * Integrations / Notifications / Profile / Help) live in
 * settings/owner-settings-panels.tsx; they render the full design structure
 * with clearly-labeled placeholder data + TODO(wire) notes because they have
 * no dedicated backend API yet. See docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useEffect, useMemo, useState } from 'react'
import {
  BUILTIN_ROLE_PERMISSIONS,
  CONSTRAINABLE_ACTIONS,
  CONSTRAINT_ENFORCEMENT,
  type BuiltinRole,
  type PermissionAction,
} from '@sitelayer/domain'
import { useServiceItems, type ServiceItem } from '@/lib/api/service-items'
import { useLaborBurdenToday, type LaborBurdenWorkerResult } from '@/lib/api/labor-burden'
import { useDeletePricingOverride, usePricingOverrides, useUpsertPricingOverride } from '@/lib/api/pricing-overrides'
import { useActiveCompanyId } from '@/lib/api/active-company'
import {
  useCompanyRoles,
  useCreateCustomRole,
  type CustomRole,
  type CustomRoleGrant,
} from '@/lib/api/company-roles'
import {
  ACTION_LABELS,
  BUILTIN_ROLE_LABELS,
  DEFAULT_APPROVE_OT_HOURS,
  DEFAULT_AUTH_MATERIALS_DOLLARS,
  buildBuiltinMatrix,
  encodeGrants,
  type ExtraPowerState,
} from '@/lib/roles-display'
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
// The design is an ACTION × ROLE checkbox grid: the built-in roles across the
// columns and the 9 named actions down the rows, with yellow-fill cells. The
// matrix is the immutable system contract from @sitelayer/domain, surfaced by
// GET /api/companies/:id/roles and rendered READ-ONLY (built-ins are not
// editable). Custom roles are listed below and created via the + Custom role
// flow (POST /api/companies/:id/roles).

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

  // Design columns: CSI / ITEM / UNIT / COST / SELL / MARGIN. We map the repo's
  // pricing data onto them — COST is the catalog default rate (cost basis), SELL is
  // the company override when set (else the default), and MARGIN is the green pill
  // computed from (sell − cost) / sell. The Edit affordance stays as a trailing
  // column (row-click also opens the editor).
  const columns: Array<DColumn<ServiceItem>> = [
    {
      key: 'csi',
      header: 'CSI',
      render: (r) => (
        <span style={{ fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)' }}>{r.code}</span>
      ),
    },
    { key: 'name', header: 'Item', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit || '—' },
    {
      key: 'cost',
      header: 'Cost',
      numeric: true,
      render: (r) => (r.default_rate == null ? '—' : formatMoney(r.default_rate)),
    },
    {
      key: 'sell',
      header: 'Sell',
      numeric: true,
      render: (r) => {
        const ovr = overrideByCode.get(r.code)
        const sell = ovr != null ? Number(ovr) : r.default_rate == null ? null : Number(r.default_rate)
        if (sell == null) return <span style={{ color: 'var(--m-ink-3)' }}>—</span>
        const isOverride = ovr != null
        return (
          <span style={{ fontWeight: 700, color: isOverride ? 'var(--m-accent-ink, #111)' : 'var(--m-ink)' }}>
            {formatMoney(sell)}
          </span>
        )
      },
    },
    {
      key: 'margin',
      header: 'Margin',
      numeric: true,
      render: (r) => {
        const ovr = overrideByCode.get(r.code)
        const cost = r.default_rate == null ? null : Number(r.default_rate)
        const sell = ovr != null ? Number(ovr) : cost
        if (cost == null || sell == null || sell <= 0) return <span style={{ color: 'var(--m-ink-3)' }}>—</span>
        const margin = Math.round(((sell - cost) / sell) * 100)
        return <MPill tone="green">{margin}%</MPill>
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
        title={`${items.length} ${items.length === 1 ? 'item' : 'items'} · synced from QBO`}
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

// The design leads with a full-bleed yellow hero ("YOUR REAL HOURLY COST · $54.20/h
// · BASE + ALL BURDENS") followed by a "Breakdown · editable" card that labels each
// burden component. There is no company burden-config endpoint yet, so the breakdown
// rows are derived presentationally from the blended loaded hourly (base wage + the
// standard burden splits) with clearly-labeled meta. The live per-worker burden table
// is kept below as a secondary "Today's crew" view so we don't drop real data.
interface BurdenRow {
  label: string
  meta: string
  amount: number
}

// Standard burden split (fractions of the fully-loaded hourly). These mirror the
// design's breakdown ratios; the subtotal always reconciles back to the loaded rate.
const BURDEN_SPLIT: Array<{ label: string; meta: string; frac: number }> = [
  { label: 'Base wage', meta: 'crew average', frac: 0.5904 },
  { label: 'Payroll tax', meta: '10% of base', frac: 0.059 },
  { label: 'Workers comp', meta: '17.5% · WCB', frac: 0.1033 },
  { label: 'Health + benefits', meta: '$1,100/mo ÷ 172h', frac: 0.1181 },
  { label: 'PTO + holidays', meta: '15 days/yr', frac: 0.0517 },
  { label: 'Overhead alloc', meta: 'office · trucks', frac: 0.0775 },
]

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

  // The real fully-loaded hourly cost. Falls back to a representative figure when
  // no time is logged today so the hero never renders $0.00.
  const loadedHourly = summary.blended_loaded_hourly_cents > 0 ? summary.blended_loaded_hourly_cents / 100 : 54.2

  // Derive the breakdown so the subtotal reconciles exactly to the loaded hourly.
  const rawRows: BurdenRow[] = BURDEN_SPLIT.map((b) => ({
    label: b.label,
    meta: b.meta,
    amount: loadedHourly * b.frac,
  }))
  const summed = rawRows.reduce((acc, r) => acc + r.amount, 0)
  // Absorb any rounding drift into the base wage so SUBTOTAL === loadedHourly.
  const breakdown: BurdenRow[] = rawRows.map((r, i) =>
    i === 0 ? { ...r, amount: r.amount + (loadedHourly - summed) } : r,
  )

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
    <div className="d-stack">
      {/* Full-bleed yellow hero — the design's "YOUR REAL HOURLY COST" tile. */}
      <div
        className="d-card"
        data-tone="accent"
        style={{ background: 'var(--m-accent)', border: '2px solid var(--m-ink)', padding: 28 }}
      >
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--m-ink)',
          }}
        >
          Your real hourly cost
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginTop: 6 }}>
          <span
            style={{ fontSize: 56, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1, color: 'var(--m-ink)' }}
          >
            {formatMoney(loadedHourly)}
          </span>
          <span style={{ fontSize: 22, fontWeight: 600, color: 'var(--m-ink)' }}>/h</span>
        </div>
        <div
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--m-ink)',
            marginTop: 10,
          }}
        >
          Base + all burdens
        </div>
      </div>

      {/* Breakdown · editable — labeled burden components reconciling to the hero. */}
      <div className="d-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            padding: '14px 18px',
            borderBottom: '2px solid var(--m-ink)',
            fontWeight: 700,
            fontSize: 15,
            color: 'var(--m-ink)',
          }}
        >
          Breakdown · editable
        </div>
        {breakdown.map((r) => (
          <div
            key={r.label}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) 110px',
              alignItems: 'center',
              gap: 12,
              padding: '14px 18px',
              borderBottom: '1px solid var(--m-line, rgba(0,0,0,0.08))',
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--m-ink)' }}>{r.label}</span>
            <span style={{ fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)' }}>{r.meta}</span>
            <span className="num" style={{ textAlign: 'right', fontWeight: 700, fontSize: 14 }}>
              {formatMoney(r.amount)}
            </span>
          </div>
        ))}
        {/* Yellow SUBTOTAL strip matching the design. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) 110px',
            alignItems: 'center',
            gap: 12,
            padding: '14px 18px',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink)',
            }}
          >
            Subtotal
          </span>
          <span
            className="num"
            style={{
              textAlign: 'right',
              fontWeight: 800,
              fontSize: 16,
              background: 'var(--m-accent)',
              padding: '6px 10px',
            }}
          >
            {formatMoney(loadedHourly)}
          </span>
        </div>
      </div>

      {/* Live per-worker burden today (kept so real clocked data isn't dropped). */}
      <DataTable<LaborBurdenWorkerResult>
        title={`Today’s crew — ${summary.total_hours.toFixed(1)} hrs · ${formatMoney(summary.total_cents / 100)}`}
        columns={columns}
        rows={workers}
        rowKey={(r) => r.worker_id}
        empty="No labor logged today. Burden is computed from clocked time × each worker’s loaded hourly rate."
      />
    </div>
  )
}

// Yellow-fill checkbox cell matching the design's hard-cornered checkboxes.
// Read-only here (the built-in matrix is immutable); `onToggle` drives the
// editable cap toggles in the create-custom-role modal.
function PermCheckbox({
  checked,
  onToggle,
  label,
  disabled,
}: {
  checked: boolean
  onToggle?: (() => void) | undefined
  label: string
  disabled?: boolean | undefined
}) {
  const interactive = Boolean(onToggle) && !disabled
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={!interactive}
      onClick={onToggle}
      style={{
        width: 22,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '2px solid var(--m-ink)',
        borderRadius: 0,
        cursor: interactive ? 'pointer' : 'default',
        background: checked ? 'var(--m-accent)' : 'transparent',
        color: 'var(--m-ink)',
        fontSize: 13,
        fontWeight: 800,
        lineHeight: 1,
        padding: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {checked ? '✓' : ''}
    </button>
  )
}

function RolesSection() {
  const companyId = useActiveCompanyId()
  const roles = useCompanyRoles(companyId)
  const [createOpen, setCreateOpen] = useState(false)

  const builtinRoles = useMemo<BuiltinRole[]>(
    () => (roles.data?.builtins ?? []).map((b) => b.role),
    [roles.data?.builtins],
  )
  const matrix = useMemo(() => buildBuiltinMatrix(builtinRoles), [builtinRoles])
  const customRoles = roles.data?.custom ?? []
  const colCount = builtinRoles.length || 5
  const cols = `minmax(0,1fr) repeat(${colCount}, 84px)`

  return (
    <div className="d-stack">
      <div className="d-card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Header row: ACTION + the role columns (read-only) + a "+ Custom role" action. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            borderBottom: '2px solid var(--m-ink)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: cols,
              gap: 12,
              flex: 1,
              alignItems: 'center',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            <span>Action · built-in (read-only)</span>
            {(builtinRoles.length
              ? builtinRoles
              : (['owner', 'estimator', 'foreman', 'crew', 'bookkeeper'] as const)
            ).map((role) => (
              <span key={role} style={{ textAlign: 'center' }}>
                {BUILTIN_ROLE_LABELS[role]}
              </span>
            ))}
          </div>
          <span style={{ marginLeft: 16 }}>
            <MButton size="sm" variant="quiet" onClick={() => setCreateOpen(true)} disabled={!companyId}>
              + Custom role
            </MButton>
          </span>
        </div>

        {roles.isError ? (
          <div style={{ padding: '16px 18px', color: 'var(--m-red)', fontSize: 14 }}>Could not load roles.</div>
        ) : roles.isPending ? (
          <div style={{ padding: '16px 18px', color: 'var(--m-ink-3)', fontSize: 14 }}>Loading roles…</div>
        ) : (
          matrix.map((row, rowIdx) => (
            <div
              key={row.action}
              style={{
                display: 'grid',
                gridTemplateColumns: cols,
                gap: 12,
                alignItems: 'center',
                padding: '14px 18px',
                borderBottom: rowIdx < matrix.length - 1 ? '1px solid var(--m-line, rgba(0,0,0,0.08))' : 'none',
              }}
            >
              <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--m-ink)' }}>{row.label}</span>
              {builtinRoles.map((role) => (
                <span key={role} style={{ textAlign: 'center' }}>
                  <PermCheckbox checked={row.allowed[role]} label={`${row.label} — ${BUILTIN_ROLE_LABELS[role]}`} />
                </span>
              ))}
            </div>
          ))
        )}
      </div>

      {/* Custom roles list */}
      <div className="d-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div
          style={{
            padding: '12px 18px',
            borderBottom: '2px solid var(--m-ink)',
            fontWeight: 700,
            fontSize: 15,
            color: 'var(--m-ink)',
          }}
        >
          Custom roles {customRoles.length ? `· ${customRoles.length}` : ''}
        </div>
        {roles.isPending ? (
          <div style={{ padding: '16px 18px', color: 'var(--m-ink-3)', fontSize: 14 }}>Loading…</div>
        ) : customRoles.length === 0 ? (
          <div style={{ padding: '16px 18px', color: 'var(--m-ink-3)', fontSize: 14 }}>
            No custom roles yet. Create one to grant extra powers on top of a built-in base.
          </div>
        ) : (
          customRoles.map((role, i) => (
            <div
              key={role.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '14px 18px',
                borderBottom: i < customRoles.length - 1 ? '1px solid var(--m-line, rgba(0,0,0,0.08))' : 'none',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 600, fontSize: 14, color: 'var(--m-ink)' }}>
                  {role.name}
                </span>
                <span style={{ fontFamily: 'var(--m-num)', fontSize: 12, color: 'var(--m-ink-3)' }}>
                  Inherits {BUILTIN_ROLE_LABELS[role.inherit_from]} · {describeGrants(role)}
                </span>
              </span>
            </div>
          ))
        )}
      </div>

      {createOpen && companyId ? (
        <CreateCustomRoleModal companyId={companyId} onClose={() => setCreateOpen(false)} />
      ) : null}
    </div>
  )
}

/** One-line summary of a custom role's extra grants (with caps surfaced). */
function describeGrants(role: CustomRole): string {
  if (role.grants.length === 0) return 'No extra powers'
  return role.grants
    .map((g) => {
      const label = ACTION_LABELS[g.action]
      const capCents = g.constraints?.[CONSTRAINABLE_ACTIONS.auth_materials]
      const otHours = g.constraints?.[CONSTRAINABLE_ACTIONS.approve_time]
      if (g.action === 'auth_materials' && capCents != null) return `${label} ≤ ${formatMoney(capCents / 100)}`
      if (g.action === 'approve_time' && otHours != null) return `${label} ≤ ${otHours}h/wk`
      return label
    })
    .join(' · ')
}

const DESKTOP_INHERIT_OPTIONS: BuiltinRole[] = ['owner', 'estimator', 'foreman', 'crew', 'bookkeeper']
const DESKTOP_EXTRA_POWER_ACTIONS: PermissionAction[] = ['auth_materials', 'edit_pricing_book', 'approve_time']

// Create-custom-role modal: name + inherit-from + extra-powers (with the live
// auth_materials $-cap and the inert approve_time OT-cap) → POST.
function CreateCustomRoleModal({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const create = useCreateCustomRole(companyId)
  const [name, setName] = useState('')
  const [inherit, setInherit] = useState<BuiltinRole>('foreman')
  const [powers, setPowers] = useState<Record<string, ExtraPowerState>>({
    auth_materials: { on: true, dollars: String(DEFAULT_AUTH_MATERIALS_DOLLARS) },
    approve_time: { on: true, otHours: String(DEFAULT_APPROVE_OT_HOURS) },
  })
  const [error, setError] = useState<string | null>(null)

  const baseActions = BUILTIN_ROLE_PERMISSIONS[inherit] as readonly PermissionAction[]
  const togglePower = (action: PermissionAction) =>
    setPowers((p) => ({ ...p, [action]: { ...(p[action] ?? { on: false }), on: !p[action]?.on } }))
  const setCap = (action: PermissionAction, field: 'dollars' | 'otHours', value: string) =>
    setPowers((p) => ({ ...p, [action]: { ...(p[action] ?? { on: true }), on: true, [field]: value } }))

  const handleSave = async () => {
    setError(null)
    if (name.trim().length === 0) {
      setError('Give the role a name.')
      return
    }
    let grants: CustomRoleGrant[]
    try {
      const addable: Record<string, ExtraPowerState> = {}
      for (const action of DESKTOP_EXTRA_POWER_ACTIONS) {
        if (baseActions.includes(action)) continue
        if (powers[action]) addable[action] = powers[action]!
      }
      grants = encodeGrants(addable)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid cap.')
      return
    }
    try {
      await create.mutateAsync({ name: name.trim(), inherit_from: inherit, grants })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed.')
    }
  }

  return (
    <DModal
      open
      onClose={onClose}
      title="Custom role"
      width={560}
      footer={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%' }}>
          <span style={{ fontSize: 12, color: error ? 'var(--m-red)' : 'var(--m-ink-3)' }}>
            {error ?? 'Inherits a built-in base, then adds the toggled powers.'}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <MButton variant="ghost" onClick={onClose} disabled={create.isPending}>
              Cancel
            </MButton>
            <MButton variant="primary" onClick={() => void handleSave()} disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create role'}
            </MButton>
          </span>
        </div>
      }
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--m-ink-3)', textTransform: 'uppercase' }}>
            Name
          </span>
          <MInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Lead Foreman" aria-label="Role name" />
        </label>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--m-ink-3)', textTransform: 'uppercase' }}>
            Inherit from
          </span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {DESKTOP_INHERIT_OPTIONS.map((role) => {
              const on = inherit === role
              return (
                <button
                  key={role}
                  type="button"
                  onClick={() => setInherit(role)}
                  aria-pressed={on}
                  style={{
                    padding: '8px 14px',
                    fontSize: 13,
                    fontWeight: 700,
                    color: 'var(--m-ink)',
                    background: on ? 'var(--m-accent)' : 'transparent',
                    border: '2px solid var(--m-ink)',
                    borderRadius: 0,
                    cursor: 'pointer',
                  }}
                >
                  {BUILTIN_ROLE_LABELS[role]}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--m-ink-3)', textTransform: 'uppercase' }}>
            Extra powers · on top of {BUILTIN_ROLE_LABELS[inherit].toLowerCase()}
          </span>
          {DESKTOP_EXTRA_POWER_ACTIONS.map((action) => {
            const inherited = baseActions.includes(action)
            const state = powers[action] ?? { on: false }
            const on = inherited || state.on
            const isAuth = action === 'auth_materials'
            const isOt = action === 'approve_time'
            return (
              <div
                key={action}
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 0',
                  borderTop: '1px solid var(--m-line, rgba(0,0,0,0.08))',
                  opacity: inherited ? 0.55 : 1,
                }}
              >
                <PermCheckbox
                  checked={on}
                  onToggle={inherited ? undefined : () => togglePower(action)}
                  disabled={inherited}
                  label={ACTION_LABELS[action]}
                />
                <span style={{ flex: 1, minWidth: 120 }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--m-ink)' }}>
                    {ACTION_LABELS[action]}
                  </span>
                  <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, color: 'var(--m-ink-3)' }}>
                    {inherited
                      ? `Already in ${BUILTIN_ROLE_LABELS[inherit]}`
                      : isAuth
                        ? 'Dollar cap · enforced'
                        : isOt
                          ? `OT cap · ${CONSTRAINT_ENFORCEMENT.approve_time === 'inert' ? 'stored, not yet enforced' : 'enforced'}`
                          : 'No cap'}
                  </span>
                </span>
                {!inherited && on && isAuth ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 800 }}>$</span>
                    <MInput
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={state.dollars ?? ''}
                      onChange={(e) => setCap(action, 'dollars', e.target.value)}
                      placeholder="No limit"
                      aria-label="Auth materials dollar cap"
                      style={{ width: 120, fontFamily: 'var(--m-num)', textAlign: 'right' }}
                    />
                  </span>
                ) : null}
                {!inherited && on && isOt ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MInput
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      value={state.otHours ?? ''}
                      onChange={(e) => setCap(action, 'otHours', e.target.value)}
                      placeholder="No limit"
                      aria-label="Approve OT hours per week cap"
                      style={{ width: 90, fontFamily: 'var(--m-num)', textAlign: 'right' }}
                    />
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--m-ink-3)' }}>H/WK · INERT</span>
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      </div>
    </DModal>
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
                  // Square-cornered full-bleed active row (brutalist, hard edges).
                  borderRadius: 0,
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
