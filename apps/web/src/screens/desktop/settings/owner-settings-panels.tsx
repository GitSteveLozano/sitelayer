/**
 * Owner desktop settings panels (Desktop v2 · Owner · Settings).
 *
 * These are the presentational settings panels that the design
 * (steve-desktop-3 · SETTINGS · COMPANY / WORKING HOURS / INTEGRATIONS /
 * NOTIFICATIONS / PROFILE / HELP) calls for. Where a real backend endpoint
 * exists they are now wired to live data + mutations:
 *
 *   - Notifications → GET/PUT /api/notification-preferences
 *     (useNotificationPreferences / useUpdateNotificationPreferences).
 *   - Integrations → QBO row reads GET /api/integrations/qbo (useQboConnection),
 *     connects via GET /api/integrations/qbo/auth (fetchQboAuthUrl), and syncs
 *     via POST /api/integrations/qbo/sync (useTriggerQboSync).
 *
 * Where no endpoint exists yet the panel keeps a clearly-labeled stub +
 * `TODO(wire)` / GAP note:
 *
 *   - Company extra fields (legal name / license / address / phone / website /
 *     logo) — no company-profile PATCH endpoint; only name+slug (bootstrap,
 *     read-only) and modules/settings exist.
 *   - Working Hours — no working-hours field or endpoint.
 *   - Profile — account identity is Clerk-owned; read-only here.
 *
 * Conventions: desktop `components/d` primitives (DataTable, DColumn) + the
 * shared `.d-card` / `.d-stack` classes + `var(--m-*)` tokens. No new global
 * CSS. Avatars / pills / buttons / form fields come from `components/m`.
 */
import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { BootstrapResponse } from '@/lib/api'
import {
  fetchQboAuthUrl,
  getActiveCompanySlug,
  queryKeys,
  useActiveCompanyId,
  useCompanyProfile,
  useNotificationPreferences,
  useQboConnection,
  useTriggerQboSync,
  useUpdateCompanyProfile,
  useUpdateNotificationPreferences,
  useUpdateWorkingHours,
  useWorkingHours,
  type CompanyProfile,
  type NotificationChannel,
  type WorkingHours,
  type WorkingHoursHoliday,
  type WorkingHoursOtRule,
  type WorkingHoursWeekday,
} from '@/lib/api'
import { DataTable, type DColumn } from '@/components/d'
import { MAvatar, MButton, MInput, MPill, MSelect } from '@/components/m'
import type { MTone } from '@/components/m'

// Small section-card primitive shared by the panels below. Mirrors the
// `.d-card` + `.d-eyebrow` treatment used elsewhere in this folder.
function SettingsCard({
  eyebrow,
  action,
  children,
}: {
  eyebrow: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="d-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div className="d-eyebrow">{eyebrow}</div>
        {action}
      </div>
      <div style={{ marginTop: 14 }}>{children}</div>
    </div>
  )
}

// Read-only labeled field used by the Company / Profile forms. Presentational
// today — the inputs carry default values but no submit wiring (see TODOs).
function Field({
  label,
  value,
  placeholder,
  hint,
  type = 'text',
  readOnly = false,
}: {
  label: string
  value?: string
  placeholder?: string
  hint?: string
  type?: string
  readOnly?: boolean
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        {label}
      </span>
      <MInput type={type} defaultValue={value} placeholder={placeholder} readOnly={readOnly} />
      {hint ? <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{hint}</span> : null}
    </label>
  )
}

// Controlled labeled field used by the editable Company / Working Hours
// forms. Same visual treatment as `Field` but value-driven so the panel
// owns the draft state.
function EditField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = 'text',
  disabled = false,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  placeholder?: string
  hint?: string
  type?: string
  disabled?: boolean
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        {label}
      </span>
      <MInput
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint ? <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{hint}</span> : null}
    </label>
  )
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 16,
      }}
    >
      {children}
    </div>
  )
}

// Reads the live company off the bootstrap query cache (same trick as
// useActiveCompanyId) so the Company / Profile panels can show the real
// company name + slug without taking props (OwnerSettings is propless).
function useActiveCompany(): BootstrapResponse['company'] | null {
  const qc = useQueryClient()
  const slug = getActiveCompanySlug() || 'la-operations'
  const data = qc.getQueryData<BootstrapResponse>(queryKeys.bootstrap(slug))
  return data?.company ?? null
}

// ---- COMPANY -------------------------------------------------------------
// Company name + slug stay live-from-bootstrap + read-only (they are set at
// company creation — there is no rename path). The editable identity fields
// (legal name / license / address / phone / website) are now backed by
// GET/PATCH /api/companies/:id/profile (migration 102). Logo upload is still
// unbuilt (would need a Spaces upload path) and stays out of scope.
type ProfileDraft = {
  legal_name: string
  license_no: string
  address: string
  phone: string
  website: string
}

