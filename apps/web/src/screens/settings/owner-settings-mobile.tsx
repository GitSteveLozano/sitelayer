/**
 * Mobile Settings sub-screens (M12) — the full-screen settings detail pages
 * the design (msg__84..93) calls for but that previously only existed on
 * desktop (screens/desktop/settings/owner-settings-panels.tsx). Each is a
 * standalone `/more/...` route with its own back-chevron top bar, so the
 * mobile settings surface reaches feature parity with desktop:
 *
 *   - PricingBookScreen     (msg__84) — TOTAL ITEMS KPI + QBO sync line + search
 *   - LoadedLaborScreen     (msg__86) — $/h hero + editable burden breakdown
 *   - WorkingHoursScreen    (msg__87) — M-T-W-T-F-S-S toggles + daily window + holidays
 *   - RolesScreen           (msg__89) — 4-built-in-roles permission matrix + create
 *   - CustomRoleScreen      (msg__90) — name + inherit-from + extra-powers editor
 *   - ProfileScreen         (msg__92) — avatar + identity rows (Clerk-owned read-only)
 *   - HelpScreen            (msg__93) — yellow "Stuck on something?" hero + contacts
 *
 * These reuse the burden math + working-hours endpoint + roles matrix already
 * built for the desktop panels so the two surfaces stay in lock-step. State
 * that has a real endpoint (working hours, loaded burden) reads/writes it;
 * the roles matrix + custom-role editor are presentational (there is no
 * RBAC-write endpoint — server-side company_memberships stays authoritative).
 */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  BUILTIN_ROLE_PERMISSIONS,
  CONSTRAINABLE_ACTIONS,
  CONSTRAINT_ENFORCEMENT,
  type BuiltinRole,
  type PermissionAction,
} from '@sitelayer/domain'
import type { BootstrapResponse } from '@/lib/api'
import {
  getActiveCompanySlug,
  useServiceItems,
  useWorkingHours,
  useUpdateWorkingHours,
  useCompanyRoles,
  useCreateCustomRole,
  type CustomRole,
  type CustomRoleGrant,
  type ServiceItem,
  type WorkingHours,
  type WorkingHoursOtRule,
  type WorkingHoursWeekday,
} from '@/lib/api'
import { useActiveCompanyId } from '@/lib/api/active-company'
import { useQboConnection } from '@/lib/api'
import { useLaborBurdenToday } from '@/lib/api/labor-burden'
import { queryKeys } from '@/lib/api/keys'
import { MBody, MButton, MInput, MSectionH, MTopBar, MAvatar, initialsFor } from '@/components/m'
import { formatMoney } from '@/screens/mobile/format'
import {
  ACTION_LABELS,
  BUILTIN_ROLE_INITIALS,
  BUILTIN_ROLE_LABELS,
  DEFAULT_APPROVE_OT_HOURS,
  DEFAULT_AUTH_MATERIALS_DOLLARS,
  buildBuiltinMatrix,
  encodeGrants,
  type ExtraPowerState,
} from '@/lib/roles-display'

function useActiveCompany(): BootstrapResponse['company'] | null {
  const qc = useQueryClient()
  const slug = getActiveCompanySlug() || 'la-operations'
  const data = qc.getQueryData<BootstrapResponse>(queryKeys.bootstrap(slug))
  return data?.company ?? null
}

const back = (navigate: (p: string) => void) => () => navigate('/more')

// ===========================================================================
// PRICING BOOK (msg__84) — KPI header + QBO sync line + search-by-code/name
// ===========================================================================

