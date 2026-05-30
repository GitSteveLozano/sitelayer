/**
 * Owner desktop new-project kickoff (Desktop v2 · Owner · New project — the
 * design's "Start a job." DOwnerNewProject).
 *
 * STEP 1 (how to start): three entry paths — From a Takeoff / Clone Past
 * Project / Blank Project — plus a "Recent projects · ready to convert" list.
 * Picking a path runs the workflow Steve asked for: it auto-fills what it can
 * for the project details from the chosen content (an existing project /
 * takeoff), the owner confirms, and on create we drop straight into the
 * takeoff/canvas editor.
 *
 * STEP 2 (details): the create form. Reuses the EXACT create logic from the
 * mobile project-create flow (`apiPost('/api/projects', ...)` + the
 * CustomerDedupPicker linkage + name/client/division/bid/labor-rate/target sf-hr).
 * No new endpoints. On success → `/desktop/canvas/:id` (the takeoff surface).
 */
import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, getActiveCompanySlug, type BootstrapResponse, type ProjectRow } from '@/lib/api'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MInput, MPill, MSelect, MTextarea } from '@/components/m'
import { CustomerDedupPicker, type CustomerMatch } from '../mobile/customer-dedup-picker.js'

const DIVISIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const
type StartKind = 'takeoff' | 'clone' | 'blank'

const START_OPTIONS: Array<{ kind: StartKind; label: string; sub: string; tag: string | null }> = [
  {
    kind: 'takeoff',
    label: 'From a takeoff',
    sub: 'Pull quantities + price straight from an estimator deliverable',
    tag: 'AI',
  },
  { kind: 'clone', label: 'Clone past project', sub: 'Same client or scope — copy the structure', tag: null },
  { kind: 'blank', label: 'Blank project', sub: 'Start from scratch, add scope as you go', tag: null },
]

function fmtValue(v: string | number | null | undefined): string {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n === 0) return '—'
  return `$${Math.round(n).toLocaleString('en-US')}`
}

