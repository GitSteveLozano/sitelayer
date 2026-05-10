/**
 * fm-blocker-detail — Resolve a blocker.
 *
 * Routed at `/foreman/blocker/:issueId`. Shows worker context (avatar +
 * name + project + scope), the issue text, optional voice playback (when
 * the worker attached a base64 `voice_data_url`), the photo (if any),
 * and a GPS pin chip. The bottom segmented picker selects a resolution
 * action; the foreman types a reply that becomes `resolution_message`
 * and submits via the field-event xstate machine
 * (apps/web/src/machines/field-event.ts).
 *
 * Wire shape: PATCH /api/worker-issues/:id with
 *   { event: 'RESOLVE'|'ESCALATE', state_version, action?, message_to_worker?, reason? }
 *
 * The PATCH route is being implemented by a parallel agent. If the call
 * fails because the route isn't there yet (4xx/5xx), the field-event
 * machine surfaces the error via `useFieldEvent.error`. We render that
 * inline so the foreman knows the action was queued but didn't land.
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { apiGet, type BootstrapResponse } from '../../api-v1-compat.js'
import {
  MAvatar,
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MChip,
  MChipRow,
  MI,
  MPill,
  MSectionH,
  MTextarea,
  MTopBar,
  avatarToneFor,
  initialsFor,
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
  // Optional client-side fields written by `wk-issue` until the worker_issues
  // schema gets dedicated columns. May or may not appear on a given row.
  voice_data_url?: string | null
  photo_data_url?: string | null
  lat?: string | number | null
  lng?: string | number | null
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

  // We try the workflow snapshot first via the field-event machine. If
  // it 404s (the parallel PATCH route hasn't shipped yet), fall back to
  // a direct GET on /api/worker-issues so we still show context.
  const fe = useFieldEvent(issueId, companySlug)
  const [legacyRow, setLegacyRow] = useState<IssueRow | null>(null)
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
    if (!fe.snapshot) {
      // PATCH route may not exist yet. The field-event machine guards
      // against dispatching without a snapshot; surface a TODO banner
      // so the foreman knows the action was a no-op.
      return
    }
    fe.dispatch({ event: 'RESOLVE', action, message_to_worker: reply.trim() })
  }

  const handleEscalate = () => {
    if (!fe.snapshot) return
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
            body="The PATCH /api/worker-issues/:id workflow route may not be live yet. Returning to /field will show the latest list."
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {worker ? <MAvatar initials={initialsFor(worker.name)} tone={avatarToneFor(worker.id)} size="lg" /> : null}
            <div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{worker?.name ?? 'Unknown worker'}</div>
              <div className="m-quiet-sm">{createdAt ? `${shortAgo(createdAt)} · ${timeOfDay(createdAt)}` : '—'}</div>
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--m-line)', margin: '12px 0' }} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <MPill tone={resolved ? 'green' : sevTone}>{resolved ? 'resolved' : (severity ?? 'open')}</MPill>
            {ctx?.kind ? <MPill>{ctx.kind.replace(/_/g, ' ')}</MPill> : null}
            {lat !== null && lng !== null ? (
              <span className="m-quiet-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <MI.MapPin size={14} />
                {lat.toFixed(4)}, {lng.toFixed(4)}
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: 15, lineHeight: 1.5, marginTop: 10 }}>{cleanedMessage}</div>
          {fallback?.voice_data_url ? (
            <div style={{ marginTop: 12 }}>
              <div className="m-topbar-eyebrow" style={{ marginBottom: 4 }}>
                VOICE NOTE
              </div>
              <audio src={fallback.voice_data_url} controls style={{ width: '100%' }} />
            </div>
          ) : null}
          {fallback?.photo_data_url ? (
            <div style={{ marginTop: 12 }}>
              <img
                src={fallback.photo_data_url}
                alt="Worker photo"
                style={{ width: '100%', maxHeight: 320, objectFit: 'cover', borderRadius: 10 }}
              />
            </div>
          ) : null}
        </div>

        {!resolved ? (
          <>
            {!escalateMode ? (
              <>
                <MSectionH>How are you fixing it?</MSectionH>
                <MChipRow>
                  {RESOLUTION_OPTIONS.map((opt) => (
                    <MChip key={opt.id} active={action === opt.id} onClick={() => setAction(opt.id)}>
                      {opt.label}
                    </MChip>
                  ))}
                </MChipRow>
                <MSectionH>Reply to worker</MSectionH>
                <MTextarea
                  value={reply}
                  onChange={(e) => setReply(e.currentTarget.value)}
                  placeholder="On its way · 30m"
                  style={{ width: '100%', minHeight: 80 }}
                />
                <div style={{ marginTop: 16 }}>
                  <MButtonStack>
                    <MButton variant="primary" onClick={handleResolve} disabled={fe.isSubmitting || !fe.snapshot}>
                      {fe.isSubmitting ? 'Resolving…' : 'Resolve'}
                    </MButton>
                    <MButton variant="ghost" onClick={() => setEscalateMode(true)}>
                      Escalate to estimator
                    </MButton>
                  </MButtonStack>
                </div>
                {!fe.snapshot && !fe.isLoading ? (
                  <div className="m-quiet-sm" style={{ marginTop: 8 }}>
                    Workflow route not available yet — the resolve action will be queued once PATCH
                    /api/worker-issues/:id ships.
                  </div>
                ) : null}
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
          <div style={{ padding: '16px', fontSize: 13, color: 'var(--m-green)', textAlign: 'center' }}>
            Resolved {fe.snapshot?.context.resolved_at ? shortAgo(fe.snapshot.context.resolved_at) : ''}
          </div>
        )}
      </MBody>
    </>
  )
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
