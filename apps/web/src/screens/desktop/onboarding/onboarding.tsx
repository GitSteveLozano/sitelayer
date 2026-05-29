/**
 * Desktop onboarding wizard (Desktop v2 · Onboarding). A real, interactive
 * multi-step flow ported from Steve's mockup (`DOnbSignIn` / `DOnbCompany` /
 * `DOnbTeam` / `DOnbConnect` / `DOnbReady`). The mockup rendered each step as a
 * static frame; here they're driven by `useState` step state with real
 * selection state for trade, crew size, and integrations.
 *
 * Flow: sign-in → company → team → connect → ready. Next/Back advance/retreat
 * real state. The final "CREATE FIRST PROJECT" calls the `onComplete` prop —
 * the host (routing) decides where to navigate. See onboarding-shell.tsx for
 * the centered-card layout and owner-dashboard.tsx for the --m-* token style.
 */
import { useState } from 'react'
import { OnboardingShell } from './onboarding-shell.js'

type Step = 'sign-in' | 'company' | 'team' | 'connect' | 'ready'

/** Selectable trade for the 3-col company grid. */
const TRADES = ['STUCCO', 'DRYWALL', 'PAINT', 'FRAMING', 'GENERAL', 'OTHER'] as const
type Trade = (typeof TRADES)[number]

/** Crew-size options for the stacked radio list. */
const CREW_SIZES = [
  { id: 'solo', label: 'JUST ME · SOLO', sub: 'YOU WEAR ALL HATS · SWITCH ANY TIME' },
  { id: 'small', label: '2–5 PEOPLE', sub: 'INVITE FOREMEN + CREW NEXT' },
  { id: 'mid', label: '6–15 PEOPLE', sub: 'MULTI-CREW · MULTI-SITE' },
  { id: 'large', label: '15+ PEOPLE', sub: 'ROLES + PERMISSIONS RULES' },
] as const
type CrewSize = (typeof CREW_SIZES)[number]['id']

/** Optional integrations for the connect step. */
const INTEGRATIONS = [
  { id: 'qbo', label: 'QUICKBOOKS ONLINE', sub: 'BOOKS + INVOICES', tag: 'AI' },
  { id: 'gusto', label: 'GUSTO', sub: 'PAYROLL + BURDEN', tag: 'AI' },
  { id: 'stripe', label: 'STRIPE', sub: 'COLLECT PAYMENTS', tag: null },
] as const
type IntegrationId = (typeof INTEGRATIONS)[number]['id']

export interface DesktopOnboardingProps {
  /** Called when the wizard finishes (final "CREATE FIRST PROJECT"). */
  onComplete?: () => void
}

