/**
 * OWNER · INVITE TEAMMATE (send) — design source msg__94,
 * "Bring someone on." Conformance report M01: the owner send-invite
 * takeover was missing entirely (only the accept-side screens exist at
 * /invite/{worker,foreman,estimator}). This is the send surface.
 *
 * Full-screen takeover with an X-close MTopBar, a 4-cell ROLE grid
 * (ESTIMATOR / FOREMAN / CREW / OWNER) mirroring owner-onboarding's
 * trade grid, and an email / Clerk-id input. The send is a single
 * idempotent CRUD write to POST /api/companies/:id/memberships via
 * `useInviteMember`; orchestration lives in the `inviteTeammate` machine
 * (role-grid selection + identifier draft + design-role→COMPANY_ROLE
 * mapping). Mounted in App.tsx as a full-screen route, reached from
 * Settings → Invite.
 */
import { useNavigate } from 'react-router-dom'
import { MShell, MBody, MTopBar, MButton, MButtonStack, MInput, MBanner, MI } from '@/components/m'
import { useCreateInvite, useCompanyInvites, useRevokeInvite } from '@/lib/api'
import { useActiveCompanyId } from '@/lib/api'
import {
  INVITE_DESIGN_ROLES,
  useInviteTeammate,
  type InviteDesignRole,
  type InviteSubmitPayload,
} from '@/machines/invite-teammate'

const ROLE_LABELS: Record<InviteDesignRole, string> = {
  estimator: 'ESTIMATOR',
  foreman: 'FOREMAN',
  crew: 'CREW',
  owner: 'OWNER',
}

export function InviteTeammateScreen() {
  const navigate = useNavigate()
  const companyId = useActiveCompanyId()
  const createInvite = useCreateInvite(companyId ?? '')

  // The machine's submitter maps the design role to a COMPANY_ROLE and
  // POSTs an invite keyed by email. The invitee gets an email with an accept
  // link; accepting binds their authenticated Clerk id into the membership
  // (apps/api/src/routes/invites.ts). The identifier field carries the email.
  const submitter = (payload: InviteSubmitPayload) =>
    createInvite.mutateAsync({ email: payload.identifier, role: payload.role })

  const invite = useInviteTeammate(submitter)

  const invitesQuery = useCompanyInvites(companyId)
  const revokeInvite = useRevokeInvite(companyId ?? '')
  const pendingInvites = (invitesQuery.data?.invites ?? []).filter((i) => i.status === 'pending')

  return (
    <div className="m-host">
      <MShell>
        <MTopBar
          eyebrow="Invite teammate"
          title="Bring someone on."
          actionLabel="Close"
          actionIcon={<MI.X size={20} />}
          onAction={() => navigate(-1)}
        />
        <MBody>
          <div style={{ padding: '20px 20px 0' }}>
            {invite.isSent ? (
              <div style={{ marginBottom: 16 }}>
                <MBanner
                  tone="ok"
                  title="Invitation sent"
                  body={`We let ${invite.sentTo[invite.sentTo.length - 1] ?? 'them'} know. Invite another, or close.`}
                />
              </div>
            ) : null}

            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-ink-3)', marginBottom: 8 }}>Role</div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                border: '2px solid var(--m-ink)',
                borderRadius: 12,
                overflow: 'hidden',
              }}
            >
              {INVITE_DESIGN_ROLES.map((r, i) => {
                const on = invite.role === r
                const rightEdge = i % 2 === 1
                const bottomRow = i >= 2
                return (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={on}
                    onClick={() => invite.selectRole(r)}
                    style={{
                      padding: '18px 12px',
                      fontFamily: 'var(--m-num)',
                      fontSize: 13,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      cursor: 'pointer',
                      background: on ? 'var(--m-accent)' : 'transparent',
                      color: on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                      border: 'none',
                      borderRight: rightEdge ? 'none' : '2px solid var(--m-ink)',
                      borderBottom: bottomRow ? 'none' : '2px solid var(--m-ink)',
                    }}
                  >
                    {ROLE_LABELS[r]}
                  </button>
                )
              })}
            </div>

            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-ink-3)', margin: '18px 0 8px' }}>
              Phone or email
            </div>
            <MInput
              type="text"
              inputMode="email"
              placeholder="name@example.com"
              value={invite.identifier}
              onChange={(e) => invite.setIdentifier(e.currentTarget.value)}
            />

            {invite.error ? (
              <div style={{ marginTop: 14 }}>
                <MBanner tone="error" title="Could not send invite" body={invite.error} />
              </div>
            ) : null}
            {companyId ? null : (
              <div style={{ marginTop: 14 }}>
                <MBanner tone="warn" title="No active company" body="Open a company before inviting teammates." />
              </div>
            )}

            {pendingInvites.length > 0 ? (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--m-ink-3)', marginBottom: 8 }}>
                  Pending invites
                </div>
                <div style={{ border: '2px solid var(--m-ink)', borderRadius: 12, overflow: 'hidden' }}>
                  {pendingInvites.map((row, i) => (
                    <div
                      key={row.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '12px 14px',
                        borderTop: i === 0 ? 'none' : '1px solid var(--m-ink-1)',
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: 14,
                            fontWeight: 600,
                            color: 'var(--m-ink)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {row.email}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>
                          {row.role} · expires {new Date(row.expires_at).toLocaleDateString()}
                        </div>
                      </div>
                      <MButton
                        variant="ghost"
                        onClick={() => revokeInvite.mutate({ inviteId: row.id })}
                        disabled={revokeInvite.isPending}
                      >
                        Revoke
                      </MButton>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div style={{ padding: '24px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
            <MButtonStack>
              {invite.isSent ? (
                <MButton variant="primary" onClick={() => invite.reset()}>
                  Invite another
                </MButton>
              ) : (
                <MButton
                  variant="primary"
                  onClick={() => invite.send()}
                  disabled={!invite.canSend || invite.isSending || !companyId}
                >
                  {invite.isSending ? 'Sending…' : 'Send invite'}
                </MButton>
              )}
              <MButton variant="ghost" onClick={() => navigate(-1)}>
                Done
              </MButton>
            </MButtonStack>
          </div>
        </MBody>
      </MShell>
    </div>
  )
}
