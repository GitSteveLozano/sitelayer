/**
 * WORKER · FIRST RUN · DARK (`wk-first-run`) — design source V2WorkerFirstRun,
 * "WORKER · FIRST RUN · DARK" / from "After accept · permissions".
 *
 * Shown immediately after a worker accepts an invite (`worker-invite.tsx`).
 * Splits the worker orientation OUT of the shared foreman light-theme
 * carousel (`foreman-first-run.tsx`) into a worker-specific, dark-themed,
 * big-glove 1–2 step priming the design wants. Two jobs:
 *   1. A 2-step orientation naming the only two things a worker does on day
 *      one (clock in, log the day) — phone-first, dark theme.
 *   2. Permission priming — location + notifications — by chaining into the
 *      EXISTING onboarding prime routes, not reimplementing them. Workers
 *      need clock-in location, so both primes run.
 *
 * Reuse: like `foreman-first-run.tsx`, we hand off to the prime routes via
 * the `?next=` chain they already support:
 *   /permissions/location?next=<encoded /permissions/notifications?next=<encoded final>>
 *
 * Full-screen takeover mounted in App.tsx (pre-workspace, like /welcome).
 * Worker = dark theme, so it applies its own `.m-dark` wrapper. All colors
 * come from `var(--m-*)` tokens; no hardcoded dark values.
 *
 * When the invite-accept flow forwards the accepted membership id as `?mid=`,
 * the terminal action (starting the permission chain) marks first-run complete
 * via POST /api/memberships/:id/first-run-complete so this priming isn't shown
 * again on the next login. The mark is best-effort + idempotent server-side, so
 * a transient failure never blocks the handoff into the workspace.
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MShell, MBody, MButton, MButtonStack, MI } from '@/components/m'
import { useCompleteFirstRun } from '@/lib/api'

const STEPS: ReadonlyArray<{
  eyebrow: string
  title: string
  body: string
  icon: 'clock' | 'mic'
}> = [
  {
    eyebrow: 'Step 1 of 2',
    title: 'Clock in when you get to site.',
    body: 'Open Sitelayer, tap the big yellow button, and your hours start. We use your location once to confirm you’re on the job — that’s it.',
    icon: 'clock',
  },
  {
    eyebrow: 'Step 2 of 2',
    title: 'Log the day with your thumb.',
    body: 'See your scope, snap a photo, or hold to talk. No paperwork — your foreman gets it straight from your phone.',
    icon: 'mic',
  },
]

export function WorkerFirstRunScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next') ?? '/today'
  const membershipId = searchParams.get('mid')
  const completeFirstRun = useCompleteFirstRun()
  const [step, setStep] = useState(0)

  const current = STEPS[step] ?? STEPS[0]
  const isLast = step === STEPS.length - 1

  if (!current) return null

  // Chain the two existing prime routes, ending on `next`. Inner `next`
  // values are URL-encoded so each route reads the whole remaining chain.
  const startPermissions = async () => {
    // Mark first-run complete (best-effort, idempotent) so this priming isn't
    // shown again. Never block the permission handoff on the API call.
    if (membershipId) {
      try {
        await completeFirstRun.mutateAsync({ membershipId })
      } catch {
        // Swallow — the priming flow must continue regardless. A re-login that
        // re-resolves the membership without the flag will just re-prime once.
      }
    }
    const notif = `/permissions/notifications?next=${encodeURIComponent(next)}`
    const location = `/permissions/location?next=${encodeURIComponent(notif)}`
    navigate(location, { replace: true })
  }

  const onPrimary = () => {
    if (isLast) void startPermissions()
    else setStep((step_) => step_ + 1)
  }

  return (
    <div className="m-host">
      <MShell className="m-dark">
        <MBody>
          <div style={ws.frame}>
            <div>
              {/* Step dots */}
              <div style={ws.dots} aria-hidden>
                {STEPS.map((_, i) => (
                  <span
                    key={i}
                    style={{
                      ...ws.dot,
                      background: i <= step ? 'var(--m-accent)' : 'var(--m-line-2)',
                    }}
                  />
                ))}
              </div>

              <div style={ws.iconBox}>{current.icon === 'clock' ? <MI.Clock size={30} /> : <MI.Mic size={30} />}</div>

              <div style={ws.eyebrow}>{current.eyebrow}</div>
              <h1 style={ws.headline}>{current.title}</h1>
              <p style={ws.body}>{current.body}</p>
            </div>

            <div>
              <MButtonStack>
                <MButton variant="primary" data-size="worker" onClick={onPrimary}>
                  {isLast ? 'Set up location & alerts' : 'Next'}
                </MButton>
                <MButton variant="ghost" onClick={() => void startPermissions()}>
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

const ws: Record<string, CSSProperties> = {
  frame: {
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    padding: '40px 24px calc(env(safe-area-inset-bottom, 0px) + 24px)',
  },
  dots: { display: 'flex', gap: 6, marginBottom: 32 },
  dot: { height: 4, flex: 1, borderRadius: 0 },
  iconBox: {
    width: 64,
    height: 64,
    background: 'var(--m-accent)',
    color: 'var(--m-accent-ink)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
    border: '2px solid var(--m-ink)',
  },
  eyebrow: {
    fontFamily: 'var(--m-num)',
    fontSize: 12,
    fontWeight: 600,
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    color: 'var(--m-accent)',
  },
  headline: {
    fontFamily: 'var(--m-font-display)',
    fontSize: 40,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 0.98,
    color: 'var(--m-ink)',
    margin: '14px 0 0',
  },
  body: {
    fontSize: 16,
    lineHeight: 1.5,
    color: 'var(--m-ink-2)',
    marginTop: 16,
    maxWidth: '32ch',
  },
}
