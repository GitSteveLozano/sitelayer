/**
 * FOREMAN · FIRST RUN (`fm-first-run`) — design source V2ForemanFirstRun,
 * "FOREMAN · FIRST RUN" / from "After accept · permissions".
 *
 * Shown immediately after a foreman (or worker) accepts an invite. Two
 * jobs:
 *   1. A 2-step orientation that names the few things a foreman does on
 *      day one (run the crew, log the field).
 *   2. Permission priming — location + notifications — by chaining into
 *      the EXISTING onboarding prime routes, not reimplementing them.
 *
 * Reuse: rather than mounting <LocationPrimeScreen>/<NotificationsPrimeScreen>
 * inline (they each own a full-screen layout + their own `?next=` routing),
 * we hand off to their routes in sequence via the `?next=` chain they
 * already support:
 *
 *   /permissions/location?next=<encoded /permissions/notifications?next=<encoded final>>
 *
 * So the two primes run back-to-back and land on the caller's `next`
 * (default /today). This keeps the OS-prompt framing those screens already
 * got right and avoids editing them.
 *
 * Full-screen takeover mounted in App.tsx (pre-workspace, like /welcome).
 * Foreman = default light theme.
 *
 * Presentational only (orientation copy + permission handoff).
 * TODO(wire): mark first-run complete on the membership so we don't show
 * this again.
 */
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MShell, MBody, MButton, MButtonStack, MI } from '@/components/m'

const STEPS: ReadonlyArray<{
  eyebrow: string
  title: string
  body: string
  icon: 'users' | 'filetext'
}> = [
  {
    eyebrow: 'Step 1 of 2',
    title: 'Run the crew from your phone.',
    body: "See who's on, dispatch the day, and approve hours without leaving the site. Everything your crew taps shows up here.",
    icon: 'users',
  },
  {
    eyebrow: 'Step 2 of 2',
    title: 'The field writes itself.',
    body: 'Daily logs, blockers, and change orders are a tap each. Sitelayer turns them into the paper the office needs.',
    icon: 'filetext',
  },
]

export function ForemanFirstRunScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next') ?? '/today'
  const [step, setStep] = useState(0)

  const current = STEPS[step] ?? STEPS[0]
  const isLast = step === STEPS.length - 1

  if (!current) return null

  // Chain the two existing prime routes, ending on `next`. Inner `next`
  // values must be URL-encoded so each route's searchParams.get('next')
  // reads the whole remaining chain verbatim.
  const startPermissions = () => {
    const notif = `/permissions/notifications?next=${encodeURIComponent(next)}`
    const location = `/permissions/location?next=${encodeURIComponent(notif)}`
    navigate(location, { replace: true })
  }

  const onPrimary = () => {
    if (isLast) startPermissions()
    else setStep((s) => s + 1)
  }

  return (
    <div className="m-host">
      <MShell>
        <MBody>
          <div
            style={{
              minHeight: '100%',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              padding: '40px 24px calc(env(safe-area-inset-bottom, 0px) + 24px)',
            }}
          >
            <div>
              {/* Step dots */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 28 }} aria-hidden>
                {STEPS.map((_, i) => (
                  <span
                    key={i}
                    style={{
                      height: 4,
                      flex: 1,
                      borderRadius: 2,
                      background: i <= step ? 'var(--m-accent)' : 'var(--m-line)',
                    }}
                  />
                ))}
              </div>

              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 14,
                  background: 'var(--m-accent-soft)',
                  color: 'var(--m-accent-ink)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 22,
                }}
              >
                {current.icon === 'users' ? <MI.Users size={26} /> : <MI.FileText size={26} />}
              </div>

              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--m-accent)',
                }}
              >
                {current.eyebrow}
              </div>
              <h1
                style={{
                  fontFamily: 'var(--m-font-display)',
                  fontSize: 34,
                  fontWeight: 800,
                  letterSpacing: '-0.02em',
                  lineHeight: 1.02,
                  color: 'var(--m-ink)',
                  margin: '12px 0 0',
                }}
              >
                {current.title}
              </h1>
              <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--m-ink-2)', marginTop: 14, maxWidth: '34ch' }}>
                {current.body}
              </p>
            </div>

            <div>
              <MButtonStack>
                <MButton variant="primary" onClick={onPrimary}>
                  {isLast ? 'Set up notifications & location' : 'Next'}
                </MButton>
                <MButton variant="ghost" onClick={startPermissions}>
                  Skip the tour
                </MButton>
              </MButtonStack>
            </div>
          </div>
        </MBody>
      </MShell>
    </div>
  )
}
