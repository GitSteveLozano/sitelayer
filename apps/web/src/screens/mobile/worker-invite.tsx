/**
 * WORKER · ACCEPT · DARK (`wk-invite`) — design source V2WorkerInvite,
 * "WORKER · ACCEPT · DARK" / from "SMS tap · phone-first".
 *
 * A worker taps an SMS invite link and lands here cold — they may have
 * never heard of Sitelayer. Phone-first, dark-theme, big-glove targets:
 * a single "You're invited to {company}" framing, the foreman who sent it,
 * a giant ACCEPT button, and a quiet decline. On accept we route into the
 * first-run permission priming flow so the worker is set up for auto
 * clock-in before they ever reach Today.
 *
 * This is a full-screen takeover mounted in App.tsx (pre-workspace, like
 * /welcome), so it is NOT inside the worker MobileShell — it applies its
 * own `.m-dark` wrapper. All colors come from `var(--m-*)` tokens; no
 * hardcoded dark values.
 *
 * Presentational only — no invite API. The token in the URL would be
 * resolved to company/foreman/role by the integrator.
 * TODO(wire): invite/accept API (GET invite by token, POST accept).
 */
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MShell, MBody, MButton, MButtonStack } from '@/components/m'

export function WorkerInviteScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [busy, setBusy] = useState(false)

  // TODO(wire): resolve these from the invite token instead of query/defaults.
  const company = searchParams.get('company') ?? 'LA Operations'
  const foreman = searchParams.get('from') ?? 'Ana Castillo'
  const role = searchParams.get('role') ?? 'Crew'

  const onAccept = () => {
    setBusy(true)
    // TODO(wire): POST accept, then persist the membership.
    // Chain into the dark worker-specific first-run (not the foreman light
    // carousel), which primes permissions → Today.
    navigate('/worker/first-run?next=/today', { replace: true })
  }

  const onDecline = () => {
    // TODO(wire): POST decline. For now just bounce to sign-in.
    navigate('/sign-in', { replace: true })
  }

  return (
    <div className="m-host">
      <MShell className="m-dark">
        <MBody>
          <div style={ms.frame}>
            <div>
              <div style={ms.eyebrow}>You're invited</div>
              <div style={ms.headline}>
                Join
                <br />
                {company}.
              </div>
              <p style={ms.lede}>
                <strong style={{ color: 'var(--m-accent-ink)' }}>{foreman}</strong> added you to the {company} crew on
                Sitelayer — where you clock in, see your scope, and log your hours.
              </p>

              <div style={ms.card}>
                <div style={ms.cardEyebrow}>Your role</div>
                <div style={ms.cardValue}>{role}</div>
                <div style={ms.cardSub}>Invited by {foreman}</div>
              </div>
            </div>

            <div>
              <MButtonStack>
                <MButton variant="primary" data-size="worker" onClick={onAccept} disabled={busy}>
                  {busy ? 'Setting up…' : 'Accept & join'}
                </MButton>
                <MButton variant="ghost" onClick={onDecline} disabled={busy}>
                  Not me · decline
                </MButton>
              </MButtonStack>
              <div style={ms.micro}>By joining you agree to share your clock-in location with {company}.</div>
            </div>
          </div>
        </MBody>
      </MShell>
    </div>
  )
}

const ms: Record<string, CSSProperties> = {
  frame: {
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    gap: 28,
    padding: '40px 20px calc(env(safe-area-inset-bottom, 0px) + 24px)',
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
    fontSize: 56,
    fontWeight: 800,
    letterSpacing: '-0.025em',
    lineHeight: 0.92,
    marginTop: 14,
    color: 'var(--m-ink)',
  },
  lede: {
    fontSize: 15,
    lineHeight: 1.5,
    color: 'var(--m-ink-2)',
    marginTop: 18,
  },
  card: {
    marginTop: 24,
    border: '2px solid var(--m-line)',
    background: 'var(--m-card-soft)',
    padding: '16px 16px 18px',
  },
  cardEyebrow: {
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--m-ink-3)',
  },
  cardValue: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--m-ink)',
    marginTop: 6,
  },
  cardSub: {
    fontSize: 13,
    color: 'var(--m-ink-3)',
    marginTop: 4,
  },
  micro: {
    fontFamily: 'var(--m-num)',
    fontSize: 11,
    fontWeight: 500,
    letterSpacing: '0.04em',
    textAlign: 'center',
    color: 'var(--m-ink-4)',
    marginTop: 12,
    lineHeight: 1.4,
  },
}
