/**
 * OWNER · ONBOARDING (`owner-onboarding`) — design source V2OwnerOnboarding,
 * the mobile master flow from Steve's mobile bundle (steve.html):
 * Company → Crew Size → Integrations → Ready.
 *
 * This is the MOBILE owner-onboarding flow. The desktop equivalent is
 * `screens/desktop/onboarding/onboarding.tsx` (sign-in → company → team →
 * connect → ready, centered-card layout). The pre-existing mobile
 * `/onboarding` (`routes/onboarding.tsx` → `screens/onboarding/wizard.tsx`)
 * is a different, plainer 3-step company/team/seed wizard kept for the
 * Tailwind-styled tenant-bootstrap path; this screen is the brutalist
 * m-* persona flow the v2 mobile design calls for.
 *
 * Four steps:
 *   1. Company   — name + trade (real `useCreateCompany` on advance).
 *   2. Crew Size — solo vs multi-crew toggle (drives the Ready summary
 *                  and what comes next; persisted client-side only).
 *   3. Integrations — QBO connect (real `fetchQboAuthUrl` → redirect) +
 *                  skippable. The skip path is clearly labelled.
 *   4. Ready     — summary of what was set up + create-first-project.
 *
 * Full-screen takeover mounted in App.tsx (pre-workspace, like /welcome and
 * the invite screens), so it is NOT inside MobileShell — it wraps itself in
 * MShell. Owner = default light theme, so no `.m-dark`.
 *
 * Wired:
 *   - Company create → `useCreateCompany` + `setActiveCompanySlug` (same
 *     contract the existing wizard uses, incl. 409 suggested-slug bounce).
 *   - QBO connect → `fetchQboAuthUrl` then `window.location.assign(authUrl)`.
 * Stub / client-only:
 *   - Trade + crew-size selection are presentational (no API field yet) —
 *     TODO(wire) once the company profile carries trade/crew metadata.
 *   - "Create first project" routes to /projects/new.
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { MShell, MBody, MButton, MButtonStack, MTopBar, MI } from '@/components/m'
import { fetchQboAuthUrl, setActiveCompanySlug, suggestedSlugFromError, useCreateCompany } from '@/lib/api'

type Step = 'company' | 'crew' | 'connect' | 'ready'
const STEP_ORDER: readonly Step[] = ['company', 'crew', 'connect', 'ready'] as const

/** UPPERCASE top-bar title per step (msg__01/02/03 headers). */
const STEP_TITLES: Record<Step, string> = {
  company: 'COMPANY',
  crew: 'YOUR CREW',
  connect: 'CONNECT',
  ready: 'READY',
}

/** Selectable trade for the 3-col company grid (mirrors desktop). */
const TRADES = ['STUCCO', 'DRYWALL', 'PAINT', 'FRAMING', 'GENERAL', 'OTHER'] as const
type Trade = (typeof TRADES)[number]

/**
 * Crew-size offers the four design tiers (msg__02). `id` is the value the
 * user picks; `tier` collapses each tier to the solo/multi branching the
 * Ready summary + downstream setup already understand (solo for "just me",
 * multi for any crew). Picking a tier > solo means foremen/crew get invited
 * next.
 */
const CREW_SIZES = [
  {
    id: 'solo' as const,
    tier: 'solo' as const,
    label: 'JUST ME · SOLO',
    sub: "YOU'LL WEAR ALL 4 HATS. SWITCH ANY TIME.",
  },
  {
    id: '2-5' as const,
    tier: 'multi' as const,
    label: '2 - 5 PEOPLE',
    sub: 'INVITE FOREMEN + CREW NEXT',
  },
  {
    id: '6-15' as const,
    tier: 'multi' as const,
    label: '6 - 15 PEOPLE',
    sub: 'MULTI-CREW · MULTI-SITE',
  },
  {
    id: '15+' as const,
    tier: 'multi' as const,
    label: '15+ PEOPLE',
    sub: "WE'LL ADD ROLES + PERMISSIONS RULES",
  },
]
type CrewSize = (typeof CREW_SIZES)[number]['id']
/** Collapse a selected crew-size id to the solo/multi branch. */
function crewTierFor(id: CrewSize | null): 'solo' | 'multi' | null {
  if (id == null) return null
  return CREW_SIZES.find((c) => c.id === id)?.tier ?? null
}

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

