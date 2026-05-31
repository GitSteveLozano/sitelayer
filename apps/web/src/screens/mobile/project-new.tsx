/**
 * Mobile project-create form. Lives at /projects/new and routes BEFORE
 * /projects/:projectId so the param matcher doesn't capture the literal
 * string "new" as a project id.
 *
 * The handoff specs `prj-create-sheet` as a bottom sheet on desktop;
 * on mobile-first that's a full-page form. Required fields per the
 * server (`apps/api/src/routes/projects.ts`): name + customer_name.
 * Everything else has a server default.
 */
import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, dispatchProjectLifecycleEvent } from '@/lib/api'
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

export function MobileProjectNew({ companySlug }: { companySlug: string }) {
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
              {busy
                ? 'Creating…'
                : route === 'blueprint'
                  ? 'Create · upload blueprint →'
                  : 'Create project'}
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