export function OwnerNewProject({ bootstrap = null }: { bootstrap?: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const companySlug = getActiveCompanySlug()

  // STEP 1 = the "how to start" chooser; STEP 2 = the (auto-filled) details form.
  const [step, setStep] = useState<'choose' | 'details'>('choose')
  const [kind, setKind] = useState<StartKind>('blank')
  const [sourceProjectId, setSourceProjectId] = useState<string>('')

  const [name, setName] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [linkedCustomer, setLinkedCustomer] = useState<CustomerMatch | null>(null)
  // When cloning/converting we carry the source project's customer id so the
  // new project attaches to the same customer record rather than duplicating it.
  const [sourceCustomerId, setSourceCustomerId] = useState<string | null>(null)
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [divisionCode, setDivisionCode] = useState<(typeof DIVISIONS)[number]>('D4')
  const [bidTotal, setBidTotal] = useState('')
  const [laborRate, setLaborRate] = useState('')
  const [targetSqftPerHr, setTargetSqftPerHr] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const projects = bootstrap?.projects ?? []
  const recent = [...projects].sort((a, b) => (b.created_at < a.created_at ? -1 : 1)).slice(0, 6)

  const nameId = useId()
  const customerId = useId()
  const nameError = touched && name.trim().length === 0 ? 'Project name is required.' : null
  const customerError = touched && customerName.trim().length === 0 ? 'Client name is required.' : null
  const canSubmit = name.trim().length > 0 && customerName.trim().length > 0 && !busy

  const resetForm = () => {
    setName('')
    setCustomerName('')
    setLinkedCustomer(null)
    setSourceCustomerId(null)
    setDismissedFor(null)
    setAddress('')
    setDivisionCode('D4')
    setBidTotal('')
    setLaborRate('')
    setTargetSqftPerHr('')
    setTouched(false)
    setError(null)
    setSourceProjectId('')
  }

  // The auto-fill: copy what we can from an existing project into the form.
  const prefillFrom = (p: ProjectRow, copyLabel: boolean) => {
    setName(copyLabel ? `${p.name} (copy)` : p.name)
    setCustomerName(p.customer_name)
    setSourceCustomerId(p.customer_id ?? null)
    setLinkedCustomer(null)
    // Don't nag the dedup picker about the carried-over customer name.
    setDismissedFor(p.customer_name.trim())
    setDivisionCode(
      (DIVISIONS as readonly string[]).includes(p.division_code)
        ? (p.division_code as (typeof DIVISIONS)[number])
        : 'D4',
    )
    setBidTotal(Number(p.bid_total) ? String(Number(p.bid_total)) : '')
    setLaborRate(Number(p.labor_rate) ? String(Number(p.labor_rate)) : '')
    setTargetSqftPerHr(p.target_sqft_per_hr && Number(p.target_sqft_per_hr) ? String(Number(p.target_sqft_per_hr)) : '')
  }

  const chooseStart = (k: StartKind) => {
    resetForm()
    setKind(k)
    setStep('details')
  }

  // "Convert" a recent project/takeoff → pre-fill from it and jump to details.
  const convertFrom = (p: ProjectRow) => {
    resetForm()
    setKind('takeoff')
    setSourceProjectId(p.id)
    prefillFrom(p, false)
    setStep('details')
  }

  const onSourceChange = (id: string) => {
    setSourceProjectId(id)
    const p = projects.find((x) => x.id === id)
    if (p) prefillFrom(p, kind === 'clone')
  }

  const handleSubmit = async () => {
    setTouched(true)
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const customerLink = linkedCustomer?.customer.id ?? sourceCustomerId ?? null
      const created = await apiPost<{ id: string }>(
        '/api/projects',
        {
          name: name.trim(),
          customer_name: customerName.trim(),
          ...(customerLink ? { customer_id: customerLink } : {}),
          division_code: divisionCode,
          bid_total: bidTotal ? Number(bidTotal) : 0,
          labor_rate: laborRate ? Number(laborRate) : 0,
          target_sqft_per_hr: targetSqftPerHr ? Number(targetSqftPerHr) : null,
          status: 'lead',
        },
        companySlug,
      )
      void address
      // Steve's workflow: land in the takeoff/canvas editor, not the detail page.
      navigate(`/desktop/canvas/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleLinkCustomer = (match: CustomerMatch) => {
    setLinkedCustomer(match)
    setCustomerName(match.qboLabel ?? match.customer.name)
    setSourceCustomerId(null)
    setDismissedFor(null)
  }

  const handleCustomerChange = (value: string) => {
    setCustomerName(value)
    if (linkedCustomer) setLinkedCustomer(null)
    if (sourceCustomerId) setSourceCustomerId(null)
    if (dismissedFor !== null) setDismissedFor(null)
  }

  // ---- STEP 1 — how to start ------------------------------------------------
  if (step === 'choose') {
    return (
      <div className="d-content">
        <div className="d-stack">
          <div>
            <DEyebrow>Step 1 of 2 · How to start</DEyebrow>
            <DH1>Start a job.</DH1>
          </div>

          {/* Three entry paths (design: FROM A TAKEOFF · CLONE · BLANK). */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              border: '2px solid var(--m-ink)',
            }}
          >
            {START_OPTIONS.map((o, i) => (
              <button
                key={o.kind}
                type="button"
                onClick={() => chooseStart(o.kind)}
                style={{
                  padding: '28px 24px',
                  minHeight: 196,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: o.tag ? 'var(--m-accent)' : 'var(--m-sand)',
                  color: o.tag ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                  border: 'none',
                  borderRight: i < START_OPTIONS.length - 1 ? '2px solid var(--m-ink)' : 'none',
                }}
              >
                {o.tag ? (
                  <span
                    style={{
                      fontFamily: 'var(--m-num)',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      background: 'var(--m-ink)',
                      color: 'var(--m-accent)',
                      padding: '3px 8px',
                      marginBottom: 14,
                    }}
                  >
                    {o.tag}
                  </span>
                ) : null}
                <div
                  style={{
                    fontFamily: 'var(--m-font-display)',
                    fontWeight: 800,
                    fontSize: 24,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.05,
                  }}
                >
                  {o.label}
                </div>
                <div style={{ fontSize: 14, marginTop: 12, lineHeight: 1.5, fontWeight: 500, opacity: 0.82 }}>
                  {o.sub}
                </div>
                <div style={{ marginTop: 'auto', fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 26 }}>
                  →
                </div>
              </button>
            ))}
          </div>

          {/* Recent projects/takeoffs ready to convert into a fresh job. */}
          {recent.length > 0 ? (
            <div className="d-table-wrap">
              <div className="d-table-head">
                <div className="d-table-head-title">Recent projects · ready to convert</div>
              </div>
              <table className="d-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Client</th>
                    <th>Division</th>
                    <th data-num="true">Value</th>
                    <th data-num="true"></th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p) => (
                    <tr key={p.id} data-tap="true" onClick={() => convertFrom(p)}>
                      <td className="d-table-cell-strong">{p.name}</td>
                      <td>{p.customer_name || '—'}</td>
                      <td>{p.division_code || '—'}</td>
                      <td data-num="true">{fmtValue(p.bid_total)}</td>
                      <td data-num="true">
                        <MButton
                          size="sm"
                          variant="primary"
                          onClick={(e) => {
                            e.stopPropagation()
                            convertFrom(p)
                          }}
                        >
                          Convert →
                        </MButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </div>
    )
  }

  // ---- STEP 2 — details (auto-filled per path) ------------------------------
  const stepTitle = kind === 'takeoff' ? 'From a takeoff' : kind === 'clone' ? 'Clone past project' : 'Blank project'

  return (
    <div className="d-content">
      <div className="d-stack" style={{ maxWidth: 640, margin: '0 auto', width: '100%' }}>
        <div>
          <button
            type="button"
            onClick={() => setStep('choose')}
            style={{
              background: 'none',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            ← How to start
          </button>
          <DEyebrow>Step 2 of 2 · {stepTitle}</DEyebrow>
          <DH1>Project details.</DH1>
        </div>

        <div className="d-card">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Clone / takeoff: pick the source to auto-fill from. */}
            {kind !== 'blank' && projects.length > 0 ? (
              <Field label={kind === 'clone' ? 'Clone from' : 'Start from takeoff'}>
                <MSelect
                  value={sourceProjectId}
                  onChange={(e) => onSourceChange(e.currentTarget.value)}
                  style={{ width: '100%' }}
                >
                  <option value="">Choose a {kind === 'clone' ? 'past project' : 'takeoff'}…</option>
                  {recent.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.customer_name || 'no client'}
                    </option>
                  ))}
                </MSelect>
              </Field>
            ) : null}

            <Field label="Project name *" htmlFor={nameId} error={nameError}>
              <MInput
                id={nameId}
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="215 Cinnamon Teal"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? `${nameId}-err` : undefined}
                aria-required="true"
                style={{ width: '100%' }}
              />
            </Field>

            <Field label="Client *" htmlFor={customerId} error={customerError}>
              <MInput
                id={customerId}
                value={customerName}
                onChange={(e) => handleCustomerChange(e.currentTarget.value)}
                placeholder="Foxridge Homes"
                aria-invalid={customerError ? true : undefined}
                aria-describedby={customerError ? `${customerId}-err` : undefined}
                aria-required="true"
                style={{ width: '100%' }}
              />
              {linkedCustomer || sourceCustomerId ? (
                <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <MPill tone="green" dot>
                    Linked to existing customer
                  </MPill>
                  <button
                    type="button"
                    onClick={() => {
                      setLinkedCustomer(null)
                      setSourceCustomerId(null)
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: 'var(--m-ink-3)',
                      fontSize: 12,
                      textDecoration: 'underline',
                      cursor: 'pointer',
                    }}
                  >
                    Unlink
                  </button>
                </div>
              ) : null}
            </Field>

            {!linkedCustomer && !sourceCustomerId && dismissedFor !== customerName.trim() ? (
              <CustomerDedupPicker
                typedName={customerName}
                linkedCustomerId={null}
                onLink={handleLinkCustomer}
                onCreateNew={() => setDismissedFor(customerName.trim())}
              />
            ) : null}

            <Field label="Site address">
              <MTextarea
                value={address}
                onChange={(e) => setAddress(e.currentTarget.value)}
                placeholder="Where the crew shows up on day one."
                style={{ width: '100%', minHeight: 72 }}
              />
            </Field>

            <Field label="Division">
              <MSelect
                value={divisionCode}
                onChange={(e) => setDivisionCode(e.currentTarget.value as (typeof DIVISIONS)[number])}
                style={{ width: '100%' }}
              >
                {DIVISIONS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </MSelect>
            </Field>

            <div
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 12 }}
            >
              <Field label="Bid value ($)">
                <MInput
                  type="number"
                  inputMode="decimal"
                  value={bidTotal}
                  onChange={(e) => setBidTotal(e.currentTarget.value)}
                  placeholder="19268"
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label="Labor rate ($/hr)">
                <MInput
                  type="number"
                  inputMode="decimal"
                  value={laborRate}
                  onChange={(e) => setLaborRate(e.currentTarget.value)}
                  placeholder="38"
                  style={{ width: '100%' }}
                />
              </Field>
              <Field label="Target sf/hr">
                <MInput
                  type="number"
                  inputMode="decimal"
                  value={targetSqftPerHr}
                  onChange={(e) => setTargetSqftPerHr(e.currentTarget.value)}
                  placeholder="4.73"
                  style={{ width: '100%' }}
                />
              </Field>
            </div>

            {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <MButton variant="ghost" onClick={() => setStep('choose')}>
                Back
              </MButton>
              <MButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
                {busy ? 'Creating…' : 'Create + open takeoff'}
              </MButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
  htmlFor,
  error,
}: {
  label: string
  children: React.ReactNode
  htmlFor?: string
  error?: string | null
}) {
  return (
    <label style={{ display: 'block' }} {...(htmlFor ? { htmlFor } : {})}>
      <span
        style={{
          display: 'block',
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--m-ink-3)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 6,
        }}
      >
        {label}
      </span>
      {children}
      {error ? (
        <p
          id={htmlFor ? `${htmlFor}-err` : undefined}
          style={{ marginTop: 6, marginBottom: 0, color: 'var(--m-red)', fontSize: 12 }}
        >
          {error}
        </p>
      ) : null}
    </label>
  )
}