export function DesktopOnboarding({ onComplete }: DesktopOnboardingProps) {
  const [step, setStep] = useState<Step>('sign-in')

  // Company step state.
  const [companyName, setCompanyName] = useState('')
  const [trade, setTrade] = useState<Trade | null>(null)

  // Team step state.
  const [crewSize, setCrewSize] = useState<CrewSize | null>(null)

  // Connect step state — set of selected optional integrations.
  const [connected, setConnected] = useState<Set<IntegrationId>>(new Set())

  const toggleIntegration = (id: IntegrationId) => {
    setConnected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (step === 'sign-in') {
    return <SignInStep onContinue={() => setStep('company')} />
  }

  if (step === 'company') {
    return (
      <OnboardingShell
        step={1}
        total={4}
        eyebrow="STEP 1 · WORKSPACE"
        title="Set up your shop."
        primaryLabel="NEXT · TEAM"
        secondaryLabel="BACK"
        onPrimary={() => setStep('team')}
        onSecondary={() => setStep('sign-in')}
      >
        <CompanyStep
          companyName={companyName}
          onCompanyNameChange={setCompanyName}
          trade={trade}
          onTradeChange={setTrade}
        />
      </OnboardingShell>
    )
  }

  if (step === 'team') {
    return (
      <OnboardingShell
        step={2}
        total={4}
        eyebrow="STEP 2 · TEAM"
        title="Just you, or a crew?"
        primaryLabel="NEXT · CONNECT"
        secondaryLabel="BACK"
        onPrimary={() => setStep('connect')}
        onSecondary={() => setStep('company')}
      >
        <TeamStep crewSize={crewSize} onCrewSizeChange={setCrewSize} />
      </OnboardingShell>
    )
  }

  if (step === 'connect') {
    return (
      <OnboardingShell
        step={3}
        total={4}
        eyebrow="STEP 3 · CONNECT · OPTIONAL"
        title="Hook up your books."
        primaryLabel={connected.size > 0 ? 'NEXT · READY' : 'CONNECT QBO'}
        secondaryLabel="SKIP"
        onPrimary={() => {
          // CONNECT QBO is a no-op stub when nothing is selected: select QBO
          // and advance. With selections, it's a plain "next".
          if (connected.size === 0) toggleIntegration('qbo')
          setStep('ready')
        }}
        onSecondary={() => setStep('ready')}
      >
        <ConnectStep connected={connected} onToggle={toggleIntegration} />
      </OnboardingShell>
    )
  }

  // ready
  return (
    <OnboardingShell
      step={4}
      total={4}
      eyebrow="STEP 4 · READY"
      title="You're set up."
      primaryLabel="CREATE FIRST PROJECT"
      secondaryLabel="EXPLORE FIRST"
      onPrimary={() => onComplete?.()}
      onSecondary={() => onComplete?.()}
    >
      <ReadyStep companyName={companyName} trade={trade} crewSize={crewSize} connected={connected} />
    </OnboardingShell>
  )
}

// ─── 1 · Sign in ─────────────────────────────────────────────────────────────
function SignInStep({ onContinue }: { onContinue: () => void }) {
  return (
    <OnboardingShell
      eyebrow="WELCOME"
      title={
        <>
          Run the day
          <br />
          from your desk.
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <AuthButton onClick={onContinue} variant="ink">
          CONTINUE WITH GOOGLE
        </AuthButton>
        <AuthButton onClick={onContinue} variant="ghost">
          CONTINUE WITH APPLE
        </AuthButton>
        <div style={{ display: 'flex', gap: 10 }}>
          <AuthButton onClick={onContinue} variant="ghost" small>
            EMAIL
          </AuthButton>
          <AuthButton onClick={onContinue} variant="ghost" small>
            SSO
          </AuthButton>
        </div>
      </div>
      <div
        style={{ fontFamily: 'var(--m-num)', fontSize: 11, color: 'var(--m-ink-3)', marginTop: 24, fontWeight: 600 }}
      >
        NEW HERE?{' '}
        <button
          type="button"
          onClick={onContinue}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            color: 'var(--m-ink)',
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          CREATE A COMPANY →
        </button>
      </div>
    </OnboardingShell>
  )
}

function AuthButton({
  children,
  onClick,
  variant,
  small,
}: {
  children: React.ReactNode
  onClick: () => void
  variant: 'ink' | 'ghost'
  small?: boolean
}) {
  const isInk = variant === 'ink'
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: small ? 1 : undefined,
        height: small ? 48 : 52,
        fontSize: small ? 14 : 16,
        fontFamily: 'var(--m-font-display)',
        fontWeight: 700,
        letterSpacing: '0.02em',
        background: isInk ? 'var(--m-ink)' : 'transparent',
        color: isInk ? 'var(--m-bg)' : 'var(--m-ink)',
        border: '2px solid var(--m-ink)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

// ─── 2 · Company ─────────────────────────────────────────────────────────────
function CompanyStep({
  companyName,
  onCompanyNameChange,
  trade,
  onTradeChange,
}: {
  companyName: string
  onCompanyNameChange: (v: string) => void
  trade: Trade | null
  onTradeChange: (t: Trade) => void
}) {
  return (
    <>
      <FieldLabel>COMPANY NAME</FieldLabel>
      <input
        value={companyName}
        onChange={(e) => onCompanyNameChange(e.currentTarget.value)}
        placeholder="Davis Stucco LLC"
        aria-label="Company name"
        style={{
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
        }}
      />

      <FieldLabel style={{ marginTop: 18 }}>TRADE</FieldLabel>
      <div
        style={{
          marginTop: 8,
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 0,
          border: '2px solid var(--m-ink)',
        }}
      >
        {TRADES.map((t, i) => {
          const on = trade === t
          const rightEdge = i % 3 === 2
          const bottomRow = i >= 3
          return (
            <button
              key={t}
              type="button"
              aria-pressed={on}
              onClick={() => onTradeChange(t)}
              style={{
                padding: '14px 0',
                background: on ? 'var(--m-accent)' : 'transparent',
                color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                border: 'none',
                borderRight: rightEdge ? 'none' : '2px solid var(--m-ink)',
                borderBottom: bottomRow ? 'none' : '2px solid var(--m-ink)',
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.06em',
                cursor: 'pointer',
              }}
            >
              {t}
            </button>
          )
        })}
      </div>
    </>
  )
}

// ─── 3 · Team / crew size ────────────────────────────────────────────────────
function TeamStep({
  crewSize,
  onCrewSizeChange,
}: {
  crewSize: CrewSize | null
  onCrewSizeChange: (id: CrewSize) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Crew size"
      style={{ display: 'flex', flexDirection: 'column', border: '2px solid var(--m-ink)' }}
    >
      {CREW_SIZES.map((o, i, arr) => {
        const on = crewSize === o.id
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onCrewSizeChange(o.id)}
            style={{
              padding: '18px 20px',
              textAlign: 'left',
              background: on ? 'var(--m-accent)' : 'transparent',
              color: on ? 'var(--m-accent-ink)' : 'var(--m-ink)',
              border: 'none',
              borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
              cursor: 'pointer',
            }}
          >
            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 17 }}>{o.label}</div>
            <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, marginTop: 5, fontWeight: 600, opacity: 0.75 }}>
              {o.sub}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ─── 4 · Integrations ────────────────────────────────────────────────────────
function ConnectStep({
  connected,
  onToggle,
}: {
  connected: Set<IntegrationId>
  onToggle: (id: IntegrationId) => void
}) {
  return (
    <>
      <div
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 12,
          color: 'var(--m-ink-3)',
          fontWeight: 600,
          lineHeight: 1.5,
          marginBottom: 16,
        }}
      >
        WE PULL YOUR PRICEBOOK + PAYROLL BURDEN AUTOMATICALLY.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', border: '2px solid var(--m-ink)' }}>
        {INTEGRATIONS.map((o, i, arr) => {
          const on = connected.has(o.id)
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(o.id)}
              style={{
                padding: '16px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                textAlign: 'left',
                background: on ? 'var(--m-accent)' : 'transparent',
                color: on ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                border: 'none',
                borderBottom: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                cursor: 'pointer',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 16 }}>{o.label}</span>
                  {o.tag ? (
                    <span
                      style={{
                        padding: '2px 6px',
                        background: 'var(--m-ink)',
                        color: 'var(--m-accent)',
                        fontFamily: 'var(--m-num)',
                        fontSize: 9,
                        fontWeight: 700,
                      }}
                    >
                      {o.tag}
                    </span>
                  ) : null}
                </div>
                <div style={{ fontFamily: 'var(--m-num)', fontSize: 10, marginTop: 4, fontWeight: 600, opacity: 0.7 }}>
                  {o.sub}
                </div>
              </div>
              <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700 }}>{on ? '✓' : '+'}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

// ─── 5 · Ready ───────────────────────────────────────────────────────────────
function ReadyStep({
  companyName,
  trade,
  crewSize,
  connected,
}: {
  companyName: string
  trade: Trade | null
  crewSize: CrewSize | null
  connected: Set<IntegrationId>
}) {
  const crewLabel = CREW_SIZES.find((c) => c.id === crewSize)?.label ?? 'SOLO · ALL HATS'
  const companyLabel = `COMPANY · ${(companyName.trim() || 'DAVIS STUCCO LLC').toUpperCase()}${
    trade ? ` · ${trade}` : ''
  }`
  const connectLabel =
    connected.size > 0 ? `${connected.size} CONNECTED · PRICEBOOK PULLED` : 'BOOKS NOT CONNECTED · ADD ANY TIME'

  const tasks: Array<{ label: string; done?: boolean; active?: boolean }> = [
    { label: companyLabel, done: true },
    { label: crewLabel, done: true },
    { label: connectLabel, done: connected.size > 0 },
    { label: 'CREATE FIRST PROJECT', active: true },
  ]

  return (
    <div style={{ border: '2px solid var(--m-ink)' }}>
      {tasks.map((t, i, arr) => (
        <div
          key={t.label}
          style={{
            padding: '16px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            borderBottom: i < arr.length - 1 ? '1px solid var(--m-line-2)' : 'none',
            background: t.active ? 'var(--m-accent)' : 'transparent',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 28,
              height: 28,
              flex: '0 0 auto',
              background: t.done ? 'var(--m-green)' : t.active ? 'var(--m-ink)' : 'transparent',
              color: t.done ? '#fff' : t.active ? 'var(--m-accent)' : 'var(--m-ink-3)',
              border: '2px solid var(--m-ink)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 13,
            }}
          >
            {t.done ? '✓' : t.active ? '●' : ''}
          </div>
          <span
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 700,
              fontSize: 14,
              color: t.active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
            }}
          >
            {t.label}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── shared bits ─────────────────────────────────────────────────────────────
function FieldLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        fontFamily: 'var(--m-num)',
        fontSize: 10,
        fontWeight: 700,
        color: 'var(--m-ink-3)',
        letterSpacing: '0.06em',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
