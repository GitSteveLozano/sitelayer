/**
 * Project-create flow. Lives at /projects/new and routes BEFORE
 * /projects/:projectId so the param matcher doesn't capture the literal
 * string "new" as a project id.
 *
 * Responsive (Phase B) consolidation of the desktop↔mobile new-project twins
 * (was screens/desktop/owner-new-project.tsx + this file). Both share the
 * `apiPost('/api/projects', …)` create path and the CustomerDedupPicker
 * linkage — but they GENUINELY DIVERGE in flow and so each full render is
 * preserved verbatim behind useIsDesktop(), never collapsed:
 *   - mobile: blueprint/clone/blank route chooser → details with a BID/PROJECT/
 *     LEAD starting-state segment (BID auto-dispatches START_ESTIMATING), a
 *     notes field, and post-create navigation to /projects/:id/takeoff (or
 *     /projects/:id). companySlug comes from the mobile-shell prop.
 *   - desktop: takeoff/clone/blank chooser with a "recent → convert" list and
 *     prefill, a site-address field, always status:'lead', and post-create
 *     navigation to /desktop/canvas/:id. companySlug from getActiveCompanySlug().
 *
 * Required fields per the server (`apps/api/src/routes/projects.ts`): name +
 * customer_name. Everything else has a server default.
 */
import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  apiPost,
  dispatchProjectLifecycleEvent,
  getActiveCompanySlug,
  type BootstrapResponse,
  type ProjectRow,
} from '@/lib/api'
import { DEyebrow, DH1 } from '../../components/d/index.js'
import {
  MBody,
  MButton,
  MButtonStack,
  MI,
  MInput,
  MLargeHead,
  MPill,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
  Spark,
} from '../../components/m/index.js'
import { useIsDesktop } from '../../lib/use-is-desktop.js'
import { CustomerDedupPicker, type CustomerMatch } from './customer-dedup-picker.js'

const DIVISIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const

// Project classification (design M03 STARTING STATE segmented control —
// BID / PROJECT / LEAD, BID selected by default per msg 12). This is a
// CLASSIFICATION carried on the legacy `status` field for analytics — all
// three start the lifecycle reducer at `draft`. The only lifecycle effect
// is that picking "BID" auto-dispatches START_ESTIMATING (the estimator is
// actively working a bid), landing the project in `estimating` (version 2).
// `lead`/`project` stay at `draft`.
const KINDS = [
  { value: 'bid', label: 'BID' },
  { value: 'project', label: 'PROJECT' },
  { value: 'lead', label: 'LEAD' },
] as const
type ProjectKind = (typeof KINDS)[number]['value']

// Step 1/2 — "Start a job." route chooser (design msg 08/11). FROM A
// BLUEPRINT is the AI takeoff path: after create we deep-link into the
// project's takeoff/upload flow. CLONE + BLANK both land on the regular
// details form and the project detail screen.
type StartRoute = 'blueprint' | 'clone' | 'blank'
const ROUTES: ReadonlyArray<{
  value: StartRoute
  Icon: (typeof MI)[keyof typeof MI]
  title: string
  body: string
  ai?: boolean
}> = [
  {
    value: 'blueprint',
    Icon: MI.Layers,
    title: 'FROM A BLUEPRINT',
    body: 'Upload a plan, take off in canvas',
    ai: true,
  },
  { value: 'clone', Icon: MI.FileText, title: 'CLONE FROM PAST PROJECT', body: 'Same crew, similar scope' },
  { value: 'blank', Icon: MI.Plus, title: 'BLANK PROJECT', body: 'Write the scope from scratch' },
]

/**
 * Responsive new-project screen. Mounts the desktop kickoff (chooser + convert
 * list + details card) at >=1024px and the mobile two-step form below it.
 * Accepts BOTH the mobile-shell `companySlug` prop and the desktop-workspace
 * `bootstrap` prop; only one render mounts at a time, so the unused prop is
 * simply ignored on the other surface. The twins diverge in flow, so each is
 * preserved whole rather than merged.
 */
export function MobileProjectNew({
  companySlug,
  bootstrap = null,
}: {
  companySlug?: string
  bootstrap?: BootstrapResponse | null
}) {
  const isDesktop = useIsDesktop()
  return isDesktop ? (
    <OwnerNewProjectDesktop bootstrap={bootstrap} />
  ) : (
    <MobileProjectNewMobile companySlug={companySlug ?? getActiveCompanySlug() ?? ''} />
  )
}

