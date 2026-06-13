/**
 * ESTIMATOR · FIRST RUN (`est-first-run`) — design source V2EstimatorFirstRun,
 * "ESTIMATOR · FIRST RUN" / from "After accept · priming".
 *
 * Shown immediately after an estimator accepts an invite. Two jobs:
 *   1. A 2-step orientation that names the few things an estimator does on
 *      day one — the headline being the takeoff tool, with the primary
 *      "Tool: TAP" note (tap-to-count straight off the plans).
 *   2. Permission priming — notifications (so they hear when a bid is
 *      viewed/accepted) — by chaining into the EXISTING onboarding prime
 *      route, not reimplementing it.
 *
 * Reuse: like `foreman-first-run.tsx`, rather than mounting the prime
 * screen inline we hand off to its route via the `?next=` chain it already
 * supports. Estimators don't need clock-in location, so this primes
 * notifications only (then lands on the caller's `next`, default /estimates).
 *
 * Full-screen takeover mounted in App.tsx (pre-workspace, like /welcome).
 * Estimator = office role = default light theme.
 *
 * When the invite-accept flow forwards the accepted membership id as `?mid=`,
 * the terminal action (starting the permission chain) marks first-run complete
 * via POST /api/memberships/:id/first-run-complete so this priming isn't shown
 * again on the next login. The mark is best-effort + idempotent server-side, so
 * a transient failure never blocks the handoff into the estimates surface.
 */
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MShell, MBody, MButton, MButtonStack, MI } from '@/components/m'
import { useCompleteFirstRun } from '@/lib/api'

const STEPS: ReadonlyArray<{
  eyebrow: string
  title: string
  body: string
  note: string
  icon: 'layers' | 'filetext'
}> = [
  {
    eyebrow: 'Step 1 of 2',
    title: 'Take off the plans by tapping.',
    body: 'Open a drawing and tap to count fixtures or trace a run. Sitelayer adds up the quantities as you go — no desktop, no wheel.',
    note: 'Tool: TAP',
    icon: 'layers',
  },
  {
    eyebrow: 'Step 2 of 2',
    title: 'Price it and send the bid.',
    body: 'Your pricebook turns the takeoff into an estimate. Send it from your phone and watch scope-vs-bid as the job moves.',
    note: 'Tool: PRICE',
    icon: 'filetext',
  },
]

export function EstimatorFirstRunScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next') ?? '/estimates'
  const membershipId = searchParams.get('mid')
  const completeFirstRun = useCompleteFirstRun()
  const [step, setStep] = useState(0)

  const current = STEPS[step] ?? STEPS[0]
  const isLast = step === STEPS.length - 1

  if (!current) return null

  // Estimators get notification priming only (no clock-in location). The
  // inner `next` is URL-encoded so the prime route reads the full chain.
  const startPermissions = async () => {
    // Mark first-run complete (best-effort, idempotent) so this priming isn't
    // shown again. Never block the permission handoff on the API call.
    if (membershipId) {
      try {
        await completeFirstRun.mutateAsync({ membershipId })
      } catch {
        // Swallow — the priming flow must continue regardless.
      }
    }
    navigate(`/permissions/notifications?next=${encodeURIComponent(next)}`, { replace: true })
  }

  const onPrimary = () => {
    if (isLast) void startPermissions()
    else setStep((step_) => step_ + 1)
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
                      background: i <= step ? 'var(--m-accent)' : 'var(--m-line-2)',
                    }}
                  />
                ))}
              </div>

              <div
                style={{
                  width: 56,
                  height: 56,
                  background: 'var(--m-accent-soft)',
                  color: 'var(--m-accent-ink)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 22,
                }}
              >
                {current.icon === 'layers' ? <MI.Layers size={26} /> : <MI.FileText size={26} />}
              </div>

              <div
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: 'var(--m-accent-ink)',
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

              {/* Primary tool note — the "Tool: TAP" pill the design calls out. */}
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  marginTop: 16,
                  padding: '6px 10px',
                  background: 'var(--m-accent)',
                  color: 'var(--m-accent-ink)',
                  fontFamily: 'var(--m-num)',
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  border: '2px solid var(--m-ink)',
                }}
              >
                {current.note}
              </div>

              <p style={{ fontSize: 15, lineHeight: 1.5, color: 'var(--m-ink-2)', marginTop: 14, maxWidth: '34ch' }}>
                {current.body}
              </p>
            </div>

            <div>
              <MButtonStack>
                <MButton variant="primary" onClick={onPrimary}>
                  {isLast ? 'Turn on bid alerts' : 'Next'}
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
