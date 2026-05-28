/**
 * Owner desktop new-project kickoff (Desktop v2 · Owner · New project).
 * Mirrors the template's "OWNER · NEW PROJECT · KICKOFF" frame (#m-onp) as a
 * centered form card on the command-center shell.
 *
 * This reuses the EXACT create logic from the mobile project-create form
 * (`screens/mobile/project-new.tsx`): the same `apiPost('/api/projects', ...)`
 * body shape, the same `CustomerDedupPicker` linkage, and the same field set
 * (name, client, division, bid value). No new endpoints. On success we
 * navigate to the desktop project detail route. See owner-dashboard.tsx for
 * the d-content / d-stack / DEyebrow / DH1 primitive pattern.
 */
import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost, getActiveCompanySlug } from '@/lib/api'
import { DEyebrow, DH1 } from '@/components/d'
import { MButton, MInput, MPill, MSelect, MTextarea } from '@/components/m'
import { CustomerDedupPicker, type CustomerMatch } from '../mobile/customer-dedup-picker.js'

const DIVISIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const

export function OwnerNewProject() {
  const navigate = useNavigate()
  const companySlug = getActiveCompanySlug()

  const [name, setName] = useState('')
  const [customerName, setCustomerName] = useState('')
  // Dedup linkage: when the owner adopts an existing customer (via the
  // QuickBooks-style dedup picker) we link the project to that record's id
  // instead of minting a duplicate.
  const [linkedCustomer, setLinkedCustomer] = useState<CustomerMatch | null>(null)
  // The user explicitly chose "create new" for the current typed name —
  // remember it so the prompt doesn't immediately re-appear for that name.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [divisionCode, setDivisionCode] = useState<(typeof DIVISIONS)[number]>('D4')
  const [bidTotal, setBidTotal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only surface inline validation after a submit attempt.
  const [touched, setTouched] = useState(false)

  const nameId = useId()
  const customerId = useId()
  const nameError = touched && name.trim().length === 0 ? 'Project name is required.' : null
  const customerError = touched && customerName.trim().length === 0 ? 'Client name is required.' : null

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
          // When the owner linked to an existing customer through the dedup
          // picker, carry that customer's id so the server attaches the
          // project to the real record instead of creating a duplicate.
          ...(linkedCustomer ? { customer_id: linkedCustomer.customer.id } : {}),
          // Address isn't a create-time column on /api/projects; the server
          // doesn't accept it. Keep it captured for the operator but don't
          // send a field the route would reject.
          division_code: divisionCode,
          bid_total: bidTotal ? Number(bidTotal) : 0,
          status: 'lead',
        },
        companySlug,
      )
      void address
      navigate(`/desktop/projects/${created.id}`)
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

  // User edited the client field — drop any existing link (the typed name no
  // longer necessarily refers to the linked record) and re-arm matching.
  const handleCustomerChange = (value: string) => {
    setCustomerName(value)
    if (linkedCustomer) setLinkedCustomer(null)
    if (dismissedFor !== null) setDismissedFor(null)
  }

  return (
    <div className="d-content">
      <div className="d-stack" style={{ maxWidth: 640, margin: '0 auto', width: '100%' }}>
        <div>
          <DEyebrow>Owner · New project</DEyebrow>
          <DH1>Start a job.</DH1>
        </div>

        <div className="d-card">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
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

            {dismissedFor !== customerName.trim() ? (
              <CustomerDedupPicker
                typedName={customerName}
                linkedCustomerId={linkedCustomer?.customer.id ?? null}
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

            {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
              <MButton variant="ghost" onClick={() => navigate('/desktop/projects')}>
                Cancel
              </MButton>
              <MButton variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
                {busy ? 'Creating…' : 'Create project'}
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
        <p id={htmlFor ? `${htmlFor}-err` : undefined} style={{ marginTop: 6, marginBottom: 0, color: 'var(--m-red)', fontSize: 12 }}>
          {error}
        </p>
      ) : null}
    </label>
  )
}