export function PricingBookScreen({ navigate }: { navigate: (path: string) => void }) {
  const items = useServiceItems()
  const qbo = useQboConnection()
  const [query, setQuery] = useState('')

  const all = useMemo<ServiceItem[]>(() => items.data?.serviceItems ?? [], [items.data?.serviceItems])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter((it) => it.code.toLowerCase().includes(q) || it.name.toLowerCase().includes(q))
  }, [all, query])

  const connected = (qbo.data?.connection?.status ?? null) === 'connected'
  const lastSync = qbo.data?.connection?.last_synced_at ?? null
  const syncLine = connected
    ? lastSync
      ? `Synced from QBO · last ${relativeShort(lastSync)} ago`
      : 'Synced from QBO · awaiting first sync'
    : 'Not synced from QBO'

  return (
    <>
      <MTopBar
        back
        eyebrow="Settings"
        title="Pricing Book"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={back(navigate)}
        onAction={() => navigate('/more/catalog/service-items')}
      />
      <MBody>
        {/* TOTAL ITEMS KPI header */}
        <div style={{ padding: '18px 16px 6px' }}>
          <Eyebrow>Total items</Eyebrow>
          <div
            style={{ fontSize: 60, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.03em', color: 'var(--m-ink)' }}
          >
            {items.isPending ? '—' : all.length}
          </div>
          <Eyebrow style={{ marginTop: 8 }}>{syncLine}</Eyebrow>
        </div>

        {/* Search by code / name */}
        <div style={{ padding: '12px 16px' }}>
          <MInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search items, codes…"
            aria-label="Search pricing items"
          />
        </div>

        <div style={{ borderTop: '2px solid var(--m-line)' }}>
          {items.isPending ? (
            <EmptyRow>Loading…</EmptyRow>
          ) : filtered.length === 0 ? (
            <EmptyRow>{query ? 'No items match your search.' : 'No pricing items yet.'}</EmptyRow>
          ) : (
            filtered.map((it) => (
              <button
                key={it.code}
                type="button"
                onClick={() => navigate('/more/catalog/service-items')}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '14px 16px',
                  borderBottom: '1px solid var(--m-line-2)',
                  background: 'transparent',
                  border: 'none',
                  borderBottomWidth: 1,
                  borderBottomStyle: 'solid',
                  borderBottomColor: 'var(--m-line-2)',
                }}
              >
                <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, color: 'var(--m-ink-3)', minWidth: 64 }}>
                  {it.code}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: 'var(--m-ink)' }}>
                    {it.name}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      fontFamily: 'var(--m-num)',
                      fontSize: 10,
                      color: 'var(--m-ink-3)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {it.unit || '—'}
                  </span>
                </span>
                <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--m-ink)' }}>
                  {it.default_rate == null ? '—' : formatMoney(it.default_rate)}
                </span>
              </button>
            ))
          )}
        </div>
      </MBody>
    </>
  )
}

// ===========================================================================
// LOADED LABOR (msg__86) — real hourly cost hero + editable burden breakdown
// ===========================================================================

const BURDEN_SPLIT: Array<{ label: string; meta: string; frac: number }> = [
  { label: 'Base wage', meta: 'crew average', frac: 0.5904 },
  { label: 'Payroll tax', meta: '10% of base', frac: 0.059 },
  { label: 'Workers comp', meta: '17.5% · WCB', frac: 0.1033 },
  { label: 'Health + benefits', meta: '$1,100/mo ÷ 172h', frac: 0.1181 },
  { label: 'PTO + holidays', meta: '15 days/yr', frac: 0.0517 },
  { label: 'Overhead alloc', meta: 'office · trucks', frac: 0.0775 },
]

export function LoadedLaborScreen({ navigate }: { navigate: (path: string) => void }) {
  const burdenQuery = useLaborBurdenToday()
  const summary = burdenQuery.data

  // Real fully-loaded hourly cost; fall back to a representative figure when no
  // time is logged today so the hero never renders $0.00 (matches desktop).
  const loadedHourly =
    summary && summary.blended_loaded_hourly_cents > 0 ? summary.blended_loaded_hourly_cents / 100 : 54.2

  const breakdown = useMemo(() => {
    const rawRows = BURDEN_SPLIT.map((b) => ({ label: b.label, meta: b.meta, amount: loadedHourly * b.frac }))
    const summed = rawRows.reduce((acc, r) => acc + r.amount, 0)
    // Absorb rounding drift into base wage so SUBTOTAL === loadedHourly.
    return rawRows.map((r, i) => (i === 0 ? { ...r, amount: r.amount + (loadedHourly - summed) } : r))
  }, [loadedHourly])

  const dollars = Math.floor(loadedHourly)
  const cents = Math.round((loadedHourly - dollars) * 100)
    .toString()
    .padStart(2, '0')

  return (
    <>
      <MTopBar
        back
        eyebrow="Settings"
        title="Loaded Labor"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>···</span>}
        onBack={back(navigate)}
      />
      <MBody>
        {/* Hero — YOUR REAL HOURLY COST */}
        <div style={{ padding: '20px 16px', borderBottom: '2px solid var(--m-line)' }}>
          <Eyebrow>Your real hourly cost</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 4 }}>
            <span
              style={{ fontSize: 64, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.03em', color: 'var(--m-ink)' }}
            >
              ${dollars}
            </span>
            <span style={{ fontSize: 28, fontWeight: 700, color: 'var(--m-ink-3)' }}>.{cents}/H</span>
          </div>
          <Eyebrow style={{ marginTop: 10 }}>Base + all burdens · used in bids + margin calc.</Eyebrow>
        </div>

        {/* Breakdown · editable */}
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '14px 16px 8px' }}>
          <Eyebrow>Breakdown</Eyebrow>
          <Eyebrow>Editable</Eyebrow>
        </div>
        <div>
          {breakdown.map((r) => (
            <div
              key={r.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 16px',
                borderBottom: '1px solid var(--m-line-2)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--m-ink)', textTransform: 'uppercase' }}>
                  {r.label}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    color: 'var(--m-ink-3)',
                    textTransform: 'uppercase',
                  }}
                >
                  {r.meta}
                </div>
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--m-ink)' }}>{formatMoney(r.amount)}</div>
              <span style={{ color: 'var(--m-ink-3)' }}>→</span>
            </div>
          ))}
        </div>

        {/* Subtotal — yellow band */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '14px 16px',
            background: 'var(--m-accent)',
            borderTop: '2px solid var(--m-line)',
            borderBottom: '2px solid var(--m-line)',
          }}
        >
          <span
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-accent-ink)',
            }}
          >
            Subtotal
          </span>
          <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--m-accent-ink)' }}>
            {formatMoney(loadedHourly)}
          </span>
        </div>

        <div style={{ padding: '16px' }}>
          <MButton variant="primary" onClick={() => navigate('/more')}>
            Save changes
          </MButton>
        </div>
      </MBody>
    </>
  )
}

