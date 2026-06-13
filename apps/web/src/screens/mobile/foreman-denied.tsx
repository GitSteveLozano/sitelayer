/**
 * FOREMAN · OWNER-DENIED FEEDBACK (`fm-denied`) — design source msg__42
 * ("FROM MIKE · DENIED · $510 EPS order — not yet."), the owner-denial →
 * foreman feedback loop of the M06 request/approval flow.
 *
 * Routed at `/foreman/denied/:id` where `:id` is the **field_request work
 * item id** (`context_work_items`). The loop end-to-end:
 *
 *   1. The owner DENIES a field request in the approvals inbox
 *      (owner-approvals → POST /api/work-requests/:id/events with
 *      `work_item.status_changed` → `wont_do`, the owner's note as
 *      `message`).
 *   2. The API enqueues `notify_field_request_denied`
 *      (apps/api/src/routes/work-requests.ts) and the worker
 *      (apps/worker/src/field-event-notifier.ts) inserts a notification for
 *      the foreman who filed the request whose payload `route` deep-links
 *      HERE; the role inbox (notifications-inbox.tsx) navigates on tap.
 *   3. This screen loads the real work item + event timeline
 *      (GET /api/work-requests/:id via `useWorkRequest`), renders the
 *      denial in the owner's words (the `wont_do` event's `message`), and
 *      offers two REAL next steps:
 *        • RESUBMIT — `resolution.reopened` (+ the foreman's note), which
 *          puts the request back into the owner's approvals queue
 *          (`reopened` is in its open-statuses set).
 *        • REPLY — `message.added`, a thread message on the request.
 *      Both events are `field_request.view`-class, so the foreman role can
 *      send them; `wont_do` is not a hard-terminal state (only `reversed`
 *      blocks events), so the server accepts both.
 *
 * Honesty notes: there is NO structured "suggested alternatives" field on
 * the backend — the owner's free-text denial note is the only alternatives
 * signal, so the WHY quote renders only when that note exists and nothing
 * is fabricated when it doesn't. The owner's display name is not resolvable
 * from the work-item/event rows (clerk user ids only), so the screen says
 * "OWNER" rather than inventing a name. Foreman = default light theme.
 */
import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MBanner, MBody, MButton, MButtonStack, MSectionH, MShell, MTextarea, MTopBar } from '@/components/m'
import { MSkeletonList } from '@/components/m-states'
import { useAppendWorkRequestEvent, useWorkRequest, type ContextHandoffEvent } from '@/lib/api/work-requests'

const DISPLAY = 'var(--m-font-display)'
const MONO = 'var(--m-num)'

