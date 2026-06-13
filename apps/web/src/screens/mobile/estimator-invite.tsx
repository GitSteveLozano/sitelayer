/**
 * ESTIMATOR · ACCEPT (`est-invite`) — design source V2EstimatorInvite,
 * "ESTIMATOR · ACCEPT" / from "email tap · invited".
 *
 * An owner invites an estimator to price jobs + run takeoffs for their
 * company. The estimator taps the email link and lands here. Light theme
 * (office persona, same as foreman), one clear framing of what estimator
 * access means, a primary accept, and a quiet decline. On accept we route
 * into the estimator first-run priming, then the estimates surface.
 *
 * Mirrors `foreman-invite.tsx` / `worker-invite.tsx`. Estimators are an
 * office role (light theme), so no `.m-dark`.
 *
 * Full-screen takeover mounted in App.tsx (pre-workspace, like /welcome)
 * so it is NOT inside MobileShell — it wraps itself in MShell.
 *
 * The `?token=` query param (from the email tap link) resolves to
 * company/owner/role via GET /api/invites/:token; accept binds the estimator
 * membership via POST /api/invites/:token/accept and chains into first-run with
 * the membership id. With no token (the standalone design/demo route) it falls
 * back to the query-param copy.
 */
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MShell, MBody, MTopBar, MButton, MButtonStack, MBanner, MI } from '@/components/m'
import { useAcceptInvite, useInviteView } from '@/lib/api'
import { setActiveCompanySlug } from '@/lib/api/client'

const CAPABILITIES: ReadonlyArray<{ title: string; detail: string }> = [
  { title: 'Run the takeoff', detail: 'Tap-to-count + measure straight off the plans' },
  { title: 'Price the job', detail: 'Build estimates from your pricebook' },
  { title: 'Send + win bids', detail: 'Push proposals and track scope-vs-bid' },
]

export function EstimatorInviteScreen() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const token = searchParams.get('token')
  const view = useInviteView(token)
  const accept = useAcceptInvite(token ?? '')

  const invite = view.data?.invite
  const company = invite?.company_name ?? searchParams.get('company') ?? 'their company'
  const ownerParam = searchParams.get('from')
  const owner = ownerParam ?? 'The owner'

  const onAccept = async () => {
    setBusy(true)
    setError(null)
    let next = '/estimator/first-run?next=/estimates'
    try {
      if (token) {
        const result = await accept.mutateAsync()
        setActiveCompanySlug(result.company.slug)
        next = `/estimator/first-run?next=/estimates&mid=${encodeURIComponent(result.membership.id)}`
      }
      navigate(next, { replace: true })
    } catch (err) {
      setBusy(false)
      setError(err instanceof Error ? err.message : 'Could not accept the invitation. Please try again.')
    }
  }

  const onDecline = () => {
    navigate('/sign-in', { replace: true })
  }

  return (
    <div className="m-host">
      <MShell>
        <MTopBar
          eyebrow="Invitation"
          title="You're invited"
          sub={ownerParam ? `From ${ownerParam}` : 'Company invitation'}
        />
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
              Price {company} jobs as estimator.
            </h1>
            <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--m-ink-2)', marginTop: 12 }}>
              <strong style={{ color: 'var(--m-accent-ink)' }}>{owner}</strong> wants you to run takeoffs and pricing
              for {company} on Sitelayer. Accepting gives you estimator access:
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
                    border: '2px solid var(--m-ink)',
                  }}
                >
                  <span
                    style={{
                      width: 36,
                      height: 36,
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
            {error ? (
              <div style={{ marginBottom: 14 }}>
                <MBanner tone="error" title="Could not accept" body={error} />
              </div>
            ) : null}
            <MButtonStack>
              <MButton variant="primary" onClick={onAccept} disabled={busy}>
                {busy ? 'Setting up…' : `Accept estimator role`}
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
