/**
 * FOREMAN · DENIED FEEDBACK (`fm-denied`) — design source V2ForemanDenied,
 * "OWNER DENIED · FEEDBACK" / from "Owner denies → foreman push".
 *
 * The owner reviewed something the foreman submitted (an estimate, a
 * change order, an over-budget request) and DENIED it. This is the
 * foreman's landing surface for that decision: the denial reason in the
 * owner's words, the item it was about, and two next steps —
 *   • Push back   — reopen the conversation / re-submit with context
 *   • Acknowledge — accept the decision and move on
 *
 * Routed at `/foreman/denied/:id` (mirrors `/foreman/blocker/:issueId`),
 * where `:id` is the project id. The `project_lifecycle` workflow has a
 * server-side `declined` state whose snapshot carries the owner's
 * `decline_reason` + `declined_at`; this screen reads that snapshot and
 * shows the denial in the owner's words. Foreman = default light theme.
 *
 * Read path is wired (GET /api/projects/:id/lifecycle via the headless
 * useProjectLifecycle machine). The denied "item"/"amount" line is NOT a
 * project_lifecycle field (the workflow tracks the project, not a specific
 * change order / over-budget request), so those still come from
 * search-params when the caller passes them. See GAP note on the actions.
 */
import { useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { MShell, MBody, MTopBar, MBanner, MButton, MButtonStack, MSectionH, MTextarea, MI } from '@/components/m'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useProjectLifecycle } from '@/machines/project-lifecycle'

function formatDeclinedAt(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function ForemanDeniedScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const [searchParams] = useSearchParams()
  const [pushOpen, setPushOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  // Real declined-state snapshot for the project. The lifecycle context
  // carries the owner's decline_reason + declined_at when state==='declined'.
  const companySlug = getActiveCompanySlug()
  const lifecycle = useProjectLifecycle(id ?? '', companySlug)
  const ctx = lifecycle.snapshot?.context ?? null
  const isDeclined = lifecycle.snapshot?.state === 'declined'

  // `item`/`amount` are not project_lifecycle fields — the workflow denies a
  // project transition, not a specific change order / over-budget request — so
  // they come from the caller's query params (the surface that knows the line
  // item). The owner-words reason + who/when come from the live snapshot when
  // the project is declined, with a query-param/static fallback otherwise.
  const item = searchParams.get('item') ?? 'Change order #14 — added scaffold drop'
  const amount = searchParams.get('amount') ?? '+$4,200'
  const deniedBy = searchParams.get('by') ?? ctx?.customer_name ?? 'the owner'
  const declinedAtLabel = formatDeclinedAt(ctx?.declined_at ?? null)
  const reason =
    (isDeclined ? ctx?.decline_reason : null) ??
    searchParams.get('reason') ??
    "We didn't agree this drop with the client and the contract is fixed-price. Confirm the change in writing with the GC before adding cost, then resubmit."

  const goBack = () => navigate(-1)

  const onAcknowledge = () => {
    setBusy(true)
    // GAP: there is no foreman-facing "acknowledge" event. The
    // project_lifecycle reducer's `declined` state only offers ARCHIVE
    // (admin/office-only) — no ACKNOWLEDGE transition, and the events route
    // rejects foreman role. Acknowledging is therefore a client-side
    // dismissal for now. Suggested shape: a per-(project,foreman)
    // acknowledgement row + POST /api/projects/:id/denial/acknowledge, OR a
    // notification mark-read once the denial is delivered as a notification.
    navigate('/today', { replace: true })
  }

  const onSubmitPushBack = () => {
    setBusy(true)
    // GAP: no push-back/reopen-request event exists for a foreman. REOPEN on
    // the lifecycle reducer is admin/office-only and bypasses the owner's
    // re-review. A real push-back needs either a project_message back to the
    // owner (POST /api/projects/:id/messages — available, but a different
    // surface) or a dedicated "request re-review" lifecycle event the owner
    // approves. Until one exists this composes the note locally and returns.
    navigate('/today', { replace: true })
  }

  return (
    <div className="m-host">
      <MShell>
        <MTopBar back eyebrow="Owner decision" title="Request denied" onBack={goBack} />
        <MBody>
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner
              tone="error"
              title={`Denied by ${deniedBy}`}
              body={
                declinedAtLabel
                  ? `Declined ${declinedAtLabel}. This won't move forward as submitted — read the reason below before you push back or acknowledge.`
                  : "This won't move forward as submitted. Read the reason below before you push back or acknowledge."
              }
            />
          </div>

          {/* What was denied */}
          <div style={{ padding: '8px 20px 0' }}>
            <MSectionH>What was denied</MSectionH>
            <div
              style={{
                border: '1px solid var(--m-line)',
                borderRadius: 12,
                background: 'var(--m-card)',
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <span
                style={{
                  width: 36,
                  height: 36,
                  flexShrink: 0,
                  borderRadius: 8,
                  background: 'var(--m-red-soft)',
                  color: 'var(--m-red)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <MI.X size={18} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--m-ink)' }}>{item}</div>
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--m-red)',
                    marginTop: 3,
                  }}
                >
                  {amount}
                </div>
              </div>
            </div>
          </div>

          {/* Reason in the owner's words */}
          <div style={{ padding: '16px 20px 0' }}>
            <MSectionH>Reason</MSectionH>
            <blockquote
              style={{
                margin: 0,
                borderLeft: '3px solid var(--m-line-2)',
                paddingLeft: 14,
                fontSize: 15,
                lineHeight: 1.55,
                color: 'var(--m-ink-2)',
                fontStyle: 'italic',
              }}
            >
              “{reason}”
            </blockquote>
          </div>

          {/* Push-back composer (revealed) */}
          {pushOpen ? (
            <div style={{ padding: '20px 20px 0' }}>
              <MSectionH>Your response</MSectionH>
              <MTextarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Add the context the owner asked for, or explain why this still needs to happen…"
                rows={4}
              />
            </div>
          ) : null}

          <div style={{ padding: '24px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
            {pushOpen ? (
              <MButtonStack>
                <MButton variant="primary" onClick={onSubmitPushBack} disabled={busy || note.trim().length === 0}>
                  {busy ? 'Sending…' : 'Send push-back'}
                </MButton>
                <MButton variant="ghost" onClick={() => setPushOpen(false)} disabled={busy}>
                  Cancel
                </MButton>
              </MButtonStack>
            ) : (
              <MButtonStack>
                <MButton variant="primary" onClick={() => setPushOpen(true)}>
                  Push back
                </MButton>
                <MButton variant="ghost" onClick={onAcknowledge} disabled={busy}>
                  {busy ? 'Saving…' : 'Acknowledge & move on'}
                </MButton>
              </MButtonStack>
            )}
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 500,
                letterSpacing: '0.04em',
                textAlign: 'center',
                color: 'var(--m-ink-4)',
                marginTop: 12,
              }}
            >
              Ref {id ?? '—'}
            </div>
          </div>
        </MBody>
      </MShell>
    </div>
  )
}