/** "9:14 AM · APR 28" style stamp for the denial meta line. */
function denialStamp(iso: string | null): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${time} · ${day}`.toUpperCase()
}

/** Latest denial event: a status change that landed the item on wont_do. */
function findDenialEvent(events: ContextHandoffEvent[]): ContextHandoffEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.event_type === 'work_item.status_changed' && e.payload?.status === 'wont_do') return e
  }
  return null
}

function eventMessage(event: ContextHandoffEvent | null): string | null {
  const raw = event?.payload?.message
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

type ComposeMode = 'idle' | 'resubmit' | 'reply'

export function ForemanDeniedScreen() {
  const navigate = useNavigate()
  const { id } = useParams()
  const workItemId = id ?? ''

  const detail = useWorkRequest(workItemId)
  const appendEvent = useAppendWorkRequestEvent()

  const [mode, setMode] = useState<ComposeMode>('idle')
  const [note, setNote] = useState('')
  const [replySent, setReplySent] = useState(false)

  const workItem = detail.data?.work_item ?? null
  const events = detail.data?.events ?? []
  const denial = findDenialEvent(events)
  const reason = eventMessage(denial)
  const deniedStamp = denialStamp(denial?.occurred_at ?? null)

  const busy = appendEvent.isPending
  const goBack = () => navigate(-1)

  const submit = (composeMode: Exclude<ComposeMode, 'idle'>) => {
    const text = note.trim()
    if (!workItem || text.length === 0) return
    appendEvent.mutate(
      {
        id: workItem.id,
        input:
          composeMode === 'resubmit'
            ? { event_type: 'resolution.reopened', message: text }
            : { event_type: 'message.added', message: text },
      },
      {
        onSuccess: () => {
          setMode('idle')
          setNote('')
          if (composeMode === 'reply') setReplySent(true)
        },
      },
    )
  }

  return (
    <div className="m-host">
      <MShell>
        <MTopBar back eyebrow="Owner decision" title="From the owner" onBack={goBack} />
        <MBody>
          {detail.isPending ? (
            <MSkeletonList count={3} />
          ) : detail.error || !workItem ? (
            <div style={{ padding: '14px 16px' }}>
              <MBanner
                tone="error"
                title="Couldn't load this request"
                body={
                  detail.error instanceof Error
                    ? detail.error.message
                    : 'It may have been removed or belongs to another company.'
                }
                action={
                  <MButton size="sm" variant="quiet" onClick={() => navigate('/today')}>
                    Back to Today
                  </MButton>
                }
              />
            </div>
          ) : workItem.status === 'wont_do' ? (
            <>
              {/* Red full-fill denial hero — msg__42's "● DENIED / $510 EPS
                  order — not yet." block, on the real request title. */}
              <div
                style={{
                  padding: '18px 20px 22px',
                  background: 'var(--m-red)',
                  color: '#fff',
                  borderBottom: '2px solid var(--m-ink)',
                }}
              >
                <div
                  style={{
                    fontFamily: MONO,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                  }}
                >
                  ● DENIED{deniedStamp ? ` · ${deniedStamp}` : ''}
                </div>
                <div
                  style={{
                    fontFamily: DISPLAY,
                    fontSize: 34,
                    fontWeight: 800,
                    letterSpacing: '-0.02em',
                    lineHeight: 1.02,
                    margin: '10px 0 0',
                    overflowWrap: 'break-word',
                  }}
                >
                  {workItem.title}
                </div>
                {workItem.summary ? (
                  <div style={{ fontSize: 14, lineHeight: 1.45, marginTop: 10, opacity: 0.92 }}>{workItem.summary}</div>
                ) : null}
              </div>

              {appendEvent.error ? (
                <div style={{ padding: '14px 16px 0' }}>
                  <MBanner
                    tone="error"
                    title="Couldn't send that"
                    body={appendEvent.error instanceof Error ? appendEvent.error.message : 'Request failed — retry.'}
                  />
                </div>
              ) : null}
              {replySent ? (
                <div style={{ padding: '14px 16px 0' }}>
                  <MBanner tone="ok" title="Reply sent" body="Your note is on the request thread for the owner." />
                </div>
              ) : null}

              {/* WHY — the denial in the owner's words. Only the real note;
                  when the owner gave none, say exactly that. */}
              <div style={{ padding: '16px 20px 0' }}>
                <MSectionH>Why</MSectionH>
                {reason ? (
                  <div
                    style={{
                      border: '2px solid var(--m-ink)',
                      background: 'var(--m-card)',
                      padding: '14px 16px',
                      fontFamily: DISPLAY,
                      fontSize: 17,
                      fontWeight: 600,
                      lineHeight: 1.4,
                      color: 'var(--m-ink)',
                    }}
                  >
                    {reason}
                  </div>
                ) : (
                  <div
                    style={{
                      border: '2px solid var(--m-line-2)',
                      background: 'var(--m-card-soft)',
                      padding: '14px 16px',
                      fontFamily: MONO,
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: '0.02em',
                      color: 'var(--m-ink-3)',
                    }}
                  >
                    NO REASON WAS LEFT WITH THIS DENIAL.
                  </div>
                )}
                <div
                  style={{
                    fontFamily: MONO,
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    color: 'var(--m-ink-3)',
                    marginTop: 8,
                  }}
                >
                  {deniedStamp ? `${deniedStamp} · OWNER` : 'OWNER'}
                </div>
              </div>

              {/* Next steps — msg__42's SUGGESTED ALTERNATIVES button stack.
                  The backend has no structured alternatives field, so the
                  header only claims "suggested alternatives" when the owner's
                  note (the only alternatives signal) exists. Both actions are
                  real events on the request. */}
              <div style={{ padding: '20px 20px calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
                <MSectionH>{reason ? 'Suggested alternatives' : 'Next steps'}</MSectionH>
                {mode === 'idle' ? (
                  <MButtonStack>
                    <MButton variant="primary" onClick={() => setMode('resubmit')} disabled={busy}>
                      Resubmit with changes
                    </MButton>
                    <MButton variant="ghost" onClick={() => setMode('reply')} disabled={busy}>
                      Reply to owner
                    </MButton>
                    <MButton variant="quiet" onClick={() => navigate('/today')} disabled={busy}>
                      Back to Today
                    </MButton>
                  </MButtonStack>
                ) : (
                  <>
                    <MTextarea
                      value={note}
                      onChange={(e) => setNote(e.currentTarget.value)}
                      placeholder={
                        mode === 'resubmit'
                          ? "What changed — the context the owner asked for, or why it's still needed…"
                          : 'Your reply lands on the request thread for the owner…'
                      }
                      rows={4}
                      style={{ width: '100%' }}
                    />
                    <div style={{ marginTop: 12 }}>
                      <MButtonStack>
                        <MButton
                          variant="primary"
                          onClick={() => submit(mode)}
                          disabled={busy || note.trim().length === 0}
                        >
                          {busy ? 'Sending…' : mode === 'resubmit' ? 'Send back for review' : 'Send reply'}
                        </MButton>
                        <MButton variant="ghost" onClick={() => setMode('idle')} disabled={busy}>
                          Cancel
                        </MButton>
                      </MButtonStack>
                    </div>
                    {mode === 'resubmit' ? (
                      <div
                        style={{
                          fontFamily: MONO,
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: '0.06em',
                          textAlign: 'center',
                          color: 'var(--m-ink-3)',
                          marginTop: 10,
                        }}
                      >
                        GOES BACK INTO THE OWNER'S APPROVAL QUEUE
                      </div>
                    ) : null}
                  </>
                )}
                <RefLine id={workItem.id} />
              </div>
            </>
          ) : workItem.status === 'reopened' ? (
            // Post-resubmit landing (also reached when someone else already
            // reopened it): the denial is superseded — back in review.
            <div style={{ padding: '14px 16px calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
              <MBanner
                tone="ok"
                title="Back in review"
                body={`"${workItem.title}" is back in the owner's approval queue.`}
              />
              <div style={{ marginTop: 16 }}>
                <MButtonStack>
                  <MButton variant="primary" onClick={() => navigate('/today')}>
                    Back to Today
                  </MButton>
                </MButtonStack>
              </div>
              <RefLine id={workItem.id} />
            </div>
          ) : (
            // Any other status: this request is no longer denied — say what it
            // is now instead of rendering a stale denial composition.
            <div style={{ padding: '14px 16px calc(env(safe-area-inset-bottom, 0px) + 20px)' }}>
              <MBanner
                tone="info"
                title="No longer denied"
                body={`"${workItem.title}" is now ${workItem.status.replace(/_/g, ' ')}.`}
              />
              <div style={{ marginTop: 16 }}>
                <MButtonStack>
                  <MButton variant="primary" onClick={() => navigate('/today')}>
                    Back to Today
                  </MButton>
                </MButtonStack>
              </div>
              <RefLine id={workItem.id} />
            </div>
          )}
        </MBody>
      </MShell>
    </div>
  )
}

function RefLine({ id }: { id: string }) {
  return (
    <div
      style={{
        fontFamily: MONO,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.06em',
        textAlign: 'center',
        color: 'var(--m-ink-4)',
        marginTop: 14,
      }}
    >
      REF {id.slice(0, 8).toUpperCase()}
    </div>
  )
}
