/**
 * FOREMAN · ACCEPT (`fm-invite`) — design source V2ForemanInvite,
 * "FOREMAN · ACCEPT" / from "SMS/email tap · invited".
 *
 * An owner invites a foreman to run crews + jobs for their company. The
 * foreman taps the SMS/email link and lands here. Light theme (foreman
 * persona), one clear framing of what foreman access means, a primary
 * accept, and a quiet decline. On accept we route into first-run
 * permission priming, then Today.
 *
 * Full-screen takeover mounted in App.tsx (pre-workspace, like /welcome)
 * so it is NOT inside MobileShell — it wraps itself in MShell. Foreman is
 * the default light theme, so no `.m-dark`.
 *
 * Presentational only.
 * TODO(wire): invite/accept API (GET invite by token, POST accept).
 */
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MShell, MBody, MTopBar, MButton, MButtonStack, MI } from '@/components/m'

const CAPABILITIES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: 'Run the crew', detail: 'Schedule, dispatch, and approve hours' },
  { title: 'Own the field', detail: 'Daily logs, blockers, change orders' },
  { title: 'Move work forward', detail: 'Push estimates and close out jobs' },
]

export function ForemanInviteScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [busy, setBusy] = useState(false)

  // TODO(wire): resolve from the invite token instead of query/defaults.
  const company = searchParams.get('company') ?? 'LA Operations'
  const owner = searchParams.get('from') ?? 'Steve Lozano'

  const onAccept = () => {
    setBusy(true)
    // TODO(wire): POST accept, then persist the foreman membership.
    navigate('/foreman/first-run?next=/today', { replace: true })
  }

  const onDecline = () => {
    // TODO(wire): POST decline.
    navigate('/sign-in', { replace: true })
  }

  return (
    <div className="m-host">
      <MShell>
        <MTopBar eyebrow="Invitation" title="You're invited" sub={`From ${owner}`} />
        <MBody>
          <div style={{ padding: '20px 20px 0' }}>
            <h1
              style={{
                fontFamily: 'var(--m-font-display)',
                fontSize: 32,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                lineHeight: 1.02,
                color: 'var(--m-ink)',
                margin: 0,
              }}
            >
              Run {company} jobs as foreman.
            </h1>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--m-ink-2)', marginTop: 12 }}>
              <strong style={{ color: 'var(--m-accent-ink)' }}>{owner}</strong> wants you to run the field side of{' '}
              {company} on Sitelayer. Accepting gives you foreman access:
            </p>

            <ul style={{ listStyle: 'none', margin: '20px 0 0', padding: 0, display: 'grid', gap: 8 }}>
              {CAPABILITIES.map((c) => (
                <li
                  key={c.title}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '12px 14px',
                    background: 'var(--m-card)',
                    border: '1px solid var(--m-line)',
                    borderRadius: 12,
                  }}
                >
                  <span
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      flexShrink: 0,
                      background: 'var(--m-accent-soft)',
                      color: 'var(--m-accent-ink)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <MI.Check size={18} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--m-ink)' }}>{c.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--m-ink-3)', marginTop: 1 }}>{c.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div style={{ padding: '24px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
            <MButtonStack>
              <MButton variant="primary" onClick={onAccept} disabled={busy}>
                {busy ? 'Setting up…' : `Accept foreman role`}
              </MButton>
              <MButton variant="ghost" onClick={onDecline} disabled={busy}>
                Decline invitation
              </MButton>
            </MButtonStack>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: '0.04em',
                textAlign: 'center',
                color: 'var(--m-ink-4)',
                marginTop: 12,
                lineHeight: 1.4,
              }}
            >
              You can be removed by an owner at any time.
            </div>
          </div>
        </MBody>
      </MShell>
    </div>
  )
}
