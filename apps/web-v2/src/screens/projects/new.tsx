import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Card, MobileButton } from '@/components/mobile'
import { TopAppBar } from '@/components/nav/TopAppBar'
import {
  useCreateCustomer,
  useCreateProject,
  useCustomers,
  useDivisions,
  type Customer,
} from '@/lib/api'

/**
 * `prj-new` — Sitemap §04 panels 2/3/4 ("New project" wizard).
 *
 * Three steps, single screen with progressive disclosure. Each step
 * advances when its required fields are filled — no separate URLs so
 * back/forward feels like one form, not a multi-page flow.
 *
 *   1. **Name** — project name + an optional phase suffix.
 *   2. **Customer** — pick from the existing roster, or "+ new" to
 *      create one inline. Customer create POST happens before project
 *      create so the project carries `customer_id` from the start.
 *   3. **Scope** — division code (D1..Dn from /api/divisions) and
 *      optional bid_total. Status defaults to `lead` per panel 4.
 *
 * On submit we POST /api/projects, invalidate the list cache, and
 * navigate to the new project's detail screen.
 */
type WizardStep = 'name' | 'customer' | 'scope'

export function NewProjectScreen() {
  const navigate = useNavigate()
  const customers = useCustomers()
  const divisions = useDivisions()
  const createCustomer = useCreateCustomer()
  const createProject = useCreateProject()

  const [step, setStep] = useState<WizardStep>('name')
  const [name, setName] = useState('')
  const [pickedCustomerId, setPickedCustomerId] = useState<string | null>(null)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [divisionCode, setDivisionCode] = useState('D4')
  const [bidInput, setBidInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const customerName = useMemo(() => {
    if (pickedCustomerId === '__new__') return newCustomerName.trim()
    if (pickedCustomerId)
      return customers.data?.customers.find((c) => c.id === pickedCustomerId)?.name?.trim() ?? ''
    return ''
  }, [pickedCustomerId, newCustomerName, customers.data])

  const canAdvanceFromName = name.trim().length >= 2
  const canAdvanceFromCustomer = customerName.length >= 2

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      // Resolve customer_id — create-as-needed runs first so a new
      // customer never lands without a project tied to it.
      let customerId: string | null = null
      if (pickedCustomerId === '__new__') {
        const created: Customer = await createCustomer.mutateAsync({ name: newCustomerName.trim() })
        customerId = created.id
      } else if (pickedCustomerId) {
        customerId = pickedCustomerId
      }

      const bidTotal = parseBid(bidInput)

      const project = await createProject.mutateAsync({
        name: name.trim(),
        customer_name: customerName,
        customer_id: customerId,
        division_code: divisionCode,
        status: 'lead',
        ...(bidTotal !== null ? { bid_total: bidTotal } : {}),
      })
      navigate(`/projects/${project.id}`, { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the project. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col">
      <TopAppBar title="New project" showBack backTo="/projects" />

      <div className="px-5 pt-4 pb-10 max-w-md">
        <ProgressDots step={step} />

        {step === 'name' ? (
          <Card className="mt-4">
            <label className="block">
              <span className="text-[12px] font-semibold text-ink-2">Project name</span>
              <input
                type="text"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Hillcrest Mews — Phase 4"
                className="mt-1.5 w-full h-11 px-3 rounded-[12px] bg-bg border border-line text-[15px] focus:outline-none focus:border-accent"
              />
              <span className="block text-[11px] text-ink-3 mt-1">
                Site address or phase tag — whatever the crew calls it on the radio.
              </span>
            </label>
          </Card>
        ) : null}

        {step === 'customer' ? (
          <CustomerStep
            customers={customers.data?.customers ?? []}
            isLoading={customers.isPending}
            picked={pickedCustomerId}
            onPick={setPickedCustomerId}
            newCustomerName={newCustomerName}
            onNewCustomerNameChange={setNewCustomerName}
          />
        ) : null}

        {step === 'scope' ? (
          <Card className="mt-4">
            <div className="text-[12px] font-semibold text-ink-2">Division</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(divisions.data?.divisions ?? []).map((d) => (
                <button
                  key={d.code}
                  type="button"
                  onClick={() => setDivisionCode(d.code)}
                  className={`px-3 py-1.5 rounded-full text-[13px] font-medium border ${
                    divisionCode === d.code
                      ? 'bg-accent text-white border-transparent'
                      : 'bg-card-soft text-ink-2 border-line'
                  }`}
                >
                  {d.code} · {d.name}
                </button>
              ))}
              {divisions.isPending ? <span className="text-[12px] text-ink-3">Loading…</span> : null}
            </div>

            <label className="block mt-4">
              <span className="text-[12px] font-semibold text-ink-2">Bid total (optional)</span>
              <div className="mt-1.5 relative">
                <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 text-[15px]">
                  $
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={bidInput}
                  onChange={(e) => setBidInput(e.target.value)}
                  placeholder="184,250"
                  className="w-full h-11 pl-7 pr-3 rounded-[12px] bg-bg border border-line text-[15px] focus:outline-none focus:border-accent num"
                />
              </div>
              <span className="block text-[11px] text-ink-3 mt-1">
                Skip if you're still scoping — you can set it later from the project page.
              </span>
            </label>

            <div className="mt-4 text-[12px] text-ink-3">
              <span className="font-semibold text-ink-2">{name}</span> for{' '}
              <span className="font-semibold text-ink-2">{customerName}</span>. Status will start as{' '}
              <span className="font-semibold">lead</span>.
            </div>
          </Card>
        ) : null}

        {error ? (
          <div className="mt-3 rounded-[12px] border border-bad-soft bg-bad-soft px-3 py-2 text-[12px] text-bad">
            {error}
          </div>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          {step === 'name' ? (
            <Link to="/projects" className="block">
              <MobileButton variant="ghost">Cancel</MobileButton>
            </Link>
          ) : (
            <MobileButton variant="ghost" onClick={() => setStep(prevStep(step))} disabled={busy}>
              Back
            </MobileButton>
          )}
          {step === 'scope' ? (
            <MobileButton variant="primary" onClick={submit} disabled={busy}>
              {busy ? 'Creating…' : 'Create project'}
            </MobileButton>
          ) : (
            <MobileButton
              variant="primary"
              onClick={() => setStep(nextStep(step))}
              disabled={(step === 'name' && !canAdvanceFromName) || (step === 'customer' && !canAdvanceFromCustomer)}
            >
              Continue
            </MobileButton>
          )}
        </div>
      </div>
    </div>
  )
}

function CustomerStep({
  customers,
  isLoading,
  picked,
  onPick,
  newCustomerName,
  onNewCustomerNameChange,
}: {
  customers: Customer[]
  isLoading: boolean
  picked: string | null
  onPick: (id: string | null) => void
  newCustomerName: string
  onNewCustomerNameChange: (v: string) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customers
    return customers.filter((c) => c.name.toLowerCase().includes(q))
  }, [customers, search])

  return (
    <Card className="mt-4">
      <div className="text-[12px] font-semibold text-ink-2">Customer</div>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search customers…"
        className="mt-2 w-full h-10 px-3 rounded-[12px] bg-bg border border-line text-[14px] focus:outline-none focus:border-accent"
      />

      <ul className="mt-3 max-h-[280px] overflow-y-auto divide-y divide-line">
        <li>
          <button
            type="button"
            onClick={() => onPick('__new__')}
            className={`w-full flex items-center justify-between py-2.5 text-left ${
              picked === '__new__' ? 'text-accent' : 'text-ink-2'
            }`}
          >
            <span className="text-[14px] font-medium">+ New customer</span>
            {picked === '__new__' ? <span aria-hidden="true">●</span> : null}
          </button>
        </li>
        {isLoading ? (
          <li className="py-3 text-[12px] text-ink-3">Loading customers…</li>
        ) : filtered.length === 0 ? (
          <li className="py-3 text-[12px] text-ink-3">
            {search ? `No matches for "${search}".` : 'No customers yet — add one above.'}
          </li>
        ) : (
          filtered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                className={`w-full flex items-center justify-between py-2.5 text-left ${
                  picked === c.id ? 'text-accent' : 'text-ink-2'
                }`}
              >
                <span className="text-[14px] font-medium truncate">{c.name}</span>
                {picked === c.id ? <span aria-hidden="true">●</span> : null}
              </button>
            </li>
          ))
        )}
      </ul>

      {picked === '__new__' ? (
        <label className="block mt-3">
          <span className="text-[12px] font-semibold text-ink-2">New customer name</span>
          <input
            type="text"
            autoFocus
            value={newCustomerName}
            onChange={(e) => onNewCustomerNameChange(e.target.value)}
            placeholder="Acme Properties"
            className="mt-1.5 w-full h-11 px-3 rounded-[12px] bg-bg border border-line text-[15px] focus:outline-none focus:border-accent"
          />
        </label>
      ) : null}
    </Card>
  )
}

function ProgressDots({ step }: { step: WizardStep }) {
  const order: WizardStep[] = ['name', 'customer', 'scope']
  const idx = order.indexOf(step)
  return (
    <div className="flex items-center gap-1.5" aria-label="Wizard progress">
      {order.map((s, i) => (
        <span
          key={s}
          aria-hidden="true"
          className={`h-1 rounded-full transition-all ${
            i === idx ? 'w-8 bg-accent' : i < idx ? 'w-4 bg-accent-soft' : 'w-4 bg-card-soft'
          }`}
        />
      ))}
      <span className="ml-2 text-[11px] text-ink-3">
        Step {idx + 1} of {order.length}
      </span>
    </div>
  )
}

function nextStep(s: WizardStep): WizardStep {
  if (s === 'name') return 'customer'
  if (s === 'customer') return 'scope'
  return 'scope'
}

function prevStep(s: WizardStep): WizardStep {
  if (s === 'scope') return 'customer'
  if (s === 'customer') return 'name'
  return 'name'
}

/** Parse a friendly bid input ("184,250" / "$184,250" / "184250.00") to a number, or null when blank. */
function parseBid(input: string): number | null {
  const cleaned = input.replace(/[^0-9.]/g, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}
