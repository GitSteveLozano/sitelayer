import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { API_URL, apiPost, createCompany, DEFAULT_COMPANY_SLUG, FIXTURES_ENABLED, inviteMembership } from '../api.js'
import type { BootstrapResponse } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Checkbox } from '../components/ui/checkbox.js'
import { Input } from '../components/ui/input.js'
import { Select } from '../components/ui/select.js'
import { toastError, toastSuccess } from '../components/ui/toast.js'

// Four discrete steps. The wizard is a finite state machine where the only
// transitions are next/back (no skipping ahead). Step 0 ("basics") and step 1
// ("first project") are required; steps 2 ("invite") and 3 ("qbo") are
// skippable — users can revisit the surfaces later from the normal UI.
const STEPS = ['basics', 'project', 'invite', 'qbo'] as const
type Step = (typeof STEPS)[number]
const STEP_TITLES: Record<Step, string> = {
  basics: 'Company basics',
  project: 'First project',
  invite: 'Invite crew',
  qbo: 'Connect QuickBooks',
}

type InviteRow = { email: string; role: 'admin' | 'foreman' | 'office' | 'member' }

type WizardDraft = {
  step: Step
  basics: {
    slug: string
    name: string
    useTemplate: boolean
  }
  createdCompany: {
    id: string
    slug: string
    name: string
  } | null
  project: {
    name: string
    customerName: string
    divisionCode: string
    bidTotal: string
  }
  invites: InviteRow[]
  qboAuthUrl: string | null
}

const DRAFT_KEY = 'sitelayer.onboardingWizard.v1'

const defaultDraft: WizardDraft = {
  step: 'basics',
  basics: { slug: '', name: '', useTemplate: true },
  createdCompany: null,
  project: { name: '', customerName: '', divisionCode: '', bidTotal: '' },
  invites: [{ email: '', role: 'member' }],
  qboAuthUrl: null,
}

function loadDraft(): WizardDraft {
  if (typeof window === 'undefined') return defaultDraft
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY)
    if (!raw) return defaultDraft
    const parsed = JSON.parse(raw) as Partial<WizardDraft>
    return {
      ...defaultDraft,
      ...parsed,
      basics: { ...defaultDraft.basics, ...(parsed.basics ?? {}) },
      project: { ...defaultDraft.project, ...(parsed.project ?? {}) },
      invites: Array.isArray(parsed.invites) && parsed.invites.length ? parsed.invites : defaultDraft.invites,
    }
  } catch {
    return defaultDraft
  }
}

function saveDraft(draft: WizardDraft) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  } catch {
    // localStorage full or disabled — wizard still works, just no resume.
  }
}

function clearDraft() {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(DRAFT_KEY)
  } catch {
    // ignore
  }
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

async function fetchQboAuthUrl(companySlug: string): Promise<string> {
  // Mirrors startQboOAuth but returns the URL instead of navigating. The
  // onboarding wizard surfaces the URL so the user can pop the OAuth flow in a
  // new tab and return to finish the wizard.
  if (FIXTURES_ENABLED) {
    return 'https://example.com/fixture-qbo-oauth'
  }
  const response = await fetch(`${API_URL}/api/integrations/qbo/auth`, {
    headers: { 'x-sitelayer-company-slug': companySlug },
  })
  if (!response.ok) {
    const fallback = await response.text()
    throw new Error(`GET /api/integrations/qbo/auth failed: ${response.status} ${fallback}`)
  }
  const payload = (await response.json()) as { authUrl?: string }
  if (!payload.authUrl) throw new Error('QBO auth URL was not returned')
  return payload.authUrl
}

type OnboardingViewProps = {
  bootstrap: BootstrapResponse | null
  activeCompanySlug: string
  setCompanySlug: (slug: string) => void
  onCompleted: () => void
}

