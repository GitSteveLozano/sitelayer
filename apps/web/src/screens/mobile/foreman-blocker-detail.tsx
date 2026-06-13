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
import { MBanner, MBody, MButton, MButtonStack, MI, MSectionH, MTextarea, MTopBar } from '../../components/m/index.js'
import { DEyebrow, DErrorState, DH1, DLoadingState } from '../../components/d/index.js'
import {
  useFieldEvent,
  type FieldEventResolutionAction,
  type FieldEventSnapshotContext,
} from '../../machines/field-event.js'
import { useIsDesktop } from '../../lib/use-is-desktop.js'
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

/**
 * Responsive Foreman blocker / field-event detail. Folds the former
 * `screens/desktop/fm-blocker-detail.tsx` (`FmBlockerDetail`) and this mobile
 * screen into ONE file. The desktop chrome mounts at >=1024px; the mobile
 * surface — the WORKING resolve flow whose copy/placeholders/buttons the unit
 * test (`foreman-blocker-detail.test.tsx`) and the `foreman-field-event` e2e
 * assert on — mounts below it and is kept BYTE-FOR-BYTE as the base. Both
 * compositions reuse the SAME headless `useFieldEvent` machine + the
 * server-computed `next_events`, so neither can ever offer a transition the
 * server would 409 on. Only ONE render mounts at a time.
 *
 * `useIsDesktop()` is SSR-safe and returns false without a `matchMedia` match
 * (jsdom / mobile shell), so the unit test + the e2e exercise the unchanged
 * mobile resolve path exactly as before this merge.
 */
export function ForemanBlockerDetail(props: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const isDesktop = useIsDesktop()
  return isDesktop ? (
    <FmBlockerDetail bootstrap={props.bootstrap} companySlug={props.companySlug} />
  ) : (
    <ForemanBlockerDetailMobile {...props} />
  )
}

export function ForemanBlockerDetailMobile({
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
  // Severity is now a typed column on the snapshot context. The
  // severityFromMessage fallback only kicks in for the legacy direct-fetch
  // path (which has no severity column on its DTO) when the workflow
  // snapshot hasn't loaded.
  const severity = ctx?.severity ?? severityFromMessage(message)
  // The persisted workflow state (server-computed) is the single source of
  // truth — never re-derived from columns here.
  const state = fe.snapshot?.state ?? (fallback?.resolved_at ? 'resolved' : 'open')
  // The set of events the server says are legal from this state. Buttons are
  // gated on this so the UI can never offer an event the server would 409.
  const actions = new Set((fe.snapshot?.next_events ?? []).map((e) => e.type))

  const worker = bootstrap?.workers.find((x) => x.id === workerId)
  const project = bootstrap?.projects.find((x) => x.id === projectId)

  const [action, setAction] = useState<FieldEventResolutionAction>('order_more')
  const [reply, setReply] = useState('')
  const [escalateMode, setEscalateMode] = useState(false)
  const [escalateReason, setEscalateReason] = useState('')
  const [dismissMode, setDismissMode] = useState(false)

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

  const handleDismiss = () => {
    fe.dispatch({ event: 'DISMISS' })
  }

  const handleReopen = () => {
    // REOPEN lands back on `open` and stays on the detail so the foreman can
    // re-decide; clear any in-flight sub-mode so the resolve form is fresh.
    setDismissMode(false)
    setEscalateMode(false)
    fe.dispatch({ event: 'REOPEN' })
  }

  // Auto-navigate back when the snapshot lands in a terminal-ish state after
  // a successful submit. REOPEN (which lands on `open`) intentionally stays
  // on the detail so the foreman can re-decide.
  useEffect(() => {
    if (!fe.snapshot) return
    const s = fe.snapshot.state
    if (s === 'resolved' || s === 'escalated' || s === 'dismissed') {
      const t = window.setTimeout(() => navigate('/field'), 600)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [fe.snapshot, navigate])

  const sevTone = severity === 'stopped' ? 'red' : severity === 'slowing' ? 'amber' : 'blue'
  const isMaterials = ctx?.kind === 'materials_out'

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
              color:
                state === 'resolved'
                  ? 'var(--m-green)'
                  : state === 'escalated'
                    ? 'var(--m-amber)'
                    : state === 'dismissed'
                      ? 'var(--m-ink-3)'
                      : sevTone === 'red'
                        ? 'var(--m-red)'
                        : sevTone === 'amber'
                          ? 'var(--m-amber)'
                          : 'var(--m-ink-3)',
            }}
          >
            ● {state === 'open' ? (severity ?? 'open').toUpperCase() : state.toUpperCase()} ·{' '}
            {worker?.name?.toUpperCase() ?? 'UNKNOWN WORKER'}
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
            style={{
              marginTop: 10,
              color: 'var(--m-ink-3)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              alignItems: 'center',
            }}
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
                  style={{ width: '100%', maxHeight: 320, objectFit: 'cover' }}
                />
              ))}
            </div>
          ) : null}
        </div>

        {state === 'open' ? (
          <>
            {/* Material-fulfillment hero — for an out-of-materials blocker the
             *  foreman wants the quantity/material front-and-centre before the
             *  generic picker. We surface the worker's own free text (which is
             *  where the material + qty live today; there's no structured
             *  column yet) plus an inert yard-stock slot that no-ops until an
             *  inventory feed is wired. Lifecycle is unchanged — this is pure
             *  content presentation, not a new transition. */}
            {isMaterials ? (
              <>
                <MaterialHero
                  fallbackLabel={cleanedMessage}
                  materialLabel={ctx?.material_label ?? null}
                  quantity={ctx?.material_quantity ?? null}
                  unit={ctx?.material_unit ?? null}
                />
                <YardStockCard materialLabel={ctx?.material_label ?? cleanedMessage} />
              </>
            ) : null}
            {!escalateMode && !dismissMode ? (
              <>
                <MSectionH>{isMaterials ? 'How to fulfill · pick one' : 'Resolve · pick one'}</MSectionH>
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
                          <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 15 }}>
                            {opt.label}
                          </div>
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
                  <div
                    className="m-topbar-eyebrow"
                    style={{ marginTop: 12, textAlign: 'center', color: 'var(--m-ink-3)', fontWeight: 600 }}
                  >
                    ● {worker?.name?.toUpperCase() ?? 'WORKER'} AUTO-NOTIFIED ON RESOLVE
                  </div>
                </div>
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
            ) : (
              <>
                <MSectionH>Dismiss this event?</MSectionH>
                <div style={{ color: 'var(--m-ink-3)', fontSize: 14, lineHeight: 1.5, padding: '4px 0 4px' }}>
                  No reply is sent to the worker and the estimator isn't looped in. The event stays as the audit trail
                  and can be reopened later.
                </div>
                <div style={{ marginTop: 16 }}>
                  <MButtonStack>
                    <MButton variant="primary" onClick={handleDismiss} disabled={fe.isSubmitting || !fe.snapshot}>
                      {fe.isSubmitting ? 'Dismissing…' : 'Dismiss event'}
                    </MButton>
                    <MButton variant="ghost" onClick={() => setDismissMode(false)}>
                      Back
                    </MButton>
                  </MButtonStack>
                </div>
              </>
            )}
          </>
        ) : (
          <FieldEventClosedStrip
            state={state}
            ctx={ctx ?? null}
            canReopen={actions.has('REOPEN')}
            isSubmitting={fe.isSubmitting}
            onReopen={handleReopen}
          />
        )}
      </MBody>
    </>
  )
}