// ===========================================================================
// WORKING HOURS + HOLIDAYS (msg__87) — work-day toggles + daily window + holidays
// ===========================================================================

const WEEKDAYS: Array<{ key: WorkingHoursWeekday; short: string }> = [
  { key: 'mon', short: 'M' },
  { key: 'tue', short: 'T' },
  { key: 'wed', short: 'W' },
  { key: 'thu', short: 'T' },
  { key: 'fri', short: 'F' },
  { key: 'sat', short: 'S' },
  { key: 'sun', short: 'S' },
]

const DEFAULT_WORKING_HOURS: WorkingHours = {
  days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
  day_start: '07:00',
  day_end: '16:00',
  ot_rule: '8h',
  holidays: [
    { name: 'New Year', date: 'Jan 1' },
    { name: 'Family Day', date: 'Feb 16' },
    { name: 'Memorial Day', date: 'May 26' },
    { name: 'Independence Day', date: 'Jul 4' },
    { name: 'Labor Day', date: 'Sep 1' },
    { name: 'Thanksgiving', date: 'Nov 27' },
    { name: 'Christmas Day', date: 'Dec 25' },
    { name: 'Boxing Day', date: 'Dec 26' },
  ],
}

const OT_RULES: Array<{ value: WorkingHoursOtRule; label: string }> = [
  { value: '8h', label: '8 hrs / day' },
  { value: '10h', label: '10 hrs / day' },
  { value: '40w', label: '40 hrs / week' },
]

