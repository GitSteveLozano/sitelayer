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
  MSectionH,
  MSelect,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'

const DIVISIONS = ['D1', 'D2', 'D3', 'D4', 'D5'] as const

export function MobileProjectNew({ companySlug }: { companySlug: string }) {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [customerName, setCustomerName] = useState('')
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
              onChange={(e) => setCustomerName(e.currentTarget.value)}
              placeholder="Foxridge Homes"
              aria-invalid={customerError ? true : undefined}
              aria-describedby={customerError ? `${customerId}-err` : undefined}
              aria-required="true"
            />
          </Field>
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
