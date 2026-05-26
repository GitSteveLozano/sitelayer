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
import { apiPost } from '@/lib/api'
import {
  MBody,
  MButton,
  MButtonStack,
  MInput,
  MPill,
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { CustomerDedupPicker, type CustomerMatch } from './customer-dedup-picker.js'

const DIVISIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const

export function MobileProjectNew({ companySlug }: { companySlug: string }) {
  const navigate = useNavigate()
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
          status: 'lead',
        },
        companySlug,
      )
      // Notes column lands as a follow-up; for now we surface it through
      // the daily-log path the foreman writes against. Server doesn't
      // accept it on create.
      void notes
      navigate(`/projects/${created.id}`)
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

  return (
    <>
      <MTopBar back title="New project" onBack={() => navigate('/projects')} />
      <MBody>
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
              {busy ? 'Creating…' : 'Create project'}
            </MButton>
            <MButton variant="ghost" onClick={() => navigate('/projects')}>
              Cancel
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
          fontSize: 11,
          fontWeight: 600,
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