export function OwnerOnboardingScreen() {
  const navigate = useNavigate()
  const createCompany = useCreateCompany()

  const [step, setStep] = useState<Step>('company')

  // Company step.
  const [companyName, setCompanyName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [trade, setTrade] = useState<Trade | null>(null)
  const [companyError, setCompanyError] = useState<string | null>(null)
  const [created, setCreated] = useState(false)

  // Crew step.
  const [crewSize, setCrewSize] = useState<CrewSize | null>(null)

  // Connect step.
  const [qboConnected, setQboConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const stepIndex = STEP_ORDER.indexOf(step)

  // The effective slug: explicit if the user edited it, otherwise derived
  // from the name (same lowercased shape the wizard sends).
  const effectiveSlug = slugTouched ? slug.trim().toLowerCase() : slugify(companyName)
  const canCreate = companyName.trim().length > 0 && effectiveSlug.length >= 2

  const goNext = () => {
    const next = STEP_ORDER[stepIndex + 1]
    if (next) setStep(next)
  }
  const goBack = () => {
    const prev = STEP_ORDER[stepIndex - 1]
    if (prev) setStep(prev)
  }

  // Company create rides the same contract as the existing wizard: create,
  // pin the active slug, advance. 409 with a suggested slug bounces back
  // into the field pre-filled instead of erroring out.
  const runCreateCompany = async () => {
    setCompanyError(null)
    // If we already created on a previous attempt (e.g. user backed up),
    // just advance — don't double-create.
    if (created) {
      goNext()
      return
    }
    try {
      const result = await createCompany.mutateAsync({
        slug: effectiveSlug,
        name: companyName.trim(),
        seed_defaults: true,
      })
      setActiveCompanySlug(result.company.slug)
      setCreated(true)
      goNext()
    } catch (e) {
      const suggestion = suggestedSlugFromError(e)
      if (suggestion) {
        setSlug(suggestion)
        setSlugTouched(true)
        setCompanyError(`That name was taken — we suggested “${suggestion}”. Tap create again.`)
        return
      }
      setCompanyError(e instanceof Error ? e.message : 'Failed to create company')
    }
  }

  // QBO connect → server-side OAuth start. The callback lands the user back
  // in the app; here we just hand off to Intuit.
  const connectQbo = async () => {
    setConnectError(null)
    setConnecting(true)
    try {
      const { authUrl } = await fetchQboAuthUrl()
      window.location.assign(authUrl)
    } catch (e) {
      // No live QBO creds in this tier — mark as "will connect later" so the
      // step stays skippable rather than dead-ending.
      setConnectError(e instanceof Error ? e.message : 'QuickBooks connect is unavailable right now.')
      setConnecting(false)
    }
  }

  const finish = () => {
    // TODO(wire): mark owner onboarding complete on the membership/company.
    navigate('/projects/new', { replace: true })
  }

  return (
    <div className="m-host">
      <MShell>
        {/* Titled back-arrow top bar per step (msg__01/02/03). Back on the
            first step exits the flow; later steps step back through it. */}
        <MTopBar
          back
          title={STEP_TITLES[step]}
          onBack={() => (stepIndex > 0 ? goBack() : navigate(-1))}
        />
        <MBody>
          <div style={s.frame}>
            <div>
              {/* Step rail */}
              <div style={s.rail} aria-hidden>
                {STEP_ORDER.map((_, i) => (
                  <span
                    key={i}
                    style={{
                      ...s.railSeg,
                      background: i <= stepIndex ? 'var(--m-accent)' : 'var(--m-line-2)',
                    }}
                  />
                ))}
              </div>

              {step === 'company' ? (
                <CompanyStep
                  companyName={companyName}
                  onCompanyName={(v) => {
                    setCompanyName(v)
                    if (!slugTouched) setSlug(slugify(v))
                  }}
                  slug={effectiveSlug}
                  onSlug={(v) => {
                    setSlug(v)
                    setSlugTouched(true)
                  }}
                  slugRevealed={slugTouched}
                  trade={trade}
                  onTrade={setTrade}
                  error={companyError}
                />
              ) : null}

              {step === 'crew' ? <CrewStep crewSize={crewSize} onCrewSize={setCrewSize} /> : null}

              {step === 'connect' ? <ConnectStep connected={qboConnected} error={connectError} /> : null}

              {step === 'ready' ? (
                <ReadyStep companyName={companyName} trade={trade} crewSize={crewSize} qboConnected={qboConnected} />
              ) : null}
            </div>

            <Footer
              step={step}
              canCreate={canCreate}
              creating={createCompany.isPending}
              connecting={connecting}
              qboConnected={qboConnected}
              onCreate={runCreateCompany}
              onNext={goNext}
              onConnectQbo={connectQbo}
              onSkipConnect={() => {
                setQboConnected(false)
                goNext()
              }}
              onMarkConnected={() => {
                // Dev/no-clerk fallback: let the user mark QBO as handled so
                // the Ready summary reflects intent even without a live OAuth.
                setQboConnected(true)
                goNext()
              }}
              onFinish={finish}
              onExplore={() => navigate('/', { replace: true })}
            />
          </div>
        </MBody>
      </MShell>
    </div>
  )
}

// ─── 1 · Company ─────────────────────────────────────────────────────────────
function CompanyStep({
  companyName,
  onCompanyName,
  slug,
  onSlug,
  slugRevealed,
  trade,
  onTrade,
  error,
}: {
  companyName: string
  onCompanyName: (v: string) => void
  slug: string
  onSlug: (v: string) => void
  slugRevealed: boolean
  trade: Trade | null
  onTrade: (t: Trade) => void
  error: string | null
}) {
  return (
    <>
      <Eyebrow>Step 1 / 4</Eyebrow>
      <Headline>What do we call it?</Headline>

      <FieldLabel style={{ marginTop: 22 }}>Company name</FieldLabel>
      <input
        value={companyName}
        onChange={(e) => onCompanyName(e.currentTarget.value)}
        placeholder="Davis Stucco LLC"
        aria-label="Company name"
        style={s.bigInput}
      />

      {/* Slug is derived silently from the name; it only surfaces once a
          collision (409) forces the user to disambiguate. */}
      {slugRevealed ? (
        <>
          <FieldLabel style={{ marginTop: 16 }}>URL slug</FieldLabel>
          <input
            value={slug}
            onChange={(e) => onSlug(e.currentTarget.value)}
            placeholder="davis-stucco"
            aria-label="Company slug"
            style={s.slugInput}
          />
        </>
      ) : null}

      <FieldLabel style={{ marginTop: 18 }}>Trade</FieldLabel>
      <div style={s.tradeGrid}>
        {TRADES.map((t, i) => {
          const on = trade === t
          const rightEdge = i % 3 === 2
          const bottomRow = i >= 3
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              onClick={() => onTrade(t)}
              style={{
                ...s.tradeCell,
                background: on ? 'var(--m-accent)' : 'transparent',
                color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                borderRight: rightEdge ? 'none' : '2px solid var(--m-ink)',
                borderBottom: bottomRow ? 'none' : '2px solid var(--m-ink)',
              }}
            >
              {t}
            </button>
          )
        })}
      </div>
      {error ? <div style={s.error}>{error}</div> : null}
    </>
  )
}

// ─── 2 · Crew size ───────────────────────────────────────────────────────────
function CrewStep({ crewSize, onCrewSize }: { crewSize: CrewSize | null; onCrewSize: (id: CrewSize) => void }) {
  return (
    <>
      <Eyebrow>Step 2 / 4</Eyebrow>
      <Headline>Just you, or a crew?</Headline>

      <div role="radiogroup" aria-label="Crew size" style={s.crewList}>
        {CREW_SIZES.map((o, i, arr) => {
          const on = crewSize === o.id
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onCrewSize(o.id)}
              style={{
                ...s.crewRow,
                background: on ? 'var(--m-accent)' : 'transparent',
                color: on ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
              }}
            >
              <div style={s.crewLabel}>{o.label}</div>
              <div style={s.crewSub}>{o.sub}</div>
            </button>
          )
        })}
      </div>
    </>
  )
}