export function OnboardingView({ bootstrap, activeCompanySlug, setCompanySlug, onCompleted }: OnboardingViewProps) {
  const navigate = useNavigate()
  const [draft, setDraft] = useState<WizardDraft>(() => loadDraft())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Persist to localStorage on every change. Cheap: the draft is a small
  // object and updates are rare (user-driven, not effect-driven).
  useEffect(() => {
    saveDraft(draft)
  }, [draft])

  // Once a company is created, fall back to the live bootstrap's divisions so
  // the project step can render real division options instead of a frozen
  // snapshot. Bootstrap refresh is async, so we keep a safe empty-array default.
  const availableDivisions = useMemo(() => bootstrap?.divisions ?? [], [bootstrap?.divisions])

  const stepIndex = STEPS.indexOf(draft.step)
  const totalSteps = STEPS.length

  const update = useCallback(<K extends keyof WizardDraft>(key: K, value: WizardDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }, [])

  const goto = useCallback((step: Step) => {
    setDraft((current) => ({ ...current, step }))
    setError(null)
  }, [])

  const next = useCallback(() => {
    const nextStep = STEPS[stepIndex + 1]
    if (nextStep) goto(nextStep)
  }, [stepIndex, goto])

  const back = useCallback(() => {
    const prev = STEPS[stepIndex - 1]
    if (prev) goto(prev)
  }, [stepIndex, goto])

  // ---- Step 0: basics — create the company ----
  const submitBasics = useCallback(async () => {
    const slug = draft.basics.slug.trim().toLowerCase()
    const name = draft.basics.name.trim()
    if (!slug) {
      setError('Company slug is required')
      return
    }
    if (!SLUG_PATTERN.test(slug)) {
      setError('Slug must be 2-64 chars: lowercase letters, digits, dashes')
      return
    }
    if (!name) {
      setError('Company name is required')
      return
    }
    try {
      setBusy(true)
      setError(null)
      const response = await createCompany(
        { slug, name, seed_defaults: draft.basics.useTemplate },
        activeCompanySlug || DEFAULT_COMPANY_SLUG,
      )
      setDraft((current) => ({
        ...current,
        createdCompany: {
          id: response.company.id,
          slug: response.company.slug,
          name: response.company.name,
        },
      }))
      setCompanySlug(response.company.slug)
      toastSuccess('Company created', response.company.name)
      next()
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : 'Unknown error'
      setError(message)
      toastError('Could not create company', message)
    } finally {
      setBusy(false)
    }
  }, [draft.basics, activeCompanySlug, next, setCompanySlug])

  // ---- Step 1: first project ----
  const submitProject = useCallback(async () => {
    if (!draft.createdCompany) {
      setError('Create the company first')
      return
    }
    const name = draft.project.name.trim()
    const customerName = draft.project.customerName.trim()
    const divisionCode = draft.project.divisionCode.trim() || availableDivisions[0]?.code || ''
    const bidTotalNumber = Number(draft.project.bidTotal || 0)
    if (!name) {
      setError('Project name is required')
      return
    }
    if (!customerName) {
      setError('Customer name is required')
      return
    }
    if (!divisionCode) {
      setError('Division is required')
      return
    }
    if (!Number.isFinite(bidTotalNumber) || bidTotalNumber < 0) {
      setError('Bid total must be a positive number')
      return
    }
    try {
      setBusy(true)
      setError(null)
      await apiPost(
        '/api/projects',
        {
          name,
          customer_name: customerName,
          division_code: divisionCode,
          status: 'lead',
          bid_total: bidTotalNumber,
          labor_rate: 38,
          bonus_pool: 0,
        },
        draft.createdCompany.slug,
      )
      toastSuccess('Project added', name)
      next()
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : 'Unknown error'
      setError(message)
      toastError('Could not create project', message)
    } finally {
      setBusy(false)
    }
  }, [draft.createdCompany, draft.project, availableDivisions, next])

  // ---- Step 2: invite crew (skippable) ----
  const submitInvites = useCallback(async () => {
    if (!draft.createdCompany) {
      setError('Create the company first')
      return
    }
    const rows = draft.invites.filter((row) => row.email.trim().length > 0)
    if (rows.length === 0) {
      next()
      return
    }
    try {
      setBusy(true)
      setError(null)
      let sent = 0
      for (const row of rows) {
        const email = row.email.trim()
        if (!email.includes('@')) {
          throw new Error(`"${email}" is not a valid email`)
        }
        // Invite endpoint expects clerk_user_id; until the Clerk invite flow
        // lands we pass the email as the identifier. Clerk's User.Create flow
        // resolves by primary email, so this survives as a stable handle.
        await inviteMembership(
          draft.createdCompany.id,
          { clerk_user_id: email, role: row.role },
          draft.createdCompany.slug,
        )
        sent += 1
      }
      if (sent > 0) toastSuccess(`${sent} invitation${sent === 1 ? '' : 's'} sent`)
      next()
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : 'Unknown error'
      setError(message)
      toastError('Could not send invites', message)
    } finally {
      setBusy(false)
    }
  }, [draft.createdCompany, draft.invites, next])

  // ---- Step 3: QBO (skippable) ----
  const loadQbo = useCallback(async () => {
    if (!draft.createdCompany) {
      setError('Create the company first')
      return
    }
    try {
      setBusy(true)
      setError(null)
      const url = await fetchQboAuthUrl(draft.createdCompany.slug)
      update('qboAuthUrl', url)
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : 'Unknown error'
      setError(message)
      toastError('QBO auth unavailable', message)
    } finally {
      setBusy(false)
    }
  }, [draft.createdCompany, update])

  const finish = useCallback(() => {
    clearDraft()
    onCompleted()
    navigate('/projects')
  }, [navigate, onCompleted])

  // Helpers for invite rows
  const updateInvite = (index: number, patch: Partial<InviteRow>) => {
    setDraft((current) => {
      const copy = current.invites.slice()
      copy[index] = { ...copy[index]!, ...patch }
      return { ...current, invites: copy }
    })
  }
  const addInvite = () => {
    setDraft((current) => ({ ...current, invites: [...current.invites, { email: '', role: 'member' }] }))
  }
  const removeInvite = (index: number) => {
    setDraft((current) => {
      const copy = current.invites.slice()
      copy.splice(index, 1)
      return { ...current, invites: copy.length ? copy : [{ email: '', role: 'member' }] }
    })
  }

  const canGoBack = stepIndex > 0 && !busy
  const companyReady = Boolean(draft.createdCompany)

  return (
    <section className="panel" data-testid="onboarding-wizard">
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h2>Set up your Sitelayer workspace</h2>
        <span className="muted compact" data-testid="onboarding-progress">
          Step {stepIndex + 1} / {totalSteps} — {STEP_TITLES[draft.step]}
        </span>
      </header>
      <ol
        className="stages"
        style={{ display: 'flex', gap: 8, margin: '8px 0 16px', padding: 0, listStyle: 'none' }}
        aria-label="Onboarding progress"
      >
        {STEPS.map((step, idx) => {
          const status = idx < stepIndex ? 'done' : idx === stepIndex ? 'current' : 'pending'
          return (
            <li
              key={step}
              data-status={status}
              style={{
                flex: 1,
                padding: '6px 10px',
                borderRadius: 6,
                border: '1px solid rgba(148, 163, 184, 0.35)',
                background:
                  status === 'current'
                    ? 'rgba(59, 130, 246, 0.15)'
                    : status === 'done'
                      ? 'rgba(34, 197, 94, 0.1)'
                      : 'transparent',
                fontWeight: status === 'current' ? 600 : 400,
                fontSize: 12,
              }}
            >
              {idx + 1}. {STEP_TITLES[step]}
            </li>
          )
        })}
      </ol>

      {error ? (
        <p className="muted" role="alert" style={{ color: '#ef4444' }} data-testid="onboarding-error">
          {error}
        </p>
      ) : null}

      {draft.step === 'basics' ? (
        <div className="formGrid" data-testid="step-basics">
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Company slug</span>
            <Input
              name="slug"
              value={draft.basics.slug}
              placeholder="acme-construction"
              onChange={(event) => update('basics', { ...draft.basics, slug: event.target.value })}
              data-testid="onboarding-slug"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Company name</span>
            <Input
              name="name"
              value={draft.basics.name}
              placeholder="Acme Construction"
              onChange={(event) => update('basics', { ...draft.basics, name: event.target.value })}
              data-testid="onboarding-name"
            />
          </label>
          <label className="checkbox" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Checkbox
              checked={draft.basics.useTemplate}
              onChange={(event) => update('basics', { ...draft.basics, useTemplate: event.target.checked })}
              data-testid="onboarding-use-template"
            />
            <span>Use L&A Operations template (9 divisions + 12 service items)</span>
          </label>
        </div>
      ) : null}

      {draft.step === 'project' ? (
        <div className="formGrid" data-testid="step-project">
          <p className="muted compact">
            Creating the first project for {draft.createdCompany?.name ?? 'your company'}.
          </p>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Project name</span>
            <Input
              value={draft.project.name}
              placeholder="Hillcrest Phase 4"
              onChange={(event) => update('project', { ...draft.project, name: event.target.value })}
              data-testid="onboarding-project-name"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Customer</span>
            <Input
              value={draft.project.customerName}
              placeholder="Hillcrest Homes"
              list="onboarding-customer-options"
              onChange={(event) => update('project', { ...draft.project, customerName: event.target.value })}
              data-testid="onboarding-customer"
            />
            <datalist id="onboarding-customer-options">
              {(bootstrap?.customers ?? []).map((customer) => (
                <option key={customer.id} value={customer.name} />
              ))}
            </datalist>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Division</span>
            <Select
              value={draft.project.divisionCode || availableDivisions[0]?.code || ''}
              onChange={(event) => update('project', { ...draft.project, divisionCode: event.target.value })}
              data-testid="onboarding-division"
            >
              {availableDivisions.length === 0 ? <option value="">No divisions available</option> : null}
              {availableDivisions.map((division) => (
                <option key={division.code} value={division.code}>
                  {division.code} — {division.name}
                </option>
              ))}
            </Select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>Bid total (CAD)</span>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={draft.project.bidTotal}
              placeholder="150000"
              onChange={(event) => update('project', { ...draft.project, bidTotal: event.target.value })}
              data-testid="onboarding-bid-total"
            />
          </label>
        </div>
      ) : null}

      {draft.step === 'invite' ? (
        <div data-testid="step-invite" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <p className="muted compact">
            Add your foremen and office staff now, or skip and invite them later from Projects → Invite Member.
          </p>
          {draft.invites.map((row, index) => (
            <div
              key={index}
              className="formGrid"
              style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
              data-testid={`invite-row-${index}`}
            >
              <Input
                type="email"
                value={row.email}
                placeholder="name@example.com"
                onChange={(event) => updateInvite(index, { email: event.target.value })}
                aria-label={`Invite ${index + 1} email`}
              />
              <Select
                value={row.role}
                onChange={(event) => updateInvite(index, { role: event.target.value as InviteRow['role'] })}
                aria-label={`Invite ${index + 1} role`}
                style={{ maxWidth: 160 }}
              >
                <option value="foreman">foreman</option>
                <option value="office">office</option>
                <option value="member">member</option>
                <option value="admin">admin</option>
              </Select>
              <Button type="button" variant="ghost" size="sm" onClick={() => removeInvite(index)}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="outline" size="sm" onClick={addInvite} data-testid="onboarding-add-invite">
              + Add another
            </Button>
          </div>
        </div>
      ) : null}

      {draft.step === 'qbo' ? (
        <div data-testid="step-qbo" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="muted compact">
            Link QuickBooks Online to sync customers and invoices. You can connect later from Integrations.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button type="button" onClick={loadQbo} disabled={busy || !companyReady} data-testid="onboarding-qbo-start">
              {busy ? 'Loading…' : draft.qboAuthUrl ? 'Refresh auth link' : 'Get connect link'}
            </Button>
            {draft.qboAuthUrl ? (
              <a
                href={draft.qboAuthUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold h-9 px-3 border border-input bg-background text-foreground"
                data-testid="onboarding-qbo-link"
              >
                Open QuickBooks OAuth ↗
              </a>
            ) : null}
          </div>
          <p className="muted compact">
            Click the link above, authorize in the new tab, then come back here and finish.
          </p>
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16, gap: 8 }}>
        <Button type="button" variant="ghost" onClick={back} disabled={!canGoBack} data-testid="onboarding-back">
          Back
        </Button>
        <div style={{ display: 'flex', gap: 8 }}>
          {draft.step === 'invite' || draft.step === 'qbo' ? (
            <Button type="button" variant="outline" onClick={next} disabled={busy} data-testid="onboarding-skip">
              Skip
            </Button>
          ) : null}
          {draft.step === 'basics' ? (
            <Button type="button" onClick={submitBasics} disabled={busy} data-testid="onboarding-next">
              {busy ? 'Creating…' : 'Create company'}
            </Button>
          ) : null}
          {draft.step === 'project' ? (
            <Button type="button" onClick={submitProject} disabled={busy} data-testid="onboarding-next">
              {busy ? 'Adding…' : 'Add project'}
            </Button>
          ) : null}
          {draft.step === 'invite' ? (
            <Button type="button" onClick={submitInvites} disabled={busy} data-testid="onboarding-next">
              {busy ? 'Sending…' : 'Send invites'}
            </Button>
          ) : null}
          {draft.step === 'qbo' ? (
            <Button type="button" onClick={finish} disabled={busy} data-testid="onboarding-finish">
              Finish
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  )
}