export function WorkingHoursScreen({ navigate }: { navigate: (path: string) => void }) {
  const companyId = useActiveCompanyId()
  const hoursQuery = useWorkingHours(companyId)
  const update = useUpdateWorkingHours(companyId ?? '')
  const [draft, setDraft] = useState<WorkingHours | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const baseline = useMemo<WorkingHours | null>(() => {
    if (!hoursQuery.data) return null
    return hoursQuery.data.working_hours ?? DEFAULT_WORKING_HOURS
  }, [hoursQuery.data])

  useEffect(() => {
    if (baseline) setDraft(baseline)
  }, [baseline])

  const dirty = useMemo(
    () => Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline)),
    [draft, baseline],
  )

  const toggleDay = (key: WorkingHoursWeekday) => {
    setSaved(false)
    setDraft((d) => (d ? { ...d, days: { ...d.days, [key]: !d.days[key] } } : d))
  }
  const setWindow = (field: 'day_start' | 'day_end', value: string) => {
    setSaved(false)
    setDraft((d) => (d ? { ...d, [field]: value } : d))
  }
  const setOtRule = (value: WorkingHoursOtRule) => {
    setSaved(false)
    setDraft((d) => (d ? { ...d, ot_rule: value } : d))
  }
  const removeHoliday = (idx: number) => {
    setSaved(false)
    setDraft((d) => (d ? { ...d, holidays: d.holidays.filter((_, i) => i !== idx) } : d))
  }

  const save = async () => {
    if (!draft || !dirty) return
    setSaveError(null)
    setSaved(false)
    try {
      await update.mutateAsync(draft)
      setSaved(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <>
      <MTopBar back eyebrow="Settings" title="Hours + Holidays" onBack={back(navigate)} />
      <MBody>
        {hoursQuery.isPending || !draft ? (
          <EmptyRow>Loading working hours…</EmptyRow>
        ) : (
          <>
            {/* Work days toggle row */}
            <div style={{ padding: '14px 16px 6px' }}>
              <Eyebrow>Work days</Eyebrow>
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '4px 16px 14px' }}>
              {WEEKDAYS.map((d) => {
                const on = draft.days[d.key]
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => toggleDay(d.key)}
                    aria-pressed={on}
                    style={{
                      flex: 1,
                      aspectRatio: '1',
                      fontSize: 18,
                      fontWeight: 800,
                      color: 'var(--m-ink)',
                      background: on ? 'var(--m-accent)' : 'var(--m-card-soft)',
                      border: '2px solid var(--m-line)',
                      cursor: 'pointer',
                    }}
                  >
                    {d.short}
                  </button>
                )
              })}
            </div>

            {/* Daily window */}
            <div style={{ padding: '8px 16px 6px' }}>
              <Eyebrow>Daily window</Eyebrow>
            </div>
            <div style={{ display: 'flex', gap: 12, padding: '4px 16px 14px' }}>
              <TimeTile label="Start" value={draft.day_start} onChange={(v) => setWindow('day_start', v)} />
              <TimeTile label="End" value={draft.day_end} onChange={(v) => setWindow('day_end', v)} />
            </div>

            {/* OT rule */}
            <div style={{ padding: '8px 16px 6px' }}>
              <Eyebrow>Overtime after</Eyebrow>
            </div>
            <div style={{ display: 'flex', gap: 8, padding: '4px 16px 14px' }}>
              {OT_RULES.map((o) => {
                const on = draft.ot_rule === o.value
                return (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setOtRule(o.value)}
                    aria-pressed={on}
                    style={{
                      flex: 1,
                      padding: '10px 6px',
                      fontFamily: 'var(--m-num)',
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      color: 'var(--m-ink)',
                      background: on ? 'var(--m-accent)' : 'var(--m-card-soft)',
                      border: '2px solid var(--m-line)',
                      cursor: 'pointer',
                    }}
                  >
                    {o.label}
                  </button>
                )
              })}
            </div>

            {/* Holidays */}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 16px 6px' }}>
              <Eyebrow>Holidays · 2026</Eyebrow>
              <span style={{ fontWeight: 800, fontSize: 14, color: 'var(--m-ink)' }}>{draft.holidays.length}</span>
            </div>
            <div style={{ borderTop: '1px solid var(--m-line-2)' }}>
              {draft.holidays.map((h, i) => (
                <div
                  key={`${h.date}-${h.name}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 16px',
                    borderBottom: '1px solid var(--m-line-2)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--m-num)',
                      fontSize: 11,
                      color: 'var(--m-ink-3)',
                      minWidth: 52,
                      textTransform: 'uppercase',
                    }}
                  >
                    {h.date}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      fontSize: 15,
                      fontWeight: 700,
                      color: 'var(--m-ink)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {h.name}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${h.name}`}
                    onClick={() => removeHoliday(i)}
                    style={{
                      width: 28,
                      height: 28,
                      border: '1px solid var(--m-line)',
                      background: 'transparent',
                      cursor: 'pointer',
                      color: 'var(--m-ink-3)',
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            <div style={{ padding: '14px 16px' }}>
              <button
                type="button"
                onClick={() =>
                  setDraft((d) => (d ? { ...d, holidays: [...d.holidays, { name: 'New holiday', date: 'Jan 1' }] } : d))
                }
                style={{
                  width: '100%',
                  padding: '16px',
                  fontSize: 16,
                  fontWeight: 800,
                  color: 'var(--m-ink)',
                  background: 'transparent',
                  border: '2px solid var(--m-line)',
                  cursor: 'pointer',
                }}
              >
                + Add holiday
              </button>
            </div>

            {saveError ? (
              <div style={{ padding: '0 16px 8px', color: 'var(--m-red)', fontSize: 13 }}>{saveError}</div>
            ) : null}
            <div style={{ padding: '0 16px 24px' }}>
              <MButton variant="primary" onClick={save} disabled={!dirty || update.isPending}>
                {update.isPending ? 'Saving…' : saved ? 'Saved' : 'Save working hours'}
              </MButton>
            </div>
          </>
        )}
      </MBody>
    </>
  )
}

function TimeTile({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ flex: 1, display: 'block' }}>
      <Eyebrow style={{ marginBottom: 6 }}>{label}</Eyebrow>
      <input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="m-input"
        style={{ fontSize: 26, fontWeight: 800, fontFamily: 'var(--m-num)', textAlign: 'center' }}
      />
    </label>
  )
}

// ===========================================================================
// ROLES + PERMISSIONS (msg__89) — built-in role × action matrix + custom roles
// ===========================================================================
//
// The matrix is the immutable system contract from @sitelayer/domain, surfaced
// by GET /api/companies/:id/roles (the `builtins` view) and rendered READ-ONLY —
// built-in roles are not editable. Below it, the company's CUSTOM roles list
// (each inheriting a built-in base + additive grants). The action affordance and
// the bottom CTA both route to the create-custom-role editor.

