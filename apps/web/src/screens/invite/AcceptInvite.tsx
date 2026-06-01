/**
 * PUBLIC · ACCEPT INVITE — the page an invitee lands on from the email link
 * `${APP_PUBLIC_BASE_URL}/invite/accept/:token`. Mounted ABOVE the Clerk-gated
 * app shell in App.tsx so a signed-out visitor can render the invite summary
 * and drive sign-in.
 *
 * Flow:
 *   1. GET /api/invites/:token (no auth) → render company/role/email + status.
 *   2. Accept needs a signed-in identity:
 *      - Clerk configured (prod): signed-out users see <SignIn> with a
 *        redirect back here; signed-in users get the Accept CTA.
 *      - Dev (RoleSwitcher, Clerk not configured): the act-as header travels
 *        automatically via client.ts:request(), so the Accept CTA works.
 *   3. POST /api/invites/:token/accept → bind membership, switch active company
 *      to the returned slug, navigate into the workspace.
 */
import { useNavigate, useParams } from 'react-router-dom'
import { SignedIn, SignedOut, SignIn } from '@clerk/clerk-react'
import { MShell, MBody, MTopBar, MButton, MButtonStack, MBanner, MI } from '@/components/m'
import { isClerkConfigured } from '@/lib/auth'
import { useAcceptInvite, useInviteView } from '@/lib/api'
import { setActiveCompanySlug } from '@/lib/api/client'

const STATUS_BANNER: Record<string, { tone: 'warn' | 'error'; title: string; body: string }> = {
  accepted: { tone: 'warn', title: 'Already accepted', body: 'This invitation has already been used.' },
  revoked: { tone: 'error', title: 'Invitation revoked', body: 'This invitation is no longer valid.' },
  expired: { tone: 'error', title: 'Invitation expired', body: 'Ask your admin to send a new invite.' },
}

function AcceptInviteInner({ token }: { token: string }) {
  const navigate = useNavigate()
  const view = useInviteView(token)
  const accept = useAcceptInvite(token)

  const onAccept = async () => {
    const result = await accept.mutateAsync()
    setActiveCompanySlug(result.company.slug)
    navigate('/')
  }

  const invite = view.data?.invite

  return (
    <div className="m-host">
      <MShell>
        <MTopBar
          eyebrow="Invitation"
          title="Join your team."
          actionLabel="Close"
          actionIcon={<MI.X size={20} />}
          onAction={() => navigate('/')}
        />
        <MBody>
          <div style={{ padding: '20px' }}>
            {view.isLoading ? <div style={{ color: 'var(--m-ink-3)' }}>Loading invitation…</div> : null}

            {view.isError ? (
              <MBanner
                tone="error"
                title="Invitation not found"
                body="This link is invalid or has been removed. Ask your admin to send a new invite."
              />
            ) : null}

            {invite ? (
              <>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--m-ink)', marginBottom: 6 }}>
                  {invite.company_name}
                </div>
                <div style={{ fontSize: 14, color: 'var(--m-ink-3)', marginBottom: 20 }}>
                  You've been invited to join as <strong>{invite.role}</strong>
                  {invite.email ? ` (${invite.email})` : ''}.
                </div>

                {invite.status !== 'pending' && STATUS_BANNER[invite.status] ? (
                  <MBanner
                    tone={STATUS_BANNER[invite.status]!.tone}
                    title={STATUS_BANNER[invite.status]!.title}
                    body={STATUS_BANNER[invite.status]!.body}
                  />
                ) : null}

                {accept.isError ? (
                  <div style={{ marginTop: 14 }}>
                    <MBanner
                      tone="error"
                      title="Could not accept"
                      body={accept.error instanceof Error ? accept.error.message : 'Please try again.'}
                    />
                  </div>
                ) : null}

                {invite.status === 'pending' ? (
                  <div style={{ marginTop: 24 }}>
                    <MButtonStack>
                      <MButton variant="primary" onClick={onAccept} disabled={accept.isPending}>
                        {accept.isPending ? 'Accepting…' : 'Accept invitation'}
                      </MButton>
                    </MButtonStack>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </MBody>
      </MShell>
    </div>
  )
}

export function AcceptInvite() {
  const { token } = useParams<{ token: string }>()

  if (!token) {
    return (
      <div className="m-host" style={{ padding: 24 }}>
        <MBanner tone="error" title="Missing token" body="This invitation link is incomplete." />
      </div>
    )
  }

  // Prod: gate the accept action behind Clerk sign-in, returning here after.
  // The public invite summary still renders for signed-out users (via the
  // SignIn redirect URL), and the act-as dev path skips this entirely.
  if (isClerkConfigured()) {
    const redirectUrl = `/invite/accept/${encodeURIComponent(token)}`
    return (
      <>
        <SignedIn>
          <AcceptInviteInner token={token} />
        </SignedIn>
        <SignedOut>
          <div
            style={{
              minHeight: '100vh',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '2rem',
            }}
          >
            <SignIn
              routing="virtual"
              signUpUrl="/sign-up"
              forceRedirectUrl={redirectUrl}
              signUpForceRedirectUrl={redirectUrl}
            />
          </div>
        </SignedOut>
      </>
    )
  }

  return <AcceptInviteInner token={token} />
}
