/**
 * Desktop FM blocker detail — the desktop consumer of the field_event
 * workflow, parity with the mobile `foreman-blocker-detail` screen. Both reuse
 * the platform-agnostic `useFieldEvent` headless machine; this is the whole
 * point of the headless split. Buttons are driven off the server-computed
 * `next_events` so the UI can never offer a transition the server would 409.
 *
 * Routed at `/desktop/fm/blocker/:issueId`. Reached from the FM-Today blocker
 * hero.
 */
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { DEyebrow, DErrorState, DH1, DLoadingState } from '@/components/d'
import { MBanner, MButton, MButtonStack, MSectionH, MTextarea } from '@/components/m'
import { useFieldEvent, type FieldEventResolutionAction } from '../../machines/field-event.js'

const RESOLUTION_OPTIONS: ReadonlyArray<{ id: FieldEventResolutionAction; label: string }> = [
  { id: 'order_more', label: 'Order more' },
  { id: 'bring_from_site', label: 'Bring from another site' },
  { id: 'use_what_we_have', label: "Use what's on hand" },
  { id: 'park', label: 'Park for now' },
  { id: 'change_order', label: 'Change order' },
]

export function FmBlockerDetail({
  bootstrap,
  companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const params = useParams<{ issueId: string }>()
  const issueId = params.issueId ?? ''
  const fe = useFieldEvent(issueId, companySlug)

  const ctx = fe.snapshot?.context
  const state = fe.snapshot?.state ?? 'open'
  const actions = new Set((fe.snapshot?.next_events ?? []).map((e) => e.type))
  const message = (ctx?.message ?? '')
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/\[severity:[^\]]+\]/g, '')
    .trim()
  const worker = bootstrap?.workers.find((w) => w.id === ctx?.worker_id)
  const project = bootstrap?.projects.find((p) => p.id === ctx?.project_id)

  const [action, setAction] = useState<FieldEventResolutionAction>('order_more')
  const [reply, setReply] = useState('')
  const [escalateMode, setEscalateMode] = useState(false)
  const [escalateReason, setEscalateReason] = useState('')
  const [dismissMode, setDismissMode] = useState(false)

  if (fe.isLoading && !fe.snapshot) return <DLoadingState label="Loading blocker…" />
  if (!fe.snapshot) return <DErrorState title="Couldn't load this blocker" body="It may have been removed." />

  const handleReopen = () => {
    setEscalateMode(false)
    setDismissMode(false)
    fe.dispatch({ event: 'REOPEN' })
  }

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>
            Foreman · {state === 'open' ? (ctx?.severity ?? 'open').toUpperCase() : state.toUpperCase()} ·{' '}
            {worker?.name ?? 'Unknown worker'}
          </DEyebrow>
          <DH1>“{message}”</DH1>
          {project?.name ? <DEyebrow>{project.name}</DEyebrow> : null}
        </div>

        {fe.error ? (
          <MBanner
            tone="error"
            title={fe.outOfSync ? 'Server has a newer version' : "Couldn't apply that action"}
            body={fe.error}
            action={
              <MButton size="sm" variant="quiet" onClick={fe.dismissError}>
                Dismiss
              </MButton>
            }
          />
        ) : null}

        {state === 'open' ? (
          !escalateMode && !dismissMode ? (
            <>
              <MSectionH>Resolve · pick one</MSectionH>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {RESOLUTION_OPTIONS.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setAction(opt.id)}
                    aria-pressed={action === opt.id}
                    style={{
                      display: 'flex',
                      width: '100%',
                      alignItems: 'center',
                      gap: 14,
                      padding: '14px 18px',
                      background: action === opt.id ? 'var(--m-accent)' : 'var(--m-card-soft)',
                      color: action === opt.id ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                      border: '2px solid var(--m-ink)',
                      textAlign: 'left',
                      fontFamily: 'var(--m-font)',
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ flex: 1, fontWeight: 700 }}>{opt.label}</span>
                    <span style={{ fontWeight: 800 }}>→</span>
                  </button>
                ))}
              </div>
              <MSectionH>Reply to worker</MSectionH>
              <MTextarea
                value={reply}
                onChange={(e) => setReply(e.currentTarget.value)}
                placeholder="On its way · 30m"
                style={{ width: '100%', minHeight: 80 }}
              />
              <MButtonStack>
                <MButton
                  variant="primary"
                  onClick={() => fe.dispatch({ event: 'RESOLVE', action, message_to_worker: reply.trim() })}
                  disabled={fe.isSubmitting || reply.trim().length === 0}
                >
                  {fe.isSubmitting ? 'Resolving…' : 'Resolve'}
                </MButton>
                {actions.has('ESCALATE') ? (
                  <MButton variant="ghost" onClick={() => setEscalateMode(true)}>
                    Escalate to estimator
                  </MButton>
                ) : null}
                {actions.has('DISMISS') ? (
                  <MButton variant="ghost" onClick={() => setDismissMode(true)}>
                    Dismiss
                  </MButton>
                ) : null}
              </MButtonStack>
            </>
          ) : escalateMode ? (
            <>
              <MSectionH>Why escalate?</MSectionH>
              <MTextarea
                value={escalateReason}
                onChange={(e) => setEscalateReason(e.currentTarget.value)}
                placeholder="What does the estimator need to decide?"
                style={{ width: '100%', minHeight: 100 }}
              />
              <MButtonStack>
                <MButton
                  variant="primary"
                  onClick={() => fe.dispatch({ event: 'ESCALATE', reason: escalateReason.trim() || message })}
                  disabled={fe.isSubmitting}
                >
                  {fe.isSubmitting ? 'Escalating…' : 'Send to estimator'}
                </MButton>
                <MButton variant="ghost" onClick={() => setEscalateMode(false)}>
                  Back
                </MButton>
              </MButtonStack>
            </>
          ) : (
            <>
              <MSectionH>Dismiss this event?</MSectionH>
              <div style={{ color: 'var(--m-ink-3)', fontSize: 14, lineHeight: 1.5 }}>
                No reply is sent to the worker and the estimator isn't looped in. It stays as the audit trail and can be
                reopened.
              </div>
              <MButtonStack>
                <MButton variant="primary" onClick={() => fe.dispatch({ event: 'DISMISS' })} disabled={fe.isSubmitting}>
                  {fe.isSubmitting ? 'Dismissing…' : 'Dismiss event'}
                </MButton>
                <MButton variant="ghost" onClick={() => setDismissMode(false)}>
                  Back
                </MButton>
              </MButtonStack>
            </>
          )
        ) : (
          <div>
            <MBanner
              tone={state === 'resolved' ? 'ok' : state === 'escalated' ? 'attention' : 'info'}
              title={state === 'resolved' ? 'RESOLVED' : state === 'escalated' ? 'ESCALATED TO ESTIMATOR' : 'DISMISSED'}
              body={state === 'escalated' && ctx?.escalation_reason ? `“${ctx.escalation_reason}”` : undefined}
            />
            {actions.has('REOPEN') ? (
              <MButtonStack>
                <MButton variant="ghost" onClick={handleReopen} disabled={fe.isSubmitting}>
                  {fe.isSubmitting ? 'Reopening…' : 'Reopen'}
                </MButton>
                <MButton variant="quiet" onClick={() => navigate('/desktop/fm/today')}>
                  Back to Today
                </MButton>
              </MButtonStack>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