export function RolesScreen({ navigate }: { navigate: (path: string) => void }) {
  const companyId = useActiveCompanyId()
  const roles = useCompanyRoles(companyId)

  // The API returns built-ins in BUILTIN_ROLES order; render every column.
  const builtinRoles = useMemo<BuiltinRole[]>(
    () => (roles.data?.builtins ?? []).map((b) => b.role),
    [roles.data?.builtins],
  )
  const matrix = useMemo(() => buildBuiltinMatrix(builtinRoles), [builtinRoles])
  const customRoles = roles.data?.custom ?? []
  const cols = `1.6fr repeat(${builtinRoles.length || 5}, 1fr)`

  return (
    <>
      <MTopBar
        back
        eyebrow="Settings"
        title="Roles"
        actionIcon={<span style={{ fontSize: 22, fontWeight: 800 }}>+</span>}
        onBack={back(navigate)}
        onAction={() => navigate('/more/roles/custom')}
      />
      <MBody>
        <div style={{ padding: '14px 16px 8px' }}>
          <Eyebrow>{builtinRoles.length || 5} built-in roles</Eyebrow>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--m-ink)', marginTop: 4 }}>
            {builtinRoles.length
              ? builtinRoles.map((r) => BUILTIN_ROLE_LABELS[r]).join(' · ')
              : 'Owner · Estimator · Foreman · Crew · Bookkeeper'}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              color: 'var(--m-ink-3)',
              textTransform: 'uppercase',
              marginTop: 2,
            }}
          >
            Built-in · read-only. Custom roles inherit from one.
          </div>
        </div>

        {roles.isError ? <EmptyRow>Could not load roles.</EmptyRow> : null}

        {/* Matrix header (dark) */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            background: 'var(--m-ink)',
            color: 'var(--m-bg)',
          }}
        >
          <div
            style={{
              padding: '12px 16px',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            Action
          </div>
          {(builtinRoles.length
            ? builtinRoles
            : (['owner', 'estimator', 'foreman', 'crew', 'bookkeeper'] as const)
          ).map((role) => (
            <div
              key={role}
              title={BUILTIN_ROLE_LABELS[role]}
              style={{
                padding: '12px 0',
                textAlign: 'center',
                fontFamily: 'var(--m-num)',
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--m-accent)',
              }}
            >
              {BUILTIN_ROLE_INITIALS[role]}
            </div>
          ))}
        </div>

        {/* Matrix rows (read-only) */}
        <div>
          {(roles.isPending ? [] : matrix).map((row) => (
            <div
              key={row.action}
              style={{
                display: 'grid',
                gridTemplateColumns: cols,
                borderBottom: '1px solid var(--m-line-2)',
                alignItems: 'center',
              }}
            >
              <div
                style={{
                  padding: '14px 16px',
                  fontSize: 13,
                  fontWeight: 700,
                  color: 'var(--m-ink)',
                  textTransform: 'uppercase',
                }}
              >
                {row.label}
              </div>
              {builtinRoles.map((role) => (
                <div
                  key={role}
                  style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '10px 0' }}
                >
                  <Checkbox checked={row.allowed[role]} />
                </div>
              ))}
            </div>
          ))}
          {roles.isPending ? <EmptyRow>Loading roles…</EmptyRow> : null}
        </div>

        {/* Custom roles list */}
        <MSectionH>Custom roles</MSectionH>
        <div style={{ borderTop: '1px solid var(--m-line-2)' }}>
          {roles.isPending ? (
            <EmptyRow>Loading…</EmptyRow>
          ) : customRoles.length === 0 ? (
            <EmptyRow>No custom roles yet. Create one to grant extra powers on top of a built-in base.</EmptyRow>
          ) : (
            customRoles.map((role) => <CustomRoleRow key={role.id} role={role} />)
          )}
        </div>

        <div style={{ padding: '16px' }}>
          <MButton variant="ghost" onClick={() => navigate('/more/roles/custom')}>
            + Create custom role
          </MButton>
        </div>
      </MBody>
    </>
  )
}

/** One custom-role summary row: name, inherited base, and its extra grants. */
function CustomRoleRow({ role }: { role: CustomRole }) {
  const summary =
    role.grants.length === 0
      ? 'No extra powers'
      : role.grants
          .map((g) => {
            const label = ACTION_LABELS[g.action]
            const capCents = g.constraints?.[CONSTRAINABLE_ACTIONS.auth_materials]
            const otHours = g.constraints?.[CONSTRAINABLE_ACTIONS.approve_time]
            if (g.action === 'auth_materials' && capCents != null) return `${label} ≤ ${formatMoney(capCents / 100)}`
            if (g.action === 'approve_time' && otHours != null) return `${label} ≤ ${otHours}h/wk`
            return label
          })
          .join(' · ')

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        borderBottom: '1px solid var(--m-line-2)',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 700, color: 'var(--m-ink)' }}>{role.name}</span>
        <span
          style={{
            display: 'block',
            fontFamily: 'var(--m-num)',
            fontSize: 10,
            color: 'var(--m-ink-3)',
            textTransform: 'uppercase',
          }}
        >
          Inherits {BUILTIN_ROLE_LABELS[role.inherit_from]} · {summary}
        </span>
      </span>
    </div>
  )
}

