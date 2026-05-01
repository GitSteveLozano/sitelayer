import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  setActiveCompanySlug,
  useCreateCompany,
  useCreateCustomer,
  useCreateInventoryLocation,
  useCreateServiceItem,
  useCreateWorker,
  useInviteMember,
  type Company,
} from '@/lib/api'

/**
 * Onboarding wizard (Phase 6 Batch 7).
 *
 * Three-step flow that creates a company + an admin membership +
 * optional initial seed data (one customer, one worker, one yard
 * location, one service item) so a brand-new tenant can land on the
 * Home tab and see something rather than empty states.
 *
 * Reachable at /onboarding (top-level so it works pre-tab-bar).
 */
export function OnboardingWizardScreen() {
  const navigate = useNavigate()
  const createCompany = useCreateCompany()
  const [company, setCompany] = useState<Company | null>(null)
  const [step, setStep] = useState<'company' | 'team' | 'seed' | 'done'>('company')

  // Step 1 inputs
  const [slug, setSlug] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [seedDefaults, setSeedDefaults] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const createCompanyAndContinue = async () => {
    setError(null)
    try {
      const result = await createCompany.mutateAsync({
        slug: slug.trim().toLowerCase(),
        name: companyName.trim(),
        seed_defaults: seedDefaults,
      })
      setCompany(result.company)
      setActiveCompanySlug(result.company.slug)
      setStep('team')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create company')
    }
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl mx-auto">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Welcome</div>
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Set up your company</h1>
      <p className="text-[13px] text-ink-3 mt-2">
        Three steps to land on a working dashboard. Skip the seed step if you'll bring your own data.
      </p>

      <div className="mt-6 flex items-center gap-2">
        <StepDot active={step === 'company'} done={step !== 'company'} label="1 · Company" />
        <StepDot active={step === 'team'} done={step === 'seed' || step === 'done'} label="2 · Team" />
        <StepDot active={step === 'seed'} done={step === 'done'} label="3 · Seed data" />
      </div>

      <div className="mt-6 space-y-3">
        {step === 'company' ? (
          <Card>
            <Field
              label="Company slug (URL-safe)"
              value={slug}
              onChange={setSlug}
              placeholder="acme-builders"
              hint="2-64 chars, lowercase letters/digits/dashes."
            />
            <Field label="Company name" value={companyName} onChange={setCompanyName} placeholder="ACME Builders" />
            <label className="flex items-center gap-2 mt-3">
              <input
                type="checkbox"
                checked={seedDefaults}
                onChange={(e) => setSeedDefaults(e.target.checked)}
                className="rounded"
              />
              <span className="text-[13px]">Seed default divisions + service items</span>
            </label>
            {error ? <div className="text-[12px] text-status-warn mt-2">{error}</div> : null}
            <div className="mt-3">
              <MobileButton
                variant="primary"
                onClick={createCompanyAndContinue}
                disabled={!slug.trim() || !companyName.trim() || createCompany.isPending}
              >
                {createCompany.isPending ? 'Creating…' : 'Create company'}
              </MobileButton>
            </div>
          </Card>
        ) : null}

        {step === 'team' && company ? <TeamStep company={company} onNext={() => setStep('seed')} /> : null}

        {step === 'seed' && company ? (
          <SeedStep
            company={company}
            onDone={() => {
              setStep('done')
              setTimeout(() => navigate('/'), 800)
            }}
          />
        ) : null}

        {step === 'done' ? (
          <Card>
            <div className="text-[14px] font-semibold">All set</div>
            <div className="text-[12px] text-ink-3 mt-1">Redirecting to your home dashboard…</div>
          </Card>
        ) : null}
      </div>

      <div className="mt-6">
        <Attribution source="POST /api/companies + memberships + per-resource seed inserts" />
      </div>

      <div className="mt-6 text-center">
        <Link to="/" className="text-[12px] text-ink-3">
          Skip to home
        </Link>
      </div>
    </div>
  )
}

