/**
 * fm-blocker-detail — Resolve a blocker.
 *
 * Routed at `/foreman/blocker/:issueId`. Shows worker context (avatar +
 * name + project + scope), the issue text, persisted voice / photo
 * attachments fetched from `/api/worker-issues/:id/attachments`, and a
 * GPS pin chip. The bottom segmented picker selects a resolution action;
 * the foreman types a reply that becomes `resolution_message` and
 * submits via the field-event xstate machine
 * (apps/web/src/machines/field-event.ts).
 *
 * Wire shape: PATCH /api/worker-issues/:id with
 *   { event: 'RESOLVE'|'ESCALATE', state_version, action?, message_to_worker?, reason? }
 *
 * Attachment retrieval:
 *   GET /api/worker-issues/:id/attachments        → metadata list
 *   GET /api/worker-issues/:id/attachments/:key/file → bytes (or 302
 *      to a presigned URL when BLUEPRINT_DOWNLOAD_PRESIGNED=1)
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, type BootstrapResponse } from '@/lib/api'
import { API_URL } from '../../lib/api/client.js'
import {
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MI,
  MSectionH,
  MTextarea,
  MTopBar,
} from '../../components/m/index.js'
import { useFieldEvent, type FieldEventResolutionAction } from '../../machines/field-event.js'
import { timeOfDay } from './format.js'

type IssueRow = {
  id: string
  project_id: string | null
  worker_id: string | null
  reporter_clerk_user_id: string
  kind: string
  message: string
  resolved_at: string | null
  resolved_by_clerk_user_id: string | null
  created_at: string
  // Optional GPS fields. Persisted attachments live on the
  // worker_issue_attachments table and are fetched separately below.
  lat?: string | number | null
  lng?: string | number | null
}

type AttachmentRow = {
  id: string
  worker_issue_id: string
  kind: 'voice' | 'photo'
  storage_key: string
  mime_type: string
  size_bytes: string | number
  created_at: string
}

const RESOLUTION_OPTIONS: ReadonlyArray<{
  id: FieldEventResolutionAction
  label: string
  Icon: typeof MI.Truck
}> = [
  { id: 'order_more', label: 'Order more', Icon: MI.Truck },
  { id: 'bring_from_site', label: 'Bring from another site', Icon: MI.Home },
  { id: 'use_what_we_have', label: "Use what's on hand", Icon: MI.Check },
  { id: 'park', label: 'Park for now', Icon: MI.Clock },
  { id: 'change_order', label: 'Change order', Icon: MI.FileText },
]

export function ForemanBlockerDetail({
  bootstrap,
  companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const navigate = useNavigate()
  const params = useParams<{ issueId: string }>()
  const issueId = params.issueId ?? ''

  // We try the workflow snapshot first via the field-event machine
  // (GET /api/worker-issues/:id). If that fails to load, fall back to a
  // direct GET on /api/worker-issues so we can still render the worker's
  // context even when the snapshot fetch errored.
  const fe = useFieldEvent(issueId, companySlug)
  const [legacyRow, setLegacyRow] = useState<IssueRow | null>(null)
  const [attachments, setAttachments] = useState<AttachmentRow[]>([])
  useEffect(() => {
    if (fe.snapshot || fe.isLoading) return
    if (!issueId) return
    let cancelled = false
    apiGet<{ worker_issues: IssueRow[] } | { worker_issue: IssueRow }>(
      `/api/worker-issues?id=${encodeURIComponent(issueId)}`,
      companySlug,
    )
      .then((r) => {
        if (cancelled) return
        const row =
          'worker_issue' in r ? r.worker_issue : ((r.worker_issues ?? []).find((i) => i.id === issueId) ?? null)
        setLegacyRow(row)
      })
      .catch(() => {
        if (!cancelled) setLegacyRow(null)
      })
    return () => {
      cancelled = true
    }
  }, [issueId, companySlug, fe.snapshot, fe.isLoading])

  // Pull persisted attachments — voice + photo — independent of which
  // path produced the row context. The endpoint scopes to the current
  // company, so an unknown id just returns an empty list.
  useEffect(() => {
    if (!issueId) return
    let cancelled = false
    apiGet<{ attachments: AttachmentRow[] }>(
      `/api/worker-issues/${encodeURIComponent(issueId)}/attachments`,
      companySlug,
    )
      .then((r) => {
        if (!cancelled) setAttachments(r.attachments ?? [])
      })
      .catch(() => {
        if (!cancelled) setAttachments([])
      })
    return () => {
      cancelled = true
    }
  }, [issueId, companySlug])

  const voiceAttachment = attachments.find((a) => a.kind === 'voice') ?? null
  const photoAttachments = attachments.filter((a) => a.kind === 'photo')

  const ctx = fe.snapshot?.context
  const fallback: IssueRow | null = legacyRow
  const message = ctx?.message ?? fallback?.message ?? ''
  const cleanedMessage = message.replace(/^\[[^\]]+\]\s*/g, '').trim()
  const projectId = ctx?.project_id ?? fallback?.project_id ?? null
  const workerId = ctx?.worker_id ?? fallback?.worker_id ?? null
  const createdAt = ctx?.created_at ?? fallback?.created_at ?? null
  const severity = ctx?.severity ?? severityFromMessage(message)
  const resolved = Boolean(ctx?.resolved_at ?? fallback?.resolved_at)

  const worker = bootstrap?.workers.find((x) => x.id === workerId)
  const project = bootstrap?.projects.find((x) => x.id === projectId)

  const [action, setAction] = useState<FieldEventResolutionAction>('order_more')
  const [reply, setReply] = useState('')
  const [escalateMode, setEscalateMode] = useState(false)
  const [escalateReason, setEscalateReason] = useState('')

  const lat = numberOrNull(fallback?.lat)
  const lng = numberOrNull(fallback?.lng)

  const handleResolve = () => {
    // The machine guards DISPATCH on a non-null snapshot, so submitting
    // before the snapshot loads is a no-op rather than a crash. The
    // primary button is disabled until the snapshot is present + a reply
    // is typed, so the foreman can't reach this with an empty payload.
    fe.dispatch({ event: 'RESOLVE', action, message_to_worker: reply.trim() })
  }

  const handleEscalate = () => {
    fe.dispatch({ event: 'ESCALATE', reason: escalateReason.trim() || cleanedMessage })
  }

  // Auto-navigate back when the snapshot lands in a terminal state after
  // a successful submit.
  useEffect(() => {
    if (!fe.snapshot) return
    if (fe.snapshot.state === 'resolved' || fe.snapshot.state === 'escalated') {
      const t = window.setTimeout(() => navigate('/field'), 600)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [fe.snapshot, navigate])

  const sevTone = severity === 'stopped' ? 'red' : severity === 'slowing' ? 'amber' : 'blue'

  // Surface a clear gate when neither path produced a row — the route
  // genuinely doesn't exist or we're on a stale id.
  const missing = !fe.isLoading && !fe.snapshot && !fallback

  return (
    <>
      <MTopBar back title="Field event" sub={project?.name} onBack={() => navigate('/field')} />
      <MBody pad>
        {missing ? (
          <MBanner
            tone="warn"
            title="Couldn't load this event"
            body="This field event may have been removed or belongs to another company. Head back to Field for the latest list."
            action={
              <MButton size="sm" variant="quiet" onClick={() => navigate('/field')}>
                Back to Field
              </MButton>
            }
          />
        ) : null}
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
        <div className="m-card" style={{ marginTop: 8 }}>
          <div
            className="m-topbar-eyebrow"
            style={{
              fontWeight: 800,
              color: resolved ? 'var(--m-green)' : sevTone === 'red' ? 'var(--m-red)' : sevTone === 'amber' ? 'var(--m-amber)' : 'var(--m-ink-3)',
            }}
          >
            ● {resolved ? 'RESOLVED' : (severity ?? 'open').toUpperCase()} · {worker?.name?.toUpperCase() ?? 'UNKNOWN WORKER'}
            {createdAt ? ` · ${timeOfDay(createdAt).toUpperCase()}` : ''}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 700,
              fontSize: 22,
              lineHeight: 1.1,
              marginTop: 12,
              color: 'var(--m-ink)',
            }}
          >
            “{cleanedMessage}”
          </div>
          <div
            className="m-topbar-eyebrow"
            style={{ marginTop: 10, color: 'var(--m-ink-3)', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
          >
            {project?.name ? <span>{project.name.toUpperCase()}</span> : null}
            {createdAt ? <span>{shortAgo(createdAt).toUpperCase()}</span> : null}
            {ctx?.kind ? <span>{ctx.kind.replace(/_/g, ' ').toUpperCase()}</span> : null}
            {lat !== null && lng !== null ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <MI.MapPin size={12} />
                {lat.toFixed(4)}, {lng.toFixed(4)}
              </span>
            ) : null}
          </div>
          {voiceAttachment ? (
            <div style={{ marginTop: 12 }}>
              <div className="m-topbar-eyebrow" style={{ marginBottom: 4 }}>
                VOICE NOTE
              </div>
              <audio src={attachmentFileUrl(issueId, voiceAttachment.storage_key)} controls style={{ width: '100%' }} />
            </div>
          ) : null}
          {photoAttachments.length > 0 ? (
            <div
              style={{
                marginTop: 12,
                display: 'grid',
                gridTemplateColumns: photoAttachments.length === 1 ? '1fr' : '1fr 1fr',
                gap: 8,
              }}
            >
              {photoAttachments.map((p) => (
                <img
                  key={p.id}
                  src={attachmentFileUrl(issueId, p.storage_key)}
                  alt="Worker photo"
                  style={{ width: '100%', maxHeight: 320, objectFit: 'cover', borderRadius: 10 }}
                />
              ))}
            </div>
          ) : null}
        </div>

        {!resolved ? (
          <>
            {!escalateMode ? (
              <>
                <MSectionH>Resolve · pick one</MSectionH>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {RESOLUTION_OPTIONS.map((opt) => {
                    const active = action === opt.id
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setAction(opt.id)}
                        aria-pressed={active}
                        style={{
                          display: 'flex',
                          width: '100%',
                          alignItems: 'center',
                          gap: 14,
                          padding: '16px 18px',
                          background: active ? 'var(--m-accent)' : 'var(--m-card-soft)',
                          color: active ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                          border: '2px solid var(--m-ink)',
                          textAlign: 'left',
                          fontFamily: 'var(--m-font)',
                          cursor: 'pointer',
                        }}
                      >
                        <opt.Icon size={20} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 15 }}>{opt.label}</div>
                        </div>
                        <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 18 }}>→</div>
                      </button>
                    )
                  })}
                </div>
                <MSectionH>Reply to worker</MSectionH>
                <MTextarea
                  value={reply}
                  onChange={(e) => setReply(e.currentTarget.value)}
                  placeholder="On its way · 30m"
                  style={{ width: '100%', minHeight: 80 }}
                />
                <div style={{ marginTop: 16 }}>
                  <MButtonStack>
                    <MButton
                      variant="primary"
                      onClick={handleResolve}
                      disabled={fe.isSubmitting || !fe.snapshot || reply.trim().length === 0}
                      aria-disabled={fe.isSubmitting || !fe.snapshot || reply.trim().length === 0}
                    >
                      {fe.isSubmitting ? 'Resolving…' : 'Resolve'}
                    </MButton>
                    <MButton variant="ghost" onClick={() => setEscalateMode(true)}>
                      Escalate to estimator
                    </MButton>
                  </MButtonStack>
                  <div
                    className="m-topbar-eyebrow"
                    style={{ marginTop: 12, textAlign: 'center', color: 'var(--m-ink-3)', fontWeight: 600 }}
                  >
                    ● {worker?.name?.toUpperCase() ?? 'WORKER'} AUTO-NOTIFIED ON RESOLVE
                  </div>
                </div>
              </>
            ) : (
              <>
                <MSectionH>Why escalate?</MSectionH>
                <MTextarea
                  value={escalateReason}
                  onChange={(e) => setEscalateReason(e.currentTarget.value)}
                  placeholder="What does the estimator need to decide?"
                  style={{ width: '100%', minHeight: 100 }}
                />
                <div style={{ marginTop: 16 }}>
                  <MButtonStack>
                    <MButton variant="primary" onClick={handleEscalate} disabled={fe.isSubmitting || !fe.snapshot}>
                      {fe.isSubmitting ? 'Escalating…' : 'Send to estimator'}
                    </MButton>
                    <MButton variant="ghost" onClick={() => setEscalateMode(false)}>
                      Back
                    </MButton>
                  </MButtonStack>
                </div>
              </>
            )}
          </>
        ) : (
          <div
            className="m-topbar-eyebrow"
            style={{ padding: '16px', color: 'var(--m-green)', textAlign: 'center', fontWeight: 800 }}
          >
            ● RESOLVED {fe.snapshot?.context.resolved_at ? shortAgo(fe.snapshot.context.resolved_at).toUpperCase() : ''}
          </div>
        )}
      </MBody>
    </>
  )
}

/**
 * Build the GET URL for a worker-issue attachment. The endpoint either
 * streams bytes back or 302s to a presigned URL; <img src> / <audio src>
 * follow both transparently.
 */
function attachmentFileUrl(issueId: string, storageKey: string): string {
  return `${API_URL}/api/worker-issues/${encodeURIComponent(issueId)}/attachments/${encodeURIComponent(storageKey)}/file`
}

function severityFromMessage(message: string): 'question' | 'slowing' | 'stopped' | null {
  const m = message.match(/\[severity:(question|slowing|stopped)\]/)
  return (m?.[1] as 'question' | 'slowing' | 'stopped' | undefined) ?? null
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  const n = typeof value === 'string' ? Number(value) : value
  return Number.isFinite(n) ? n : null
}

function shortAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).valueOf()
  if (!Number.isFinite(ms) || ms < 0) return iso
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