// ─── 3 · Integrations ────────────────────────────────────────────────────────
/**
 * The integration roster (msg__03). Only QBO is wired (it drives the real
 * `fetchQboAuthUrl` connect); Gusto / Stripe / Xero are surfaced as
 * coming-soon rows so the step matches the design's four-row list. `ai`
 * tags the AI-mapped rows the design badges.
 */
const INTEGRATIONS: ReadonlyArray<{
  id: string
  name: string
  sub: string
  ai?: boolean
}> = [
  { id: 'qbo', name: 'QUICKBOOKS ONLINE', sub: 'BOOKS + INVOICES', ai: true },
  { id: 'gusto', name: 'GUSTO', sub: 'PAYROLL + BURDEN', ai: true },
  { id: 'stripe', name: 'STRIPE', sub: 'COLLECT PAYMENTS' },
  { id: 'xero', name: 'XERO', sub: 'ALTERNATIVE TO QBO' },
]

function ConnectStep({ connected, error }: { connected: boolean; error: string | null }) {
  return (
    <>
      <Eyebrow>Step 3 / 4 · Optional</Eyebrow>
      <Headline>Hook up your books.</Headline>
      <p style={s.lede}>We'll pull your pricing book + payroll burden automatically. You can add any of these later.</p>

      <div style={s.connectList}>
        {INTEGRATIONS.map((it, i, arr) => {
          // QBO is "selected" by default (and confirmed once connected); the
          // others are coming-soon rows shown with a + affordance.
          const selected = it.id === 'qbo'
          const on = selected && connected
          return (
            <div
              key={it.id}
              style={{
                ...s.connectRow,
                background: on ? 'var(--m-accent)' : selected ? 'var(--m-accent-soft)' : 'transparent',
                color: on ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={s.connectTitle}>{it.name}</span>
                  {it.ai ? <span style={s.aiBadge}>AI</span> : null}
                </div>
                <div style={s.connectSub}>
                  {selected && connected ? 'CONNECTED · PRICEBOOK PULLED' : it.sub}
                </div>
              </div>
              <span style={s.connectMark} aria-hidden>
                {selected ? (connected ? <MI.Check size={18} /> : '✓') : '+'}
              </span>
            </div>
          )
        })}
      </div>

      {error ? <div style={s.error}>{error}</div> : null}
    </>
  )
}

// ─── 4 · Ready ───────────────────────────────────────────────────────────────
function ReadyStep({
  companyName,
  trade,
  crewSize,
  qboConnected,
}: {
  companyName: string
  trade: Trade | null
  crewSize: CrewSize | null
  qboConnected: boolean
}) {
  const crewTier = crewTierFor(crewSize)
  const crewLabel =
    crewTier === 'multi'
      ? 'MULTI-CREW · FOREMEN + CREW'
      : crewTier === 'solo'
        ? 'SOLO · ALL HATS'
        : 'CREW SIZE · SET LATER'
  const companyLabel = `COMPANY · ${(companyName.trim() || 'YOUR SHOP').toUpperCase()}${trade ? ` · ${trade}` : ''}`
  const connectLabel = qboConnected ? 'BOOKS CONNECTED · PRICEBOOK PULLED' : 'BOOKS NOT CONNECTED · ADD ANY TIME'

  const tasks: Array<{ label: string; done?: boolean; active?: boolean }> = [
    { label: companyLabel, done: true },
    { label: crewLabel, done: crewSize != null },
    { label: connectLabel, done: qboConnected },
    { label: 'CREATE FIRST PROJECT', active: true },
  ]

  return (
    <>
      <Eyebrow>Step 4 / 4</Eyebrow>
      <Headline>You're set up.</Headline>

      <div style={s.readyList}>
        {tasks.map((t, i, arr) => (
          <div
            key={t.label}
            style={{
              ...s.readyRow,
              borderBottom: i < arr.length - 1 ? '1px solid var(--m-line-2)' : 'none',
              background: t.active ? 'var(--m-accent)' : 'transparent',
            }}
          >
            <div
              aria-hidden
              style={{
                ...s.readyMark,
                background: t.done ? 'var(--m-green)' : t.active ? 'var(--m-ink)' : 'transparent',
                color: t.done ? '#fff' : t.active ? 'var(--m-accent)' : 'var(--m-ink-3)',
              }}
            >
              {t.done ? '✓' : t.active ? '●' : ''}
            </div>
            <span
              style={{
                ...s.readyLabel,
                color: t.active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
              }}
            >
              {t.label}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

// ─── Footer (per-step actions) ───────────────────────────────────────────────
function Footer({
  step,
  canCreate,
  creating,
  connecting,
  qboConnected,
  onCreate,
  onNext,
  onConnectQbo,
  onSkipConnect,
  onMarkConnected,
  onFinish,
  onExplore,
}: {
  step: Step
  canCreate: boolean
  creating: boolean
  connecting: boolean
  qboConnected: boolean
  onCreate: () => void
  onNext: () => void
  onConnectQbo: () => void
  onSkipConnect: () => void
  onMarkConnected: () => void
  onFinish: () => void
  onExplore: () => void
}) {
  return (
    <div>
      <MButtonStack>
        {step === 'company' ? (
          <MButton variant="primary" onClick={onCreate} disabled={!canCreate || creating}>
            {creating ? 'Creating…' : 'Next · Crew size'}
          </MButton>
        ) : null}

        {step === 'crew' ? (
          <MButton variant="primary" onClick={onNext}>
            Next · Integrations
          </MButton>
        ) : null}

        {step === 'connect' ? (
          <>
            <MButton variant="primary" onClick={qboConnected ? onNext : onConnectQbo} disabled={connecting}>
              {connecting ? 'Opening QuickBooks…' : qboConnected ? 'Next · Ready' : 'Connect QBO'}
            </MButton>
            <MButton variant="ghost" onClick={onSkipConnect}>
              Skip
            </MButton>
            {/* Dev / no-OAuth fallback: record intent without a live round-trip. */}
            <MButton variant="quiet" onClick={onMarkConnected}>
              Mark connected & continue
            </MButton>
          </>
        ) : null}

        {step === 'ready' ? (
          <>
            <MButton variant="primary" onClick={onFinish}>
              Create first project
            </MButton>
            <MButton variant="ghost" onClick={onExplore}>
              Explore first
            </MButton>
          </>
        ) : null}
      </MButtonStack>
    </div>
  )
}

// ─── shared bits ─────────────────────────────────────────────────────────────
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div style={s.eyebrow}>{children}</div>
}
function Headline({ children }: { children: React.ReactNode }) {
  return <h1 style={s.headline}>{children}</h1>
}
function FieldLabel({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  return <div style={{ ...s.fieldLabel, ...style }}>{children}</div>
}

const s: Record<string, CSSProperties> = {
  frame: {
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: 28,
    padding: '32px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
  },
  rail: { display: 'flex', gap: 6, marginBottom: 24 },
  railSeg: { height: 4, flex: 1, borderRadius: 0 },
  eyebrow: {
    fontFamily: 'var(--m-num)',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--m-accent-ink)',
  },
  headline: {
    fontFamily: 'var(--m-font-display)',
    fontSize: 36,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 1.0,
    color: 'var(--m-ink)',
    margin: '12px 0 0',
  },
  lede: { fontSize: 15, lineHeight: 1.5, color: 'var(--m-ink-2)', marginTop: 14 },
  fieldLabel: {
    fontFamily: 'var(--m-num)',
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--m-ink-3)',
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
  },
  bigInput: {
    width: '100%',
    marginTop: 8,
    padding: '14px 16px',
    border: '2px solid var(--m-ink)',
    background: 'var(--m-card-soft)',
    color: 'var(--m-ink)',
    fontFamily: 'var(--m-font-display)',
    fontWeight: 700,
    fontSize: 20,
    outline: 'none',
  },
  slugInput: {
    width: '100%',
    marginTop: 8,
    padding: '12px 14px',
    border: '2px solid var(--m-ink)',
    background: 'var(--m-card-soft)',
    color: 'var(--m-ink)',
    fontFamily: 'var(--m-num)',
    fontWeight: 600,
    fontSize: 14,
    letterSpacing: '0.02em',
    outline: 'none',
  },
  tradeGrid: {
    marginTop: 8,
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 0,
    border: '2px solid var(--m-ink)',
  },
  tradeCell: {
    padding: '14px 0',
    border: 'none',
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.06em',
    cursor: 'pointer',
  },
  crewList: { marginTop: 22, display: 'flex', flexDirection: 'column', border: '2px solid var(--m-ink)' },
  crewRow: { padding: '20px 20px', textAlign: 'left', border: 'none', cursor: 'pointer' },
  crewLabel: { fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 18 },
  crewSub: { fontFamily: 'var(--m-num)', fontSize: 10, marginTop: 5, fontWeight: 600, opacity: 0.75 },
  connectList: { marginTop: 22, display: 'flex', flexDirection: 'column', border: '2px solid var(--m-ink)' },
  connectRow: { padding: '16px 16px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left' },
  connectTitle: { fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 16 },
  connectSub: { fontFamily: 'var(--m-num)', fontSize: 10, marginTop: 4, fontWeight: 600, opacity: 0.75 },
  connectMark: {
    flexShrink: 0,
    width: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--m-font-display)',
    fontWeight: 800,
    fontSize: 18,
    opacity: 0.7,
  },
  aiBadge: {
    fontFamily: 'var(--m-num)',
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: '0.06em',
    background: 'var(--m-ink)',
    color: 'var(--m-accent)',
    padding: '2px 5px',
    flexShrink: 0,
  },
  readyList: { marginTop: 22, border: '2px solid var(--m-ink)' },
  readyRow: { padding: '16px 18px', display: 'flex', alignItems: 'center', gap: 14 },
  readyMark: {
    width: 28,
    height: 28,
    flex: '0 0 auto',
    border: '2px solid var(--m-ink)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--m-font-display)',
    fontWeight: 800,
    fontSize: 13,
  },
  readyLabel: { fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 14 },
  error: {
    fontFamily: 'var(--m-num)',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--m-red)',
    marginTop: 14,
    lineHeight: 1.4,
  },
}