/**
 * Closed-state strip for resolved / escalated / dismissed. Mirrors the old
 * resolved confirmation but is now state-aware and drives a Reopen button off
 * the server-computed next_events (REOPEN is legal from every closed state).
 */
function FieldEventClosedStrip({
  state,
  ctx,
  canReopen,
  isSubmitting,
  onReopen,
}: {
  state: 'resolved' | 'escalated' | 'dismissed'
  ctx: FieldEventSnapshotContext | null
  canReopen: boolean
  isSubmitting: boolean
  onReopen: () => void
}) {
  const tone = state === 'resolved' ? 'var(--m-green)' : state === 'escalated' ? 'var(--m-amber)' : 'var(--m-ink-3)'
  const label = state === 'resolved' ? 'RESOLVED' : state === 'escalated' ? 'ESCALATED TO ESTIMATOR' : 'DISMISSED'
  const when =
    state === 'resolved' ? ctx?.resolved_at : state === 'escalated' ? ctx?.escalated_to_estimator_at : ctx?.dismissed_at
  return (
    <div style={{ marginTop: 8 }}>
      <div className="m-topbar-eyebrow" style={{ padding: '16px', color: tone, textAlign: 'center', fontWeight: 800 }}>
        ● {label} {when ? shortAgo(when).toUpperCase() : ''}
      </div>
      {state === 'escalated' && ctx?.escalation_reason ? (
        <div style={{ padding: '0 16px 8px', color: 'var(--m-ink-3)', fontSize: 14, lineHeight: 1.5 }}>
          “{ctx.escalation_reason}”
        </div>
      ) : null}
      {canReopen ? (
        <div style={{ marginTop: 8 }}>
          <MButtonStack>
            <MButton variant="ghost" onClick={onReopen} disabled={isSubmitting}>
              {isSubmitting ? 'Reopening…' : 'Reopen'}
            </MButton>
          </MButtonStack>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Split a free-text material request into a leading quantity + unit and the
 * remaining spec, so we can render the design's big-number quantity hero
 * ("12 SHEETS" over "EPS INSULATION · 1.5" · 4'x8'") instead of one undifferentiated
 * string. There's no structured material column yet, so this is a best-effort
 * parse of the worker's own words — when no leading quantity is present we fall
 * back to showing the whole label as the headline.
 */
/** Render a typed numeric quantity for the hero. `String` already drops a
 *  spurious `.0` (12 → "12") while keeping real fractions (12.5 → "12.5"). */
function formatQuantity(n: number): string {
  return String(n)
}

function parseMaterialNeed(label: string): { amount: string | null; unit: string | null; spec: string } {
  const trimmed = label.trim()
  // Leading "<number> <word>" → quantity + unit (e.g. "12 sheets", "620 fasteners").
  const m = trimmed.match(/^(\d[\d.,]*)\s+([A-Za-z]+)\b[\s·,-]*(.*)$/)
  if (m) {
    return { amount: m[1] ?? null, unit: (m[2] ?? '').toUpperCase(), spec: (m[3] ?? '').trim() }
  }
  return { amount: null, unit: null, spec: trimmed }
}

/**
 * Material-fulfillment hero — surfaces the worker's material/quantity request
 * prominently for a materials_out blocker, mirroring the design's quantity hero
 * (big amount + unit, with the material spec beneath).
 *
 * Prefers the typed structured columns captured at create (migration 126:
 * material_quantity / material_unit / material_label). Falls back to parsing
 * the worker's free-text message for legacy rows (and rows where the worker
 * skipped the structured fields), so the design affordance renders regardless
 * of which path produced the row.
 */
function MaterialHero({
  fallbackLabel,
  materialLabel,
  quantity,
  unit,
}: {
  fallbackLabel: string
  materialLabel: string | null
  quantity: number | null
  unit: string | null
}) {
  // Typed columns win when present; otherwise best-effort parse the prose.
  const parsed = parseMaterialNeed(fallbackLabel)
  const amount = quantity !== null ? formatQuantity(quantity) : parsed.amount
  const heroUnit = unit ? unit.toUpperCase() : parsed.unit
  const spec = materialLabel ?? parsed.spec
  if (!amount && !spec) return null
  return (
    <div className="m-card" style={{ marginTop: 12, background: 'var(--m-accent)', color: 'var(--m-accent-ink)' }}>
      <div className="m-topbar-eyebrow" style={{ fontWeight: 800 }}>
        NEEDS
      </div>
      {amount ? (
        <>
          <div style={{ marginTop: 6, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: 'var(--m-font-display)', fontWeight: 800, fontSize: 48, lineHeight: 1 }}>
              {amount}
            </span>
            {heroUnit ? (
              <span style={{ fontFamily: 'var(--m-num)', fontWeight: 700, fontSize: 18, letterSpacing: '0.04em' }}>
                {heroUnit}
              </span>
            ) : null}
          </div>
          {spec ? (
            <div
              className="m-topbar-eyebrow"
              style={{ marginTop: 8, fontWeight: 700, letterSpacing: '0.06em', opacity: 0.85 }}
            >
              {spec.toUpperCase()}
            </div>
          ) : null}
        </>
      ) : (
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 800,
            fontSize: 24,
            lineHeight: 1.1,
            marginTop: 6,
          }}
        >
          {spec}
        </div>
      )}
    </div>
  )
}

/**
 * Yard-stock availability slot. Inert until an inventory read-model is wired —
 * it renders nothing when there's no match. Gives the design's "4 on hand"
 * affordance a typed home without inventing a feed here.
 */
function YardStockCard({ materialLabel }: { materialLabel: string }) {
  // No inventory feed wired yet: no-op. Kept as the typed extension point.
  void materialLabel
  return null
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

// ---------------------------------------------------------------------------
// Desktop composition — the former screens/desktop/fm-blocker-detail.tsx
// (`FmBlockerDetail`), folded in verbatim (data + behavior preserved). It is
// the desktop consumer of the SAME headless `useFieldEvent` machine; buttons
// are driven off the server-computed `next_events` so the UI can never offer a
// transition the server would 409. `RESOLUTION_OPTIONS_DESKTOP` is the desktop
// label-only picker (no icons), suffixed to avoid colliding with the mobile
// module-scope `RESOLUTION_OPTIONS`. Routed at `/desktop/fm/blocker/:issueId`.
// ---------------------------------------------------------------------------

const RESOLUTION_OPTIONS_DESKTOP: ReadonlyArray<{ id: FieldEventResolutionAction; label: string }> = [
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
                {RESOLUTION_OPTIONS_DESKTOP.map((opt) => (
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