/** Desktop-route alias — kept so screens/desktop/desktop-workspace.tsx can
 *  keep importing `OwnerNewProject` after the desktop twin file was deleted. */
export const OwnerNewProject = MobileProjectNew

function MobileProjectNewMobile({ companySlug }: { companySlug: string }) {
  const navigate = useNavigate()
  // Two-step flow: step 1 = route chooser, step 2 = details. `route` also
  // drives the step-2 CTA label + post-create navigation target.
  const [step, setStep] = useState<1 | 2>(1)
  const [route, setRoute] = useState<StartRoute>('blueprint')
  const [name, setName] = useState('')
  const [customerName, setCustomerName] = useState('')
  // Dedup linkage: when the estimator adopts an existing customer (via the
  // QuickBooks-style dedup picker) we link the project to that record's id
  // instead of minting a duplicate. `linkedCustomer` also drives the
  // "Linked to …" confirmation chip + suppresses the match prompt.
  const [linkedCustomer, setLinkedCustomer] = useState<CustomerMatch | null>(null)
  // The user explicitly chose "create new" for the current typed name —
  // remember it so the prompt doesn't immediately re-appear for that name.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [kind, setKind] = useState<ProjectKind>('bid')
  const [divisionCode, setDivisionCode] = useState<(typeof DIVISIONS)[number]>('D4')
  const [bidTotal, setBidTotal] = useState('')
  const [laborRate, setLaborRate] = useState('')
  const [targetSqftPerHr, setTargetSqftPerHr] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track whether the user has tried to submit — only surface inline
  // validation after that so an untouched form doesn't shout at them.
  const [touched, setTouched] = useState(false)

  const nameId = useId()
  const customerId = useId()
  const nameError = touched && name.trim().length === 0 ? 'Project name is required.' : null
  const customerError = touched && customerName.trim().length === 0 ? 'Customer name is required.' : null

  const canSubmit = name.trim().length > 0 && customerName.trim().length > 0 && !busy

  const handleSubmit = async () => {
    setTouched(true)
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const created = await apiPost<{ id: string }>(
        '/api/projects',
        {
          name: name.trim(),
          customer_name: customerName.trim(),
          // When the estimator linked to an existing customer through the
          // dedup picker, carry that customer's id so the server attaches the
          // project to the real record instead of creating a duplicate.
          ...(linkedCustomer ? { customer_id: linkedCustomer.customer.id } : {}),
          division_code: divisionCode,
          bid_total: bidTotal ? Number(bidTotal) : 0,
          labor_rate: laborRate ? Number(laborRate) : 0,
          target_sqft_per_hr: targetSqftPerHr ? Number(targetSqftPerHr) : null,
          // Classification carried on the legacy `status` field. The server
          // co-sets lifecycle_state='draft' regardless (see projects.ts).
          status: kind,
        },
        companySlug,
      )
      // Notes column lands as a follow-up; for now we surface it through
      // the daily-log path the foreman writes against. Server doesn't
      // accept it on create.
      void notes
      // A "BID" is a project the estimator is actively working — advance
      // the lifecycle to `estimating` immediately via the canonical POST
      // events route (the project was just created at draft/version 1).
      // Soft-fail: the project already exists, so a dispatch error must not
      // block navigation — surface it without aborting the create flow.
      if (kind === 'bid') {
        try {
          await dispatchProjectLifecycleEvent(created.id, { type: 'START_ESTIMATING' }, 1)
        } catch (dispatchErr) {
          // Project is created; estimating is a best-effort follow-on. Log
          // for visibility but proceed to the detail screen.
          console.warn('project-new: START_ESTIMATING dispatch failed (project still created)', dispatchErr)
        }
      }
      // FROM A BLUEPRINT route flows straight into the takeoff/upload
      // surface (design CTA "CREATE · UPLOAD BLUEPRINT →"); clone/blank land
      // on the project detail screen.
      navigate(route === 'blueprint' ? `/projects/${created.id}/takeoff` : `/projects/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Adopt an existing customer from the dedup picker: snap the name to the
  // canonical (QBO label when present, else roster name) and record the link.
  const handleLinkCustomer = (match: CustomerMatch) => {
    setLinkedCustomer(match)
    setCustomerName(match.qboLabel ?? match.customer.name)
    setDismissedFor(null)
  }

  // User edited the customer field — drop any existing link (the typed name
  // no longer necessarily refers to the linked record) and re-arm matching.
  const handleCustomerChange = (value: string) => {
    setCustomerName(value)
    if (linkedCustomer) setLinkedCustomer(null)
    if (dismissedFor !== null) setDismissedFor(null)
  }

  // Step 1/2 — route chooser (design msg 08/11). Selecting a tile advances
  // to the details step; the chosen route is remembered so step 2 can label
  // the CTA + pick the post-create destination.
  if (step === 1) {
    return (
      <>
        <MTopBar back title="New project" onBack={() => navigate('/projects')} />
        <MBody>
          <MLargeHead eyebrow="STEP 1 / 2" title="Start a job." />
          <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {ROUTES.map((r) => {
              const active = route === r.value
              const Icon = r.Icon
              return (
                <button
                  key={r.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setRoute(r.value)
                    setStep(2)
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    textAlign: 'left',
                    padding: '18px 16px',
                    cursor: 'pointer',
                    border: active ? '2px solid var(--m-ink)' : '2px solid var(--m-line)',
                    background: r.value === 'blueprint' ? 'var(--m-accent)' : 'transparent',
                    color: r.value === 'blueprint' ? 'var(--m-accent-ink, var(--m-ink))' : 'var(--m-ink)',
                  }}
                >
                  <Icon size={22} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontFamily: 'var(--m-font-display)',
                        fontSize: 17,
                        fontWeight: 800,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {r.title}
                      {r.ai ? (
                        <span
                          className="num"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: '0.08em',
                            background: 'var(--m-ink)',
                            color: 'var(--m-accent)',
                            padding: '2px 6px',
                          }}
                        >
                          <Spark state="accent" size={10} />
                          AI
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="num"
                      style={{ display: 'block', marginTop: 6, fontSize: 12, letterSpacing: '0.04em', opacity: 0.75 }}
                    >
                      {r.body}
                    </span>
                  </span>
                  <span style={{ fontSize: 20, opacity: 0.6 }}>→</span>
                </button>
              )
            })}
          </div>
        </MBody>
      </>
    )
  }

  return (
    <>
      <MTopBar back title="New project" onBack={() => setStep(1)} />
      <MBody>
        <MLargeHead eyebrow="STEP 2 / 2 · DETAILS" title="Project details." />
        <MSectionH>Identification</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Project name *" htmlFor={nameId} error={nameError}>
            <MInput
              id={nameId}
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="215 Cinnamon Teal"
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? `${nameId}-err` : undefined}
              aria-required="true"
            />
          </Field>
          <Field label="Customer *" htmlFor={customerId} error={customerError}>
            <MInput
              id={customerId}
              value={customerName}
              onChange={(e) => handleCustomerChange(e.currentTarget.value)}
              placeholder="Foxridge Homes"
              aria-invalid={customerError ? true : undefined}
              aria-describedby={customerError ? `${customerId}-err` : undefined}
              aria-required="true"
            />
            {linkedCustomer ? (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <MPill tone="green" dot>
                  Linked to existing customer
                </MPill>
                <button
                  type="button"
                  onClick={() => setLinkedCustomer(null)}
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
        </div>
        {dismissedFor !== customerName.trim() ? (
          <CustomerDedupPicker
            typedName={customerName}
            linkedCustomerId={linkedCustomer?.customer.id ?? null}
            onLink={handleLinkCustomer}
            onCreateNew={() => setDismissedFor(customerName.trim())}
          />
        ) : null}
        <MSectionH>Starting state</MSectionH>
        <div style={{ padding: '0 16px' }}>
          <div role="group" aria-label="Starting state" style={{ display: 'flex', gap: 8 }}>
            {KINDS.map((k) => {
              const active = kind === k.value
              return (
                <button
                  key={k.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setKind(k.value)}
                  style={{
                    flex: 1,
                    padding: '10px 8px',
                    fontFamily: 'var(--m-num)',
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    borderRadius: 8,
                    cursor: 'pointer',
                    border: active ? '1px solid var(--m-accent)' : '1px solid var(--m-line)',
                    background: active ? 'var(--m-accent)' : 'transparent',
                    color: active ? 'var(--m-on-accent, #fff)' : 'var(--m-ink-2)',
                  }}
                >
                  {k.label}
                </button>
              )
            })}
          </div>
          <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12, color: 'var(--m-ink-3)', lineHeight: 1.45 }}>
            {kind === 'bid'
              ? 'Active bid — starts estimating right away.'
              : kind === 'project'
                ? 'A committed project. Starts as a draft.'
                : 'An early lead. Starts as a draft.'}
          </p>
        </div>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Division">
            <MSelect
              value={divisionCode}
              onChange={(e) => setDivisionCode(e.currentTarget.value as (typeof DIVISIONS)[number])}
            >
              {DIVISIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </MSelect>
          </Field>
        </div>
        <MSectionH>Numbers</MSectionH>
        <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Bid total ($)">
            <MInput
              type="number"
              inputMode="decimal"
              value={bidTotal}
              onChange={(e) => setBidTotal(e.currentTarget.value)}
              placeholder="19268"
            />
          </Field>
          <Field label="Labor rate ($/hr)">
            <MInput
              type="number"
              inputMode="decimal"
              value={laborRate}
              onChange={(e) => setLaborRate(e.currentTarget.value)}
              placeholder="38"
            />
          </Field>
          <Field label="Target sf/hr">
            <MInput
              type="number"
              inputMode="decimal"
              value={targetSqftPerHr}
              onChange={(e) => setTargetSqftPerHr(e.currentTarget.value)}
              placeholder="4.73"
            />
          </Field>
        </div>
        <MSectionH>Notes</MSectionH>
        <div style={{ padding: '0 16px' }}>
          <MTextarea
            value={notes}
            onChange={(e) => setNotes(e.currentTarget.value)}
            placeholder="Anything the foreman should know on day one."
            style={{ width: '100%', minHeight: 96 }}
          />
        </div>
        {error ? <div style={{ padding: '12px 16px 0', color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}
        <div style={{ padding: 16 }}>
          <MButtonStack>
            <MButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
              {busy ? 'Creating…' : route === 'blueprint' ? 'Create · upload blueprint →' : 'Create project'}
            </MButton>
            <MButton variant="ghost" onClick={() => setStep(1)}>
              Back
            </MButton>
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

// ===========================================================================
// DESKTOP — the "Start a job." kickoff (Desktop v2 · Owner · New project).
// STEP 1: From a blueprint / Clone past project / Blank project + a "recent →
// convert" list. STEP 2: the create form (reuses the EXACT create logic +
// CustomerDedupPicker linkage). Always status:'lead'; on success →
// /desktop/canvas/:id. Preserved verbatim from the deleted desktop twin.
// ===========================================================================
type StartKind = 'takeoff' | 'clone' | 'blank'

const START_OPTIONS: Array<{ kind: StartKind; label: string; sub: string; tag: string | null }> = [
  {
    kind: 'takeoff',
    label: 'From a blueprint',
    sub: 'Upload a PDF plan — take off quantities in the canvas, then price',
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

function fmtSize(v: string | number | null | undefined): string {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n === 0) return '—'
  return `${Math.round(n).toLocaleString('en-US')} SF`
}

function OwnerNewProjectDesktop({ bootstrap = null }: { bootstrap?: BootstrapResponse | null }) {
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
                <div className="d-table-head-title">Recent takeoffs · ready to convert</div>
              </div>
              <table className="d-table">
                <thead>
                  <tr>
                    <th>Takeoff</th>
                    <th>Client</th>
                    <th data-num="true">Size</th>
                    <th data-num="true">Sell value</th>
                    <th data-num="true"></th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((p) => (
                    <tr key={p.id} data-tap="true" onClick={() => convertFrom(p)}>
                      <td className="d-table-cell-strong">{p.name}</td>
                      <td>{p.customer_name || '—'}</td>
                      <td data-num="true">{fmtSize(p.target_sqft_per_hr)}</td>
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
  const stepTitle = kind === 'takeoff' ? 'From a blueprint' : kind === 'clone' ? 'Clone past project' : 'Blank project'

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