function TeamStep({ company, onNext }: { company: Company; onNext: () => void }) {
  const invite = useInviteMember(company.id)
  const [inviteUserId, setInviteUserId] = useState('')
  const [role, setRole] = useState('foreman')
  const [invited, setInvited] = useState<Array<{ id: string; role: string }>>([])
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (!inviteUserId.trim()) {
      onNext()
      return
    }
    try {
      await invite.mutateAsync({ clerk_user_id: inviteUserId.trim(), role })
      setInvited((prev) => [...prev, { id: inviteUserId.trim(), role }])
      setInviteUserId('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invite failed')
    }
  }

  return (
    <Card>
      <div className="text-[14px] font-semibold">Invite your team (optional)</div>
      <div className="text-[12px] text-ink-3 mt-1">
        Add Clerk user ids of teammates. You can also do this later in More → Members.
      </div>
      <Field label="Clerk user id" value={inviteUserId} onChange={setInviteUserId} placeholder="user_2YXxX…" />
      <label className="block mt-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Role</div>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
        >
          <option value="admin">admin</option>
          <option value="office">office</option>
          <option value="foreman">foreman</option>
          <option value="member">member</option>
        </select>
      </label>
      {invited.length > 0 ? (
        <div className="mt-3 space-y-1">
          {invited.map((row) => (
            <div key={row.id} className="flex items-center justify-between text-[12px] text-ink-3">
              <span className="font-mono truncate">{row.id}</span>
              <Pill tone="default">{row.role}</Pill>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <div className="text-[12px] text-status-warn mt-2">{error}</div> : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MobileButton
          variant="ghost"
          onClick={() => {
            setInviteUserId('')
            onNext()
          }}
        >
          Skip
        </MobileButton>
        <MobileButton variant="primary" onClick={submit} disabled={invite.isPending}>
          {invite.isPending ? 'Inviting…' : inviteUserId.trim() ? 'Invite' : 'Continue'}
        </MobileButton>
      </div>
    </Card>
  )
}

function SeedStep({ company, onDone }: { company: Company; onDone: () => void }) {
  const _ = company
  const createCustomer = useCreateCustomer()
  const createWorker = useCreateWorker()
  const createLocation = useCreateInventoryLocation()
  const createServiceItem = useCreateServiceItem()
  const [customerName, setCustomerName] = useState('')
  const [workerName, setWorkerName] = useState('')
  const [yardName, setYardName] = useState('Main yard')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const seeds: Array<Promise<unknown>> = []
      if (customerName.trim()) seeds.push(createCustomer.mutateAsync({ name: customerName.trim() }))
      if (workerName.trim()) seeds.push(createWorker.mutateAsync({ name: workerName.trim(), role: 'foreman' }))
      if (yardName.trim())
        seeds.push(
          createLocation.mutateAsync({
            name: yardName.trim(),
            location_type: 'yard',
            is_default: true,
          }),
        )
      // Always seed one service item so the takeoff hub has a row
      // for the user to estimate against.
      seeds.push(
        createServiceItem.mutateAsync({
          code: 'LBR-FRMR',
          name: 'Foreman labor',
          category: 'labor',
          unit: 'hr',
        }),
      )
      await Promise.all(seeds)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Seed failed')
      setSubmitting(false)
    }
  }

  return (
    <Card>
      <div className="text-[14px] font-semibold">Seed data (optional)</div>
      <div className="text-[12px] text-ink-3 mt-1">One row each so your home dashboard isn't empty on first load.</div>
      <Field label="First customer (e.g. ACME Inc)" value={customerName} onChange={setCustomerName} placeholder="" />
      <Field label="First worker (e.g. Mike Foreman)" value={workerName} onChange={setWorkerName} placeholder="" />
      <Field label="Default yard name" value={yardName} onChange={setYardName} placeholder="Main yard" />
      {error ? <div className="text-[12px] text-status-warn mt-2">{error}</div> : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MobileButton variant="ghost" onClick={onDone}>
          Skip
        </MobileButton>
        <MobileButton variant="primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Seeding…' : 'Seed + finish'}
        </MobileButton>
      </div>
    </Card>
  )
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <div
      className={`text-[11px] font-semibold px-3 py-1 rounded-full border ${
        active
          ? 'bg-accent text-white border-transparent'
          : done
            ? 'bg-card-soft text-ink-2 border-line'
            : 'text-ink-3 border-line'
      }`}
    >
      {label}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
}) {
  return (
    <label className="block mt-3 first:mt-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full text-[15px] py-2 border-b border-line bg-transparent focus:outline-none focus:border-accent"
      />
      {hint ? <div className="text-[11px] text-ink-3 mt-1">{hint}</div> : null}
    </label>
  )
}
