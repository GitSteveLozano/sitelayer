import { useEffect, useState } from 'react'
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
import { useOnboardingWizard, type TeamForm, type SeedOptions } from '@/machines/onboarding-wizard'

/**
 * Onboarding wizard (Phase 6 Batch 7).
 *
 * Three-step flow that creates a company + an admin membership +
 * optional initial seed data (one customer, one worker, one yard
 * location, one service item) so a brand-new tenant can land on the
 * Home tab and see something rather than empty states.
 *
 * Reachable at /onboarding (top-level so it works pre-tab-bar).
 *
 * Step / form orchestration runs through `useOnboardingWizard()` so the
 * back/forward transitions and the company-step gate (`slug + name
 * non-empty`) are testable in isolation. The TanStack mutations stay in
 * the component — the machine emits `SUBMIT` and the component drives
 * the mutation, then sends `MARK_SUBMITTED` / `MARK_FAILED` to advance.
 *
 * TeamStep + SeedStep are now controlled: their form state (invites
 * list, seed values, inline errors) lives in the machine context. The
 * substep components receive `teamForm` / `seedOptions` from the
 * parent's wizard hook and emit `ADD_INVITE`, `REMOVE_INVITE`,
 * `SET_SEED` events instead of holding local state.
 */
export function OnboardingWizardScreen() {
  const navigate = useNavigate()
  const createCompany = useCreateCompany()
  const wizard = useOnboardingWizard()
  const [company, setCompany] = useState<Company | null>(null)

  const runCreateCompany = async () => {
    wizard.submit()
    try {
      const result = await createCompany.mutateAsync({
        slug: wizard.companyForm.slug.trim().toLowerCase(),
        name: wizard.companyForm.name.trim(),
        seed_defaults: wizard.companyForm.seedDefaults,
      })
      setCompany(result.company)
      setActiveCompanySlug(result.company.slug)
      wizard.markSubmitted()
    } catch (e) {
      wizard.markFailed(e instanceof Error ? e.message : 'Failed to create company')
    }
  }

  // Wizard `done` is final — bounce to home once we hit it.
  useEffect(() => {
    if (wizard.isDone) {
      const handle = setTimeout(() => navigate('/'), 800)
      return () => clearTimeout(handle)
    }
    return undefined
  }, [wizard.isDone, navigate])

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl mx-auto">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Welcome</div>
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Set up your company</h1>
      <p className="text-[13px] text-ink-3 mt-2">
        Three steps to land on a working dashboard. Skip the seed step if you'll bring your own data.
      </p>

      <div className="mt-6 flex items-center gap-2">
        <StepDot
          active={wizard.isCompanyStep || wizard.isSubmitting || wizard.isError}
          done={wizard.isTeamStep || wizard.isSeedStep || wizard.isDone}
          label="1 · Company"
        />
        <StepDot active={wizard.isTeamStep} done={wizard.isSeedStep || wizard.isDone} label="2 · Team" />
        <StepDot active={wizard.isSeedStep} done={wizard.isDone} label="3 · Seed data" />
      </div>

      <div className="mt-6 space-y-3">
        {wizard.isCompanyStep || wizard.isSubmitting || wizard.isError ? (
          <Card>
            <Field
              label="Company slug (URL-safe)"
              value={wizard.companyForm.slug}
              onChange={(v) => wizard.setCompanyField('slug', v)}
              placeholder="acme-builders"
              hint="2-64 chars, lowercase letters/digits/dashes."
            />
            <Field
              label="Company name"
              value={wizard.companyForm.name}
              onChange={(v) => wizard.setCompanyField('name', v)}
              placeholder="ACME Builders"
            />
            <label className="flex items-center gap-2 mt-3">
              <input
                type="checkbox"
                checked={wizard.companyForm.seedDefaults}
                onChange={(e) => wizard.setCompanyField('seedDefaults', e.target.checked)}
                className="rounded"
              />
              <span className="text-[13px]">Seed default divisions + service items</span>
            </label>
            {wizard.error ? <div className="text-[12px] text-warn mt-2">{wizard.error}</div> : null}
            <div className="mt-3">
              <MobileButton
                variant="primary"
                onClick={runCreateCompany}
                disabled={!wizard.canAdvanceFromCompany || createCompany.isPending}
              >
                {createCompany.isPending || wizard.isSubmitting ? 'Creating…' : 'Create company'}
              </MobileButton>
            </div>
          </Card>
        ) : null}

        {wizard.isTeamStep && company ? (
          <TeamStep
            company={company}
            teamForm={wizard.teamForm}
            error={wizard.teamError}
            onSetField={wizard.setTeamField}
            onAddInvite={wizard.addInvite}
            onSetError={wizard.setTeamError}
            onNext={() => wizard.next()}
          />
        ) : null}

        {wizard.isSeedStep && company ? (
          <SeedStep
            seedOptions={wizard.seedOptions}
            error={wizard.seedError}
            submitting={wizard.seedSubmitting}
            onSetSeed={wizard.setSeed}
            onSetError={wizard.setSeedError}
            onSetSubmitting={wizard.setSeedSubmitting}
            onDone={() => wizard.submit()}
          />
        ) : null}

        {wizard.isDone ? (
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

interface TeamStepProps {
  company: Company
  teamForm: TeamForm
  error: string | null
  onSetField: (field: 'pendingClerkUserId' | 'pendingRole', value: string) => void
  onAddInvite: (clerkUserId: string, role: string) => void
  onSetError: (error: string | null) => void
  onNext: () => void
}

function TeamStep({ company, teamForm, error, onSetField, onAddInvite, onSetError, onNext }: TeamStepProps) {
  const invite = useInviteMember(company.id)
  const pendingId = teamForm.pendingClerkUserId
  const role = teamForm.pendingRole

  const submit = async () => {
    onSetError(null)
    if (!pendingId.trim()) {
      onNext()
      return
    }
    try {
      await invite.mutateAsync({ clerk_user_id: pendingId.trim(), role })
      onAddInvite(pendingId.trim(), role)
    } catch (e) {
      onSetError(e instanceof Error ? e.message : 'Invite failed')
    }
  }

  return (
    <Card>
      <div className="text-[14px] font-semibold">Invite your team (optional)</div>
      <div className="text-[12px] text-ink-3 mt-1">
        Add Clerk user ids of teammates. You can also do this later in More → Members.
      </div>
      <Field
        label="Clerk user id"
        value={pendingId}
        onChange={(v) => onSetField('pendingClerkUserId', v)}
        placeholder="user_2YXxX…"
      />
      <label className="block mt-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Role</div>
        <select
          value={role}
          onChange={(e) => onSetField('pendingRole', e.target.value)}
          className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
        >
          <option value="admin">admin</option>
          <option value="office">office</option>
          <option value="foreman">foreman</option>
          <option value="member">member</option>
        </select>
      </label>
      {teamForm.invited.length > 0 ? (
        <div className="mt-3 space-y-1">
          {teamForm.invited.map((row) => (
            <div key={row.clerkUserId} className="flex items-center justify-between text-[12px] text-ink-3">
              <span className="font-mono truncate">{row.clerkUserId}</span>
              <Pill tone="default">{row.role}</Pill>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <div className="text-[12px] text-warn mt-2">{error}</div> : null}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <MobileButton
          variant="ghost"
          onClick={() => {
            onSetField('pendingClerkUserId', '')
            onNext()
          }}
        >
          Skip
        </MobileButton>
        <MobileButton variant="primary" onClick={submit} disabled={invite.isPending}>
          {invite.isPending ? 'Inviting…' : pendingId.trim() ? 'Invite' : 'Continue'}
        </MobileButton>
      </div>
    </Card>
  )
}

interface SeedStepProps {
  seedOptions: SeedOptions
  error: string | null
  submitting: boolean
  onSetSeed: (field: keyof SeedOptions, value: string) => void
  onSetError: (error: string | null) => void
  onSetSubmitting: (submitting: boolean) => void
  onDone: () => void
}

function SeedStep({ seedOptions, error, submitting, onSetSeed, onSetError, onSetSubmitting, onDone }: SeedStepProps) {
  // The seed inserts ride on the auth context's active company id
  // (set via setActiveCompanySlug right after company creation), so
  // the seed step doesn't need the company row passed down.
  const createCustomer = useCreateCustomer()
  const createWorker = useCreateWorker()
  const createLocation = useCreateInventoryLocation()
  const createServiceItem = useCreateServiceItem()

  const submit = async () => {
    onSetError(null)
    onSetSubmitting(true)
    // Run each seed independently so a single failure (e.g. duplicate
    // service-item code on retry) doesn't roll back the others. The
    // step is optional anyway — partial success is still useful.
    type SeedTask = { label: string; run: () => Promise<unknown> }
    const tasks: SeedTask[] = []
    if (seedOptions.customerName.trim())
      tasks.push({
        label: 'customer',
        run: () => createCustomer.mutateAsync({ name: seedOptions.customerName.trim() }),
      })
    if (seedOptions.workerName.trim())
      tasks.push({
        label: 'worker',
        run: () => createWorker.mutateAsync({ name: seedOptions.workerName.trim(), role: 'foreman' }),
      })
    if (seedOptions.yardName.trim())
      tasks.push({
        label: 'yard',
        run: () =>
          createLocation.mutateAsync({
            name: seedOptions.yardName.trim(),
            location_type: 'yard',
            is_default: true,
          }),
      })
    tasks.push({
      label: 'service item',
      run: () =>
        createServiceItem.mutateAsync({
          code: 'LBR-FRMR',
          name: 'Foreman labor',
          category: 'labor',
          unit: 'hr',
        }),
    })

    const results = await Promise.allSettled(tasks.map((t) => t.run()))
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? tasks[i]?.label : null))
      .filter((l): l is string => l !== null)
    if (failed.length === 0) {
      onDone()
      return
    }
    // Partial success: surface what failed so the user can finish in
    // the relevant catalog screen instead of retrying the whole step
    // (which would create duplicates of the rows that did succeed).
    onSetError(`Seeded everything except: ${failed.join(', ')}. Finish in More → Catalog.`)
    onSetSubmitting(false)
  }

  return (
    <Card>
      <div className="text-[14px] font-semibold">Seed data (optional)</div>
      <div className="text-[12px] text-ink-3 mt-1">One row each so your home dashboard isn't empty on first load.</div>
      <Field
        label="First customer (e.g. ACME Inc)"
        value={seedOptions.customerName}
        onChange={(v) => onSetSeed('customerName', v)}
        placeholder=""
      />
      <Field
        label="First worker (e.g. Mike Foreman)"
        value={seedOptions.workerName}
        onChange={(v) => onSetSeed('workerName', v)}
        placeholder=""
      />
      <Field
        label="Default yard name"
        value={seedOptions.yardName}
        onChange={(v) => onSetSeed('yardName', v)}
        placeholder="Main yard"
      />
      {error ? <div className="text-[12px] text-warn mt-2">{error}</div> : null}
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