const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  legal_name: '',
  license_no: '',
  address: '',
  phone: '',
  website: '',
}

function profileToDraft(profile: CompanyProfile): ProfileDraft {
  return {
    legal_name: profile.legal_name ?? '',
    license_no: profile.license_no ?? '',
    address: profile.address ?? '',
    phone: profile.phone ?? '',
    website: profile.website ?? '',
  }
}

export function CompanySection() {
  const company = useActiveCompany()
  const companyId = useActiveCompanyId()
  const profileQuery = useCompanyProfile(companyId)
  const update = useUpdateCompanyProfile(companyId ?? '')

  const [draft, setDraft] = useState<ProfileDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const server = profileQuery.data
  useEffect(() => {
    if (!server) return
    setDraft(profileToDraft(server))
  }, [server])

  const setField = (key: keyof ProfileDraft, value: string) => {
    setSaved(false)
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const serverDraft = server ? profileToDraft(server) : EMPTY_PROFILE_DRAFT
  const dirty = useMemo(() => {
    if (!draft || !server) return false
    return (Object.keys(EMPTY_PROFILE_DRAFT) as Array<keyof ProfileDraft>).some((k) => draft[k] !== serverDraft[k])
  }, [draft, server, serverDraft])

  const save = async () => {
    if (!draft || !server || !dirty) return
    setSaveError(null)
    setSaved(false)
    // Send only the changed fields. An emptied field is sent as null so the
    // server clears it (vs leaving the old value untouched).
    const patch: Partial<CompanyProfile> = {}
    for (const key of Object.keys(EMPTY_PROFILE_DRAFT) as Array<keyof ProfileDraft>) {
      if (draft[key] === serverDraft[key]) continue
      const trimmed = draft[key].trim()
      patch[key] = trimmed === '' ? null : trimmed
    }
    try {
      await update.mutateAsync(patch)
      setSaved(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <div className="d-stack">
      <SettingsCard eyebrow="Workspace">
        <FieldGrid>
          <Field
            label="Company name"
            value={company?.name ?? ''}
            placeholder="LA Operations"
            readOnly
            hint="Set at company creation."
          />
          {/* Trade / Crew size / Region complete the design's attribute set. There
              is no backend column for these yet, so they read-only from the profile
              where it overlaps (license is unrelated) and otherwise show placeholders. */}
          <Field label="Trade" value="" placeholder="Stucco / EIFS" readOnly hint="Primary trade." />
          <Field label="Crew size" value="" placeholder="18 · multi-crew" readOnly hint="Active crew headcount." />
          <Field label="Region" value="" placeholder="Calgary, AB" readOnly hint="Primary operating region." />
          <Field
            label="Business #"
            value={server?.license_no ?? ''}
            placeholder="BN 8042 11920"
            readOnly
            hint="License / business registration."
          />
          <Field label="Workspace URL" value={company?.slug ?? ''} hint="Used in links + the customer portal." readOnly />
        </FieldGrid>
      </SettingsCard>

      {profileQuery.isError ? (
        <div className="d-card" style={{ color: 'var(--m-red, #c7331e)', fontSize: 13 }}>
          Could not load company profile.
        </div>
      ) : null}

      <SettingsCard
        eyebrow="Business details"
        action={
          <MButton size="sm" variant="primary" onClick={save} disabled={!draft || !dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </MButton>
        }
      >
        <FieldGrid>
          <EditField
            label="Legal entity name"
            value={draft?.legal_name ?? ''}
            disabled={!draft}
            placeholder="LA Operations, Inc."
            onChange={(v) => setField('legal_name', v)}
          />
          <EditField
            label="Contractor license #"
            value={draft?.license_no ?? ''}
            disabled={!draft}
            placeholder="CSLB 1012345"
            onChange={(v) => setField('license_no', v)}
          />
          <EditField
            label="Main phone"
            type="tel"
            value={draft?.phone ?? ''}
            disabled={!draft}
            placeholder="(310) 555-0142"
            onChange={(v) => setField('phone', v)}
          />
          <EditField
            label="Website"
            type="url"
            value={draft?.website ?? ''}
            disabled={!draft}
            placeholder="https://laoperations.com"
            onChange={(v) => setField('website', v)}
          />
        </FieldGrid>
        <div style={{ marginTop: 16 }}>
          <EditField
            label="Business address"
            value={draft?.address ?? ''}
            disabled={!draft}
            placeholder="1200 Industrial Blvd, Los Angeles, CA 90021"
            onChange={(v) => setField('address', v)}
          />
        </div>
        {saveError ? (
          <div style={{ fontSize: 12, color: 'var(--m-red, #c7331e)', marginTop: 12 }}>{saveError}</div>
        ) : null}
        {saved && !dirty ? (
          <div style={{ fontSize: 12, color: 'var(--m-good, #2c7a3f)', marginTop: 12 }}>Saved.</div>
        ) : null}
        <div style={{ fontSize: 12, color: 'var(--m-ink-3)', marginTop: 12 }}>
          These flow through to estimates and invoices.
          {/* Logo upload is still unbuilt — it would need a Spaces upload path. */}
        </div>
      </SettingsCard>
    </div>
  )
}

// ---- WORKING HOURS -------------------------------------------------------
// Backed by GET/PUT /api/companies/:id/working-hours (migration 102). The
// endpoint returns the saved document or `null`; when null we hydrate the
// editor with the design defaults (Mon–Fri, 07:00–16:00, OT after 8h, the
// standard US holiday set) so the first save writes a complete document.
const WEEKDAY_ORDER: Array<{ key: WorkingHoursWeekday; label: string }> = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
]

const DEFAULT_WORKING_HOURS: WorkingHours = {
  days: { mon: true, tue: true, wed: true, thu: true, fri: true, sat: false, sun: false },
  day_start: '07:00',
  day_end: '16:00',
  ot_rule: '8h',
  holidays: [
    { name: 'New Year’s Day', date: 'Jan 1' },
    { name: 'Memorial Day', date: 'May 26' },
    { name: 'Independence Day', date: 'Jul 4' },
    { name: 'Labor Day', date: 'Sep 1' },
    { name: 'Thanksgiving', date: 'Nov 27' },
    { name: 'Christmas Day', date: 'Dec 25' },
  ],
}

const OT_RULE_OPTIONS: Array<{ value: WorkingHoursOtRule; label: string }> = [
  { value: '8h', label: '8 hrs / day' },
  { value: '10h', label: '10 hrs / day' },
  { value: '40w', label: '40 hrs / week' },
]

// Stable structural compare so "Save" only enables on a real change.
function workingHoursEqual(a: WorkingHours, b: WorkingHours): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

type HolidayRow = WorkingHoursHoliday & { rowKey: string }

export function WorkingHoursSection() {
  const companyId = useActiveCompanyId()
  const hoursQuery = useWorkingHours(companyId)
  const update = useUpdateWorkingHours(companyId ?? '')

  const [draft, setDraft] = useState<WorkingHours | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Hydrate from the server document, or the design defaults when the
  // company has never saved working hours (working_hours === null).
  const server = hoursQuery.data
  const baseline: WorkingHours | null = useMemo(() => {
    if (!server) return null
    return server.working_hours ?? DEFAULT_WORKING_HOURS
  }, [server])

  useEffect(() => {
    if (!baseline) return
    setDraft(baseline)
  }, [baseline])

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false
    return !workingHoursEqual(draft, baseline)
  }, [draft, baseline])

  const toggleDay = (key: WorkingHoursWeekday) => {
    setSaved(false)
    setDraft((prev) => (prev ? { ...prev, days: { ...prev.days, [key]: !prev.days[key] } } : prev))
  }

  const setWindow = (field: 'day_start' | 'day_end', value: string) => {
    setSaved(false)
    setDraft((prev) => (prev ? { ...prev, [field]: value } : prev))
  }

  const setOtRule = (value: WorkingHoursOtRule) => {
    setSaved(false)
    setDraft((prev) => (prev ? { ...prev, ot_rule: value } : prev))
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

  const holidayColumns: Array<DColumn<HolidayRow>> = [
    { key: 'name', header: 'Holiday', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'date', header: 'Date', render: (r) => r.date },
  ]
  const holidayRows: HolidayRow[] = (draft?.holidays ?? []).map((h, i) => ({ ...h, rowKey: `${i}-${h.name}` }))

  if (hoursQuery.isPending) {
    return (
      <div className="d-card" style={{ color: 'var(--m-ink-3)', fontSize: 14 }}>
        Loading working hours…
      </div>
    )
  }
  if (hoursQuery.isError) {
    return (
      <div className="d-card" style={{ color: 'var(--m-red, #c7331e)', fontSize: 14 }}>
        Could not load working hours.
      </div>
    )
  }

  return (
    <div className="d-stack">
      <SettingsCard
        eyebrow="Working days"
        action={
          <MButton size="sm" variant="primary" onClick={save} disabled={!draft || !dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save working hours'}
          </MButton>
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {WEEKDAY_ORDER.map((d) => {
            const on = draft ? draft.days[d.key] : false
            return (
              <button
                key={d.key}
                type="button"
                aria-pressed={on}
                disabled={!draft}
                onClick={() => toggleDay(d.key)}
                style={{
                  minWidth: 56,
                  padding: '10px 12px',
                  borderRadius: 'var(--m-radius, 10px)',
                  border: '1px solid var(--m-line, #ddd)',
                  cursor: draft ? 'pointer' : 'default',
                  fontSize: 13,
                  fontWeight: 600,
                  background: on ? 'var(--m-accent)' : 'transparent',
                  color: on ? 'var(--m-on-accent, #111)' : 'var(--m-ink-2)',
                }}
              >
                {d.label}
              </button>
            )
          })}
        </div>
        <div style={{ fontSize: 12, color: 'var(--m-ink-3)', marginTop: 10 }}>
          Working days drive crew scheduling + loaded-labor day counts.
        </div>
        {saveError ? (
          <div style={{ fontSize: 12, color: 'var(--m-red, #c7331e)', marginTop: 10 }}>{saveError}</div>
        ) : null}
        {saved && !dirty ? (
          <div style={{ fontSize: 12, color: 'var(--m-good, #2c7a3f)', marginTop: 10 }}>Saved.</div>
        ) : null}
      </SettingsCard>

      <SettingsCard eyebrow="Standard work window">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <EditField
            label="Day starts"
            type="time"
            value={draft?.day_start ?? ''}
            disabled={!draft}
            onChange={(v) => setWindow('day_start', v)}
          />
          <EditField
            label="Day ends"
            type="time"
            value={draft?.day_end ?? ''}
            disabled={!draft}
            onChange={(v) => setWindow('day_end', v)}
          />
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
              }}
            >
              OT after
            </span>
            <MSelect
              value={draft?.ot_rule ?? '8h'}
              disabled={!draft}
              onChange={(e) => setOtRule(e.target.value as WorkingHoursOtRule)}
              aria-label="Overtime threshold"
            >
              {OT_RULE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </MSelect>
          </label>
        </div>
        <div style={{ fontSize: 12, color: 'var(--m-ink-3)', marginTop: 10 }}>
          Overtime threshold feeds the loaded-labor burden calculation.
        </div>
      </SettingsCard>

      <DataTable<HolidayRow>
        title="Company holidays"
        columns={holidayColumns}
        rows={holidayRows}
        rowKey={(r) => r.rowKey}
        empty="No holidays yet. Holidays are excluded from crew schedules and burden day counts."
      />
    </div>
  )
}

// ---- INTEGRATIONS --------------------------------------------------------
// QBO row is wired to the real connection status + connect/sync flow. The
// other providers (Gusto / Stripe / Xero / Procore) genuinely don't exist
// as backend integrations — they stay "Coming soon" (not a gap, just not
// built).
type IntegrationStatus = 'connected' | 'available' | 'coming-soon'
type Integration = {
  id: string
  name: string
  blurb: string
  status: IntegrationStatus
}

const OTHER_INTEGRATIONS: Integration[] = [
  { id: 'gusto', name: 'Gusto', blurb: 'Push approved labor hours into payroll.', status: 'coming-soon' },
  { id: 'stripe', name: 'Stripe', blurb: 'Collect deposits + progress payments online.', status: 'coming-soon' },
  { id: 'xero', name: 'Xero', blurb: 'Alternative accounting sync for non-QBO shops.', status: 'coming-soon' },
  { id: 'procore', name: 'Procore', blurb: 'Share project + daily-log data with GCs.', status: 'coming-soon' },
]

const STATUS_PILL: Record<IntegrationStatus, { tone: MTone | undefined; label: string }> = {
  connected: { tone: 'green', label: 'Connected' },
  available: { tone: 'blue', label: 'Available' },
  'coming-soon': { tone: undefined, label: 'Coming soon' },
}

// A row carries either a static "coming soon" provider or the live QBO
// provider with its own action handlers.
type IntegrationRow =
  | { kind: 'static'; row: Integration }
  | {
      kind: 'qbo'
      row: Integration
      busy: boolean
      onConnect: () => void
      onSync: () => void
    }

export function IntegrationsSection() {
  const qbo = useQboConnection()
  const sync = useTriggerQboSync()
  const [error, setError] = useState<string | null>(null)
  const [authPending, setAuthPending] = useState(false)

  const conn = qbo.data?.connection
  const connStatus = conn?.status ?? 'disconnected'
  const isConnected = Boolean(conn) && connStatus !== 'disconnected'

  const onConnect = async () => {
    setError(null)
    setAuthPending(true)
    try {
      const { authUrl } = await fetchQboAuthUrl()
      if (typeof window !== 'undefined') window.location.href = authUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start OAuth')
      setAuthPending(false)
    }
  }

  const onSync = async () => {
    setError(null)
    try {
      await sync.mutateAsync()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    }
  }

  // QBO blurb reflects the live status (realm + last-sync) when connected.
  const qboBlurb = useMemo(() => {
    if (qbo.isPending) return 'Loading connection status…'
    if (!conn) return 'Sync customers, estimates, invoices + time activities.'
    const realm = conn.provider_account_id ?? '—'
    const last = conn.last_synced_at ? new Date(conn.last_synced_at).toLocaleString() : 'never'
    return `Realm ${realm} · last synced ${last}`
  }, [qbo.isPending, conn])

  const qboRow: Integration = {
    id: 'qbo',
    name: 'QuickBooks Online',
    blurb: qboBlurb,
    status: isConnected ? 'connected' : 'available',
  }

  const rows: IntegrationRow[] = [
    {
      kind: 'qbo',
      row: qboRow,
      busy: authPending || sync.isPending || connStatus === 'syncing',
      onConnect,
      onSync,
    },
    ...OTHER_INTEGRATIONS.map<IntegrationRow>((row) => ({ kind: 'static', row })),
  ]

  const columns: Array<DColumn<IntegrationRow>> = [
    {
      key: 'name',
      header: 'Integration',
      render: (r) => (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
          <span className="d-table-cell-strong">{r.row.name}</span>
          <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{r.row.blurb}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => {
        const p = STATUS_PILL[r.row.status]
        return (
          <MPill tone={p.tone} dot={r.row.status === 'connected'}>
            {p.label}
          </MPill>
        )
      },
    },
    {
      key: 'action',
      header: '',
      render: (r) => {
        if (r.kind === 'static') {
          // Coming-soon providers: a clearly-disabled chip (token-styled, dimmed
          // + not-allowed cursor) so the row reads as "planned, not broken"
          // rather than a dead em-dash or a clickable-looking CTA.
          return (
            <MButton
              size="sm"
              variant="quiet"
              disabled
              aria-disabled="true"
              style={{ opacity: 0.55, cursor: 'not-allowed' }}
            >
              Coming soon
            </MButton>
          )
        }
        // QBO row. Connected → "Run sync" + "Reconnect"; otherwise "Connect".
        if (r.row.status === 'connected') {
          return (
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <MButton size="sm" variant="primary" onClick={r.onSync} disabled={r.busy}>
                {sync.isPending || connStatus === 'syncing' ? 'Syncing…' : 'Run sync'}
              </MButton>
              <MButton size="sm" variant="quiet" onClick={r.onConnect} disabled={r.busy}>
                {authPending ? 'Redirecting…' : 'Reconnect'}
              </MButton>
            </span>
          )
        }
        return (
          <MButton size="sm" variant="primary" onClick={r.onConnect} disabled={r.busy}>
            {authPending ? 'Redirecting…' : 'Connect'}
          </MButton>
        )
      },
    },
  ]

  return (
    <div className="d-stack">
      <div className="d-card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <MPill tone="blue">Sync</MPill>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--m-ink-2)' }}>
          Connect external systems so Sitelayer can push estimates, invoices, and labor automatically. QBO is the live
          accounting connector; the others land as they ship.
        </div>
      </div>
      {error ? (
        <div className="d-card" style={{ color: 'var(--m-red, #c7331e)', fontSize: 13 }}>
          {error}
        </div>
      ) : null}
      <DataTable<IntegrationRow>
        title="Connections"
        columns={columns}
        rows={rows}
        rowKey={(r) => r.row.id}
        empty="No integrations available."
      />
      {/* GAP: there is no DELETE /api/integrations/qbo (disconnect) endpoint, so
          there is intentionally no Disconnect action here. The QBO row only
          exposes connect / reconnect (OAuth) + run-sync. To revoke, an admin
          reconnects against a different realm. Suggested: DELETE
          /api/integrations/qbo → soft-delete the integration_connection row. */}
    </div>
  )
}

// ---- NOTIFICATIONS -------------------------------------------------------
// Wired to GET/PUT /api/notification-preferences. The design is a per-event ×
// PUSH/SMS/EMAIL checkbox matrix with a locked "Stop work" row. The backend
// models four fixed events, each with ONE delivery channel (push | sms | email |
// off) — NOT independent per-channel toggles. We render the design's three-column
// PUSH/SMS/EMAIL matrix, but each row behaves as a single-select (the active box is
// the event's one backend channel; clicking the active box turns it off). The
// SMS / email contact fields the PUT requires when a channel is set to sms / email
// stay below, and the Stop-work row is a locked "always on" display row (there is
// no backend pref for it — it's hard-routed server-side).
type NotifPrefKey =
  | 'channel_assignment_change'
  | 'channel_time_review_ready'
  | 'channel_daily_log_reminder'
  | 'channel_clock_anomaly'

const NOTIF_EVENTS: Array<{ key: NotifPrefKey; label: string; hint: string }> = [
  {
    key: 'channel_assignment_change',
    label: 'Project assignment change',
    hint: 'When you’re added to / removed from a crew.',
  },
  {
    key: 'channel_time_review_ready',
    label: 'Time review ready',
    hint: 'When a week of crew time is ready to approve.',
  },
  { key: 'channel_daily_log_reminder', label: 'Daily-log reminder', hint: 'End-of-day nudge to file the daily log.' },
  { key: 'channel_clock_anomaly', label: 'Clock anomaly', hint: 'Missed clock-out, overlap, or off-site punch.' },
]

// The three matrix columns. (The backend's fourth "off" state is represented by
// no box checked in a row.)
const MATRIX_CHANNELS: Array<{ value: Exclude<NotificationChannel, 'off'>; label: string }> = [
  { value: 'push', label: 'Push' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
]

// Yellow-fill square checkbox cell matching the brutalist matrix in the design.
function NotifCheckbox({
  checked,
  locked,
  onToggle,
  label,
}: {
  checked: boolean
  locked?: boolean | undefined
  onToggle?: (() => void) | undefined
  label: string
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={locked}
      onClick={onToggle}
      style={{
        width: 22,
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '2px solid var(--m-ink)',
        borderRadius: 0,
        cursor: locked ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--m-accent)' : 'transparent',
        color: 'var(--m-ink)',
        fontSize: 13,
        fontWeight: 800,
        lineHeight: 1,
        padding: 0,
        opacity: locked ? 0.85 : 1,
      }}
    >
      {checked ? '✓' : ''}
    </button>
  )
}

type NotifDraft = {
  channel_assignment_change: NotificationChannel
  channel_time_review_ready: NotificationChannel
  channel_daily_log_reminder: NotificationChannel
  channel_clock_anomaly: NotificationChannel
  sms_phone: string
  email: string
}

export function NotificationsSection() {
  const prefsQuery = useNotificationPreferences()
  const update = useUpdateNotificationPreferences()
  const [draft, setDraft] = useState<NotifDraft | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Hydrate the local draft from the server row when the query resolves /
  // re-fetches. The row carries the canonical defaults when none exists yet.
  const server = prefsQuery.data?.preferences
  useEffect(() => {
    if (!server) return
    setDraft({
      channel_assignment_change: server.channel_assignment_change,
      channel_time_review_ready: server.channel_time_review_ready,
      channel_daily_log_reminder: server.channel_daily_log_reminder,
      channel_clock_anomaly: server.channel_clock_anomaly,
      sms_phone: server.sms_phone ?? '',
      email: server.email ?? '',
    })
  }, [server])

  // Matrix cell toggle: the backend stores ONE channel per event, so the three
  // PUSH/SMS/EMAIL boxes behave as a single-select — checking a box sets that
  // channel; clicking the already-active box turns the event off.
  const toggleChannel = (key: NotifPrefKey, value: Exclude<NotificationChannel, 'off'>) => {
    setSaved(false)
    setDraft((prev) => (prev ? { ...prev, [key]: prev[key] === value ? 'off' : value } : prev))
  }

  const usesSms = draft ? NOTIF_EVENTS.some((e) => draft[e.key] === 'sms') : false
  const usesEmail = draft ? NOTIF_EVENTS.some((e) => draft[e.key] === 'email') : false

  // Mirror the API's contact-required guard so we don't fire a doomed PUT.
  const contactError = useMemo(() => {
    if (!draft) return null
    if (usesSms && !draft.sms_phone.trim()) return 'Add a mobile number to receive SMS notifications.'
    if (usesEmail && !draft.email.trim()) return 'Add an email address to receive email notifications.'
    return null
  }, [draft, usesSms, usesEmail])

  const dirty = useMemo(() => {
    if (!draft || !server) return false
    return (
      draft.channel_assignment_change !== server.channel_assignment_change ||
      draft.channel_time_review_ready !== server.channel_time_review_ready ||
      draft.channel_daily_log_reminder !== server.channel_daily_log_reminder ||
      draft.channel_clock_anomaly !== server.channel_clock_anomaly ||
      draft.sms_phone !== (server.sms_phone ?? '') ||
      draft.email !== (server.email ?? '')
    )
  }, [draft, server])

  const save = async () => {
    if (!draft || contactError) return
    setSaveError(null)
    setSaved(false)
    try {
      await update.mutateAsync({
        channel_assignment_change: draft.channel_assignment_change,
        channel_time_review_ready: draft.channel_time_review_ready,
        channel_daily_log_reminder: draft.channel_daily_log_reminder,
        channel_clock_anomaly: draft.channel_clock_anomaly,
        sms_phone: draft.sms_phone.trim() ? draft.sms_phone.trim() : null,
        email: draft.email.trim() ? draft.email.trim() : null,
      })
      setSaved(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  if (prefsQuery.isPending) {
    return (
      <div className="d-card" style={{ color: 'var(--m-ink-3)', fontSize: 14 }}>
        Loading notification preferences…
      </div>
    )
  }
  if (prefsQuery.isError) {
    return (
      <div className="d-card" style={{ color: 'var(--m-red, #c7331e)', fontSize: 14 }}>
        Could not load notification preferences.
      </div>
    )
  }

  return (
    <div className="d-stack">
      <div className="d-card" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <MPill tone="blue">Delivery</MPill>
        <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--m-ink-2)' }}>
          Pick how each event reaches you — push, SMS, or email. SMS and email need a contact below. (Each event delivers
          on one channel today; tap the lit box to turn it off.)
        </div>
      </div>

      {/* PER-EVENT × PUSH/SMS/EMAIL checkbox matrix matching the design. */}
      <div className="d-card" style={{ padding: 0, overflow: 'hidden' }}>
        {/* Column header row. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) repeat(3, 72px)',
            gap: 12,
            alignItems: 'center',
            padding: '12px 18px',
            borderBottom: '2px solid var(--m-ink)',
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--m-ink-3)',
          }}
        >
          <span>Event</span>
          {MATRIX_CHANNELS.map((c) => (
            <span key={c.value} style={{ textAlign: 'center' }}>
              {c.label}
            </span>
          ))}
        </div>

        {NOTIF_EVENTS.map((ev) => (
          <div
            key={ev.key}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) repeat(3, 72px)',
              gap: 12,
              alignItems: 'center',
              padding: '14px 18px',
              borderBottom: '1px solid var(--m-line, rgba(0,0,0,0.08))',
            }}
          >
            <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
              <span className="d-table-cell-strong">{ev.label}</span>
              <span style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{ev.hint}</span>
            </span>
            {MATRIX_CHANNELS.map((c) => (
              <span key={c.value} style={{ textAlign: 'center' }}>
                <NotifCheckbox
                  checked={(draft ? draft[ev.key] : 'off') === c.value}
                  onToggle={draft ? () => toggleChannel(ev.key, c.value) : undefined}
                  locked={!draft}
                  label={`${ev.label} — ${c.label}`}
                />
              </span>
            ))}
          </div>
        ))}

        {/* Stop-work — locked, always on every channel. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0,1fr) repeat(3, 72px)',
            gap: 12,
            alignItems: 'center',
            padding: '14px 18px',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span className="d-table-cell-strong">Stop work</span>
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--m-paper, #fff)',
                background: 'var(--m-red, #c7331e)',
                padding: '3px 8px',
              }}
            >
              Locked · all on
            </span>
          </span>
          {MATRIX_CHANNELS.map((c) => (
            <span key={c.value} style={{ textAlign: 'center' }}>
              <NotifCheckbox checked locked label={`Stop work — ${c.label} (locked on)`} />
            </span>
          ))}
        </div>
      </div>

      <SettingsCard eyebrow="Contact details">
        <FieldGrid>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
              }}
            >
              Mobile (for SMS)
            </span>
            <MInput
              type="tel"
              value={draft?.sms_phone ?? ''}
              disabled={!draft}
              placeholder="(310) 555-0188"
              onChange={(e) => {
                setSaved(false)
                setDraft((prev) => (prev ? { ...prev, sms_phone: e.target.value } : prev))
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
              }}
            >
              Email (for email)
            </span>
            <MInput
              type="email"
              value={draft?.email ?? ''}
              disabled={!draft}
              placeholder="you@company.com"
              onChange={(e) => {
                setSaved(false)
                setDraft((prev) => (prev ? { ...prev, email: e.target.value } : prev))
              }}
            />
          </label>
        </FieldGrid>
        {contactError ? (
          <div style={{ fontSize: 12, color: 'var(--m-red, #c7331e)', marginTop: 10 }}>{contactError}</div>
        ) : null}
        {saveError ? (
          <div style={{ fontSize: 12, color: 'var(--m-red, #c7331e)', marginTop: 10 }}>{saveError}</div>
        ) : null}
        {saved && !dirty ? (
          <div style={{ fontSize: 12, color: 'var(--m-good, #2c7a3f)', marginTop: 10 }}>Saved.</div>
        ) : null}
        <div style={{ marginTop: 14 }}>
          <MButton
            size="sm"
            variant="primary"
            onClick={save}
            disabled={!draft || !dirty || Boolean(contactError) || update.isPending}
          >
            {update.isPending ? 'Saving…' : 'Save preferences'}
          </MButton>
        </div>
      </SettingsCard>
    </div>
  )
}

// ---- PROFILE -------------------------------------------------------------
// Account identity is owned by Clerk + company_memberships and is read-only
// here (per spec, /api/session-backed read is fine; we surface the live
// company name from bootstrap and leave the rest presentational). The
// editable surfaces (display name, phone, 2FA, avatar) are Clerk flows, not
// Sitelayer endpoints.
export function ProfileSection() {
  const company = useActiveCompany()
  // Account identity is owned by Clerk; surfaced read-only here as a placeholder.
  const displayName = 'Steve Lozano'
  return (
    <div className="d-stack">
      <SettingsCard eyebrow="Your account">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 18 }}>
          <MAvatar initials="SL" size="lg" />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--m-ink)' }}>{displayName}</div>
            <div style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>{company ? `Admin · ${company.name}` : 'Admin'}</div>
          </div>
        </div>
        <FieldGrid>
          <Field label="Display name" value={displayName} readOnly hint="Managed in your Clerk profile." />
          <Field label="Email" type="email" value="stephenlozanorivacoba@gmail.com" hint="Used to sign in." readOnly />
          <Field label="Mobile phone" type="tel" placeholder="(310) 555-0188" readOnly />
          <Field label="Company role" value="Admin" readOnly hint="Managed under Roles + Permissions." />
        </FieldGrid>
        <div style={{ fontSize: 12, color: 'var(--m-ink-3)', marginTop: 12 }}>
          Account name, email, photo, and two-factor authentication are managed in your Clerk-hosted profile.
          {/* Profile identity is Clerk-owned (read-only). No Sitelayer PATCH for these. */}
        </div>
      </SettingsCard>
    </div>
  )
}

// ---- HELP ----------------------------------------------------------------
// Three contact tiles (Chat Support — yellow primary / Book a Call / Email Us)
// over a quick-guides list, matching dsg__30. Pure presentational links today.
type Guide = { id: string; title: string }
const GUIDES: Guide[] = [
  { id: 'setup', title: 'Setup guide' },
  { id: 'takeoff-basics', title: 'Takeoff basics' },
  { id: 'connect-qbo', title: 'Connecting QBO' },
  { id: 'margin-red', title: 'Why my margin is red' },
  { id: 'loaded-labor', title: 'Loaded labor explained' },
]

type Contact = { id: string; title: string; sub: string; href: string; primary?: boolean }
const CONTACTS: Contact[] = [
  { id: 'chat', title: 'Chat Support', sub: 'Avg 4 min · 6am–6pm MT', href: '#', primary: true },
  { id: 'call', title: 'Book a Call', sub: '30-min walkthrough', href: '#' },
  { id: 'email', title: 'Email Us', sub: 'help@sitelayer.co', href: 'mailto:help@sitelayer.co' },
]

export function HelpSection() {
  return (
    <div className="d-stack">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 16,
        }}
      >
        {CONTACTS.map((c) => (
          <a
            key={c.id}
            href={c.href}
            className="d-card"
            style={{
              textDecoration: 'none',
              color: 'inherit',
              display: 'block',
              padding: 22,
              // Chat Support is the yellow primary tile in the design.
              background: c.primary ? 'var(--m-accent)' : undefined,
              border: c.primary ? '2px solid var(--m-ink)' : undefined,
            }}
          >
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--m-ink)' }}>
              {c.title}
            </div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 12,
                fontWeight: 600,
                color: c.primary ? 'var(--m-ink)' : 'var(--m-ink-3)',
                marginTop: 8,
              }}
            >
              {c.sub}
            </div>
          </a>
        ))}
      </div>

      {/* Quick guides — a bordered list of forward-chevron rows. */}
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
          Quick guides
        </div>
        {GUIDES.map((g, i) => (
          <a
            key={g.id}
            href="#"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '16px 18px',
              textDecoration: 'none',
              color: 'inherit',
              borderBottom: i < GUIDES.length - 1 ? '1px solid var(--m-line, rgba(0,0,0,0.08))' : 'none',
            }}
          >
            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--m-ink)' }}>{g.title}</span>
            <span style={{ fontSize: 16, color: 'var(--m-ink-3)' }}>→</span>
          </a>
        ))}
      </div>
    </div>
  )
}