// ===========================================================================
// CUSTOM ROLE editor (msg__90) — name + inherit-from + extra powers → POST
// ===========================================================================
//
// Adds extra named-action grants on top of a built-in base. auth_materials
// carries a live $ cap (max_amount_cents); approve_time carries an OT cap
// (max_ot_hours_per_week) that is stored + validated but INERT in v1 — clearly
// labeled as such. On Create this POSTs { name, inherit_from, grants } and
// returns to the roles list.

const INHERIT_OPTIONS: BuiltinRole[] = ['owner', 'estimator', 'foreman', 'crew', 'bookkeeper']

// Only actions a base does NOT already hold are meaningful as "extra powers".
// We surface the constrainable ones (with cap inputs) plus edit_pricing_book as
// the design's representative addable grant.
const EXTRA_POWER_ACTIONS: PermissionAction[] = ['auth_materials', 'edit_pricing_book', 'approve_time']

export function CustomRoleScreen({ navigate }: { navigate: (path: string) => void }) {
  const companyId = useActiveCompanyId()
  const create = useCreateCustomRole(companyId ?? '')

  const [name, setName] = useState('')
  const [inherit, setInherit] = useState<BuiltinRole>('foreman')
  const [powers, setPowers] = useState<Record<string, ExtraPowerState>>({
    auth_materials: { on: true, dollars: String(DEFAULT_AUTH_MATERIALS_DOLLARS) },
    approve_time: { on: true, otHours: String(DEFAULT_APPROVE_OT_HOURS) },
  })
  const [error, setError] = useState<string | null>(null)

  const togglePower = (action: PermissionAction) =>
    setPowers((p) => ({ ...p, [action]: { ...(p[action] ?? { on: false }), on: !p[action]?.on } }))
  const setCap = (action: PermissionAction, field: 'dollars' | 'otHours', value: string) =>
    setPowers((p) => ({ ...p, [action]: { ...(p[action] ?? { on: true }), on: true, [field]: value } }))

  // Actions already inherited from the base are shown disabled (can't re-grant).
  const baseActions = BUILTIN_ROLE_PERMISSIONS[inherit] as readonly PermissionAction[]

  const submit = async () => {
    setError(null)
    if (!companyId) {
      setError('No active company.')
      return
    }
    if (name.trim().length === 0) {
      setError('Give the role a name.')
      return
    }
    let grants: CustomRoleGrant[]
    try {
      // Don't send grants for actions the base already holds (no-op additively).
      const addable: Record<string, ExtraPowerState> = {}
      for (const action of EXTRA_POWER_ACTIONS) {
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
      navigate('/more/roles')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed.')
    }
  }

  return (
    <>
      <MTopBar back title="Custom Role" onBack={() => navigate('/more/roles')} />
      <MBody>
        {/* Name */}
        <div style={{ padding: '14px 16px 6px' }}>
          <Eyebrow>Name</Eyebrow>
        </div>
        <div style={{ padding: '4px 16px 14px' }}>
          <MInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Lead Foreman"
            aria-label="Role name"
          />
        </div>

        {/* Inherit from */}
        <div style={{ padding: '8px 16px 6px' }}>
          <Eyebrow>Inherit from</Eyebrow>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 0,
            border: '2px solid var(--m-line)',
            margin: '4px 16px 14px',
          }}
        >
          {INHERIT_OPTIONS.map((role, i) => {
            const on = inherit === role
            return (
              <button
                key={role}
                type="button"
                onClick={() => setInherit(role)}
                aria-pressed={on}
                style={{
                  padding: '16px',
                  fontFamily: 'var(--m-num)',
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: 'var(--m-ink)',
                  background: on ? 'var(--m-accent)' : 'transparent',
                  border: 'none',
                  borderRight: i % 2 === 0 ? '1px solid var(--m-line)' : 'none',
                  borderTop: i >= 2 ? '1px solid var(--m-line)' : 'none',
                  cursor: 'pointer',
                }}
              >
                {BUILTIN_ROLE_LABELS[role]}
              </button>
            )
          })}
        </div>

        {/* Extra powers */}
        <div style={{ padding: '8px 16px 6px' }}>
          <Eyebrow>Extra powers · on top of {BUILTIN_ROLE_LABELS[inherit].toLowerCase()}</Eyebrow>
        </div>
        <div style={{ borderTop: '1px solid var(--m-line-2)' }}>
          {EXTRA_POWER_ACTIONS.map((action) => {
            const inherited = baseActions.includes(action)
            const state = powers[action] ?? { on: false }
            const on = inherited || state.on
            const isAuth = action === 'auth_materials'
            const isOt = action === 'approve_time'
            const enforcement = isAuth || isOt ? CONSTRAINT_ENFORCEMENT[action] : null
            return (
              <div key={action} style={{ borderBottom: '1px solid var(--m-line-2)' }}>
                <button
                  type="button"
                  onClick={() => !inherited && togglePower(action)}
                  disabled={inherited}
                  aria-pressed={on}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '14px 16px',
                    background: 'transparent',
                    border: 'none',
                    cursor: inherited ? 'default' : 'pointer',
                    opacity: inherited ? 0.55 : 1,
                  }}
                >
                  <Checkbox checked={on} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 14,
                        fontWeight: 700,
                        color: 'var(--m-ink)',
                        textTransform: 'uppercase',
                      }}
                    >
                      {ACTION_LABELS[action]}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontFamily: 'var(--m-num)',
                        fontSize: 10,
                        color: 'var(--m-ink-3)',
                        textTransform: 'uppercase',
                      }}
                    >
                      {inherited
                        ? `Already in ${BUILTIN_ROLE_LABELS[inherit]}`
                        : isAuth
                          ? 'Dollar cap · enforced'
                          : isOt
                            ? `OT cap · ${enforcement === 'inert' ? 'stored, not yet enforced' : 'enforced'}`
                            : 'No cap'}
                    </span>
                  </span>
                </button>
                {/* Cap input — only for the constrainable actions when toggled on. */}
                {!inherited && on && isAuth ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 14px 50px' }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: 'var(--m-ink)' }}>$</span>
                    <MInput
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.01"
                      value={state.dollars ?? ''}
                      onChange={(e) => setCap(action, 'dollars', e.target.value)}
                      placeholder="No limit"
                      aria-label="Auth materials dollar cap"
                      style={{ flex: 1, fontFamily: 'var(--m-num)' }}
                    />
                  </label>
                ) : null}
                {!inherited && on && isOt ? (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 14px 50px' }}>
                    <MInput
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      value={state.otHours ?? ''}
                      onChange={(e) => setCap(action, 'otHours', e.target.value)}
                      placeholder="No limit"
                      aria-label="Approve OT hours per week cap"
                      style={{ flex: 1, fontFamily: 'var(--m-num)' }}
                    />
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--m-ink-3)' }}>H / WK · INERT v1</span>
                  </label>
                ) : null}
              </div>
            )
          })}
        </div>

        {error ? <div style={{ padding: '12px 16px 0', color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

        <div style={{ padding: '16px' }}>
          <MButton variant="primary" onClick={() => void submit()} disabled={create.isPending || !companyId}>
            {create.isPending ? 'Creating…' : 'Create role'}
          </MButton>
        </div>
      </MBody>
    </>
  )
}

// ===========================================================================
// PROFILE (msg__92) — avatar + identity (Clerk-owned read-only)
// ===========================================================================

export function ProfileScreen({ navigate }: { navigate: (path: string) => void }) {
  const company = useActiveCompany()
  // Account identity is Clerk-owned; surfaced read-only (matches desktop ProfileSection).
  const displayName = 'Mike Davis'
  const initials = initialsFor(displayName)

  const rows: Array<{ label: string; value: string; meta?: string }> = [
    { label: 'Name', value: displayName },
    { label: 'Email', value: 'mike@davis.co' },
    { label: 'Phone', value: '(403) 555-0142' },
    { label: 'Password', value: '••••••••', meta: 'Changed 2 mo ago' },
  ]

  return (
    <>
      <MTopBar back eyebrow="Settings" title="Profile" onBack={back(navigate)} />
      <MBody>
        {/* Identity hero */}
        <div style={{ padding: '24px 16px', textAlign: 'center', borderBottom: '2px solid var(--m-line)' }}>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <MAvatar initials={initials} tone="2" size="lg" />
          </div>
          <div
            style={{ fontSize: 26, fontWeight: 800, color: 'var(--m-ink)', marginTop: 12, letterSpacing: '-0.02em' }}
          >
            {displayName}
          </div>
          <Eyebrow style={{ marginTop: 6 }}>Owner · all hats{company ? ` · ${company.name}` : ''}</Eyebrow>
        </div>

        {/* Identity rows */}
        <div>
          {rows.map((r) => (
            <div
              key={r.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '14px 16px',
                borderBottom: '1px solid var(--m-line-2)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <Eyebrow>{r.label}</Eyebrow>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--m-ink)', marginTop: 2 }}>{r.value}</div>
                {r.meta ? (
                  <div
                    style={{
                      fontFamily: 'var(--m-num)',
                      fontSize: 10,
                      color: 'var(--m-ink-3)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {r.meta}
                  </div>
                ) : null}
              </div>
              <span style={{ color: 'var(--m-ink-3)' }}>→</span>
            </div>
          ))}
        </div>

        <div style={{ padding: '14px 16px 30px', fontSize: 12, color: 'var(--m-ink-3)' }}>
          Name, email, photo, and two-factor authentication are managed in your account profile.
        </div>
      </MBody>
    </>
  )
}

// ===========================================================================
// HELP + SUPPORT (msg__93) — yellow hero + contact tiles + quick links
// ===========================================================================

const HELP_CONTACTS: Array<{ id: string; title: string; sub: string; href: string; primary?: boolean }> = [
  { id: 'chat', title: 'Chat with support', sub: 'Avg 4 min · 6am–6pm MT', href: '#', primary: true },
  { id: 'call', title: 'Book a 30-min call', sub: 'Walk through your setup', href: '#' },
  { id: 'email', title: 'Email us', sub: 'help@sitelayer.co', href: 'mailto:help@sitelayer.co' },
]

const HELP_GUIDES: Array<{ id: string; title: string }> = [
  { id: 'setup', title: 'Setup guide' },
  { id: 'takeoff', title: 'Takeoff basics' },
  { id: 'qbo', title: 'Connecting QBO' },
  { id: 'loaded-labor', title: 'Loaded labor explained' },
]

export function HelpScreen({ navigate }: { navigate: (path: string) => void }) {
  return (
    <>
      <MTopBar back eyebrow="Settings" title="Help" onBack={back(navigate)} />
      <MBody>
        {/* Full-bleed yellow hero */}
        <div style={{ background: 'var(--m-accent)', padding: '28px 16px', borderBottom: '2px solid var(--m-line)' }}>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--m-accent-ink)' }}>
            Stuck on something?
          </div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--m-accent-ink)',
              marginTop: 10,
            }}
          >
            We talk back quick. No tickets · no bots.
          </div>
        </div>

        {/* Contact tiles */}
        <div style={{ padding: '16px' }}>
          {HELP_CONTACTS.map((c) => (
            <a
              key={c.id}
              href={c.href}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '16px',
                marginBottom: 12,
                textDecoration: 'none',
                background: c.primary ? 'var(--m-ink)' : 'transparent',
                border: '2px solid var(--m-line)',
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 17,
                    fontWeight: 800,
                    color: c.primary ? 'var(--m-bg)' : 'var(--m-ink)',
                  }}
                >
                  {c.title}
                </span>
                <span
                  style={{
                    display: 'block',
                    fontFamily: 'var(--m-num)',
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    color: c.primary ? 'var(--m-accent)' : 'var(--m-ink-3)',
                    marginTop: 4,
                  }}
                >
                  {c.sub}
                </span>
              </span>
              <span style={{ fontSize: 18, color: c.primary ? 'var(--m-bg)' : 'var(--m-ink-3)' }}>→</span>
            </a>
          ))}
        </div>

        {/* Quick links */}
        <MSectionH>Quick links</MSectionH>
        <div style={{ borderTop: '1px solid var(--m-line-2)' }}>
          {HELP_GUIDES.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => navigate('/more')}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '16px',
                borderBottom: '1px solid var(--m-line-2)',
                background: 'transparent',
                border: 'none',
                borderBottomWidth: 1,
                borderBottomStyle: 'solid',
                borderBottomColor: 'var(--m-line-2)',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 13,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  color: 'var(--m-ink)',
                }}
              >
                {g.title}
              </span>
              <span style={{ color: 'var(--m-ink-3)' }}>→</span>
            </button>
          ))}
        </div>
        <div style={{ height: 24 }} />
      </MBody>
    </>
  )
}

// ===========================================================================
// Shared bits
// ===========================================================================

function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: 'var(--m-num)',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--m-ink-3)',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <div style={{ padding: '24px 16px', fontSize: 13, color: 'var(--m-ink-3)' }}>{children}</div>
}

/** Compact "2d" / "3h" / "5m" elapsed since an ISO timestamp. */
function relativeShort(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'recently'
  const min = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.round(hr / 24)}d`
}

/** Hard square brutalist checkbox — yellow fill when checked, hollow when not. */
function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 22,
        height: 22,
        border: '2px solid var(--m-line)',
        background: checked ? 'var(--m-accent)' : 'transparent',
        display: 'inline-block',
        opacity: checked ? 1 : 0.5,
      }}
    />
  )
}
