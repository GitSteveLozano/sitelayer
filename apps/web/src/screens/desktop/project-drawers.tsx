/**
 * Owner desktop LIFECYCLE DRAWERS + MODALS (Desktop v2 · 12 / 04 / 03).
 *
 * Faithful ports of Steve's Desktop v2 mockup overlays, composed on the
 * already-built foundation primitives `DDrawer` / `DModal` (which own the
 * scrim / Escape / close-button) and `MButton` (the mockup's `.dt-btn`).
 * Each export is a thin wrapper that receives `{ open, onClose }` and renders
 * only the BODY content.
 *
 * The mockup's `--d-*` token system maps onto this repo's `--m-*` tokens:
 *   --d-ink/-2/-3/-4 → --m-ink/-2/-3/-4 ·  --d-sand → --m-card ·
 *   --d-sand-soft → --m-card-soft ·  --d-line-soft → --m-line-2 ·
 *   --d-accent(-ink) → --m-accent(-ink) ·  --d-good → --m-green ·
 *   --d-bad → --m-red ·  --d-f-tight → --m-font-display ·  --d-f-mono → --m-num.
 *
 * The numbers/labels are the mockup's demo data — these are presentational
 * surfaces; real data wiring is a later pass. Parent owns the open-state and
 * mounts each wrapper alongside its trigger.
 */
import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'
import { DDrawer, DModal } from '@/components/d'
import { MBanner, MButton, MInput, MSelect, MTextarea } from '@/components/m'
import { useCreateSchedule } from '@/lib/api/schedules'
import {
  useChangeOrderEvent,
  useCreateChangeOrder,
  useProjectChangeOrders,
  type ChangeOrder,
} from '@/lib/api/change-orders'
import { ApiError, useCreateEstimatePush } from '@/lib/api'
import { useBillingMilestones, useCreateBillingMilestones, type BillingMilestone } from '@/lib/api/billing-milestones'
import { useProjectLaborVariance } from '@/lib/api/labor-variance'
import { useProjectCloseoutSummary } from '@/lib/api/closeout-summary'
import { formatMoney } from '../mobile/format.js'

interface OverlayProps {
  open: boolean
  onClose: () => void
}

// ---- shared inline-style helpers -----------------------------------------
const mono = (extra?: CSSProperties): CSSProperties => ({ fontFamily: 'var(--m-num)', ...extra })
const display = (extra?: CSSProperties): CSSProperties => ({ fontFamily: 'var(--m-font-display)', ...extra })
const sectionLabel: CSSProperties = {
  fontFamily: 'var(--m-num)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--m-ink-3)',
  letterSpacing: '0.06em',
}

/** Section bar used as the head of the invoice / send / new-* modals (the
 * mockup's `.dt-float-head`). Passed as `DModal`'s `title`. */
function FloatHead({ children }: { children: ReactNode }) {
  return (
    <span
      className="num"
      style={mono({ fontWeight: 800, fontSize: 12, letterSpacing: '0.06em', textTransform: 'uppercase' })}
    >
      {children}
    </span>
  )
}

// ============================================================
// Lifecycle drawers (12_app.js · DRecoveryDrawer / DChangeOrderDrawer /
// DPostMortemDrawer)
// ============================================================

/** F1a · Recovery actions ranked from the project's real labor-variance,
 * opened off an at-risk margin guardrail. Deterministic heuristic over the
 * worst over-budget cost codes — honest, demoable, zero AI spend. */
export function RecoveryDrawer({
  open,
  onClose,
  projectId,
  daysLeft,
  bidTotal,
  laborRate,
  spent,
}: OverlayProps & { projectId: string; daysLeft: number; bidTotal: number; laborRate: number; spent: number }) {
  const variance = useProjectLaborVariance(open ? projectId : undefined)
  const rows = variance.data?.variance ?? []
  const marginPct = bidTotal > 0 ? Math.round(((bidTotal - spent) / bidTotal) * 100) : null

  const actions = rows
    .filter((r) => r.hours_variance_pct > 10 && r.actual_hours > r.estimated_hours)
    .sort((a, b) => b.hours_variance_pct - a.hours_variance_pct)
    .slice(0, 3)
    .map((r, i) => {
      const overrunHours = Math.max(0, r.actual_hours - r.estimated_hours)
      const overrunDollars = overrunHours * laborRate
      const marginGain = Math.min(12, Math.max(1, Math.round(bidTotal > 0 ? (overrunDollars / bidTotal) * 100 : 1)))
      return {
        n: i + 1,
        label: `Cap labor on ${r.service_item_code}${r.division_code ? ` · ${r.division_code}` : ''}`,
        sub: `${Math.round(r.hours_variance_pct)}% over est · trim ${formatMoney(overrunDollars)} labor`,
        margin: `+${marginGain}%`,
      }
    })

  return (
    <DDrawer open={open} onClose={onClose} tone="bad" title="● RECOVERY PLAN · LABOR OVER">
      {variance.isPending && open ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 })}>Analyzing margin…</div>
      ) : variance.isError ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-red)', fontWeight: 600 })}>
          Could not build a recovery plan.
        </div>
      ) : actions.length === 0 ? (
        <>
          <div style={display({ fontWeight: 800, fontSize: 24, lineHeight: 1, letterSpacing: '-0.02em' })}>
            No corrective actions needed.
          </div>
          <div style={mono({ fontSize: 11, color: 'var(--m-ink-3)', marginTop: 8, fontWeight: 600 })}>
            {daysLeft} DAYS LEFT · MARGIN {marginPct != null ? `${marginPct}%` : '—'} · HOLDING PACE
          </div>
        </>
      ) : (
        <>
          <div style={display({ fontWeight: 800, fontSize: 24, lineHeight: 1, letterSpacing: '-0.02em' })}>
            {actions.length} ranked action{actions.length === 1 ? '' : 's'}.
          </div>
          <div style={mono({ fontSize: 11, color: 'var(--m-ink-3)', marginTop: 8, fontWeight: 600 })}>
            {daysLeft} DAYS LEFT · MARGIN {marginPct != null ? `${marginPct}%` : '—'} · RECOVERABLE
          </div>
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {actions.map((a) => (
              <div
                key={a.n}
                style={{
                  padding: 14,
                  border: '2px solid var(--m-ink)',
                  display: 'flex',
                  gap: 12,
                  alignItems: 'flex-start',
                }}
              >
                <div
                  style={display({
                    width: 32,
                    height: 32,
                    background: 'var(--m-accent)',
                    color: 'var(--m-accent-ink)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: 800,
                    fontSize: 14,
                    flexShrink: 0,
                  })}
                >
                  {a.n}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{a.label}</div>
                  <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 3, fontWeight: 600 })}>
                    {a.sub}
                  </div>
                  <div style={mono({ fontSize: 11, color: 'var(--m-green)', marginTop: 5, fontWeight: 800 })}>
                    MARGIN {a.margin}
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* TODO(recovery-accept): optionally snooze the project's margin guardrail on accept. */}
          <MButton variant="primary" style={{ width: '100%', marginTop: 20 }} onClick={onClose}>
            ACCEPT PLAN · TRACK
          </MButton>
        </>
      )}
    </DDrawer>
  )
}

const CHANGE_ORDER_STATES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED'] as const

/** F1b · Change-order value delta + DRAFT/SENT/ACCEPTED/REJECTED state strip,
 * bound to the project's real change orders (latest CO + author-new composer). */
export function ChangeOrderDrawer({ open, projectId, onClose }: OverlayProps & { projectId: string }) {
  const query = useProjectChangeOrders(projectId, { enabled: open && Boolean(projectId) })
  const createMutation = useCreateChangeOrder(projectId)
  const eventMutation = useChangeOrderEvent(projectId)

  const cos = query.data?.change_orders ?? []
  const latest = cos[0] ?? null
  const deltaNum = latest ? Number(latest.value_delta) : 0
  const scheduleImpact = latest && latest.schedule_impact_days != null ? Number(latest.schedule_impact_days) : null

  const [composing, setComposing] = useState(false)
  const [description, setDescription] = useState('')
  const [valueDelta, setValueDelta] = useState('')
  const [scheduleDays, setScheduleDays] = useState('')

  const errorMessage =
    createMutation.error instanceof Error
      ? createMutation.error.message
      : eventMutation.error instanceof Error
        ? eventMutation.error.message
        : null

  function resetComposer() {
    setComposing(false)
    setDescription('')
    setValueDelta('')
    setScheduleDays('')
  }

  function submitCreate() {
    const desc = description.trim()
    if (!desc) return
    const delta = Number(valueDelta)
    if (!Number.isFinite(delta)) return
    const days = scheduleDays.trim() === '' ? undefined : Number(scheduleDays)
    createMutation.mutate(
      {
        description: desc,
        value_delta: delta,
        ...(days !== undefined && Number.isFinite(days) ? { schedule_impact_days: days } : {}),
      },
      { onSuccess: resetComposer },
    )
  }

  function dispatch(co: ChangeOrder, event: 'SEND' | 'ACCEPT' | 'REJECT' | 'VOID') {
    let reason: string | undefined
    if (event === 'REJECT') {
      const entered = window.prompt('Rejection reason (optional):') ?? ''
      reason = entered.trim() === '' ? undefined : entered.trim()
    }
    eventMutation.mutate({ id: co.id, event, stateVersion: co.state_version, ...(reason ? { reason } : {}) })
  }

  const showComposer = composing || cos.length === 0
  const title = showComposer
    ? '+ CHANGE ORDER · NEW'
    : latest
      ? `+ CHANGE ORDER · CO-${String(latest.number).padStart(3, '0')}`
      : '+ CHANGE ORDER'

  return (
    <DDrawer open={open} onClose={onClose} title={title}>
      {errorMessage ? (
        <div style={{ marginBottom: 14 }}>
          <MBanner tone="error" title="Couldn't save that change" body={errorMessage} />
        </div>
      ) : null}

      {query.isPending && open ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 })}>Loading change orders…</div>
      ) : query.isError ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-red)', fontWeight: 600 })}>Could not load change orders.</div>
      ) : showComposer ? (
        <>
          <div style={sectionLabel}>WHAT CHANGED</div>
          <MTextarea
            value={description}
            onChange={(e) => setDescription(e.currentTarget.value)}
            placeholder="e.g. Added stone veneer on south wall — 320 SF, client request."
            rows={3}
            style={{ marginTop: 8, width: '100%' }}
          />
          <div
            style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 12, marginTop: 14 }}
          >
            <div>
              <div style={sectionLabel}>VALUE DELTA ($)</div>
              <MInput
                value={valueDelta}
                onChange={(e) => setValueDelta(e.currentTarget.value)}
                inputMode="numeric"
                placeholder="5280"
                style={{ marginTop: 6, width: '100%' }}
              />
            </div>
            <div>
              <div style={sectionLabel}>SCHEDULE (DAYS)</div>
              <MInput
                value={scheduleDays}
                onChange={(e) => setScheduleDays(e.currentTarget.value)}
                inputMode="numeric"
                placeholder="0"
                style={{ marginTop: 6, width: '100%' }}
              />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <MButton
              variant="primary"
              style={{ flex: 1 }}
              onClick={submitCreate}
              disabled={createMutation.isPending || description.trim() === ''}
            >
              {createMutation.isPending ? 'Saving…' : 'Save draft'}
            </MButton>
            {cos.length > 0 ? (
              <MButton variant="ghost" onClick={resetComposer}>
                Cancel
              </MButton>
            ) : null}
          </div>
        </>
      ) : latest ? (
        <>
          <div style={sectionLabel}>WHAT CHANGED</div>
          <div
            style={{
              marginTop: 8,
              padding: 14,
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card-soft)',
              minHeight: 70,
              fontSize: 14,
              lineHeight: 1.5,
            }}
          >
            {latest.description}
          </div>

          <div style={{ ...sectionLabel, marginTop: 18 }}>VALUE DELTA</div>
          <div
            style={display({
              fontWeight: 800,
              fontSize: 44,
              marginTop: 6,
              color: deltaNum >= 0 ? 'var(--m-green)' : 'var(--m-red)',
            })}
          >
            {deltaNum >= 0 ? '+' : ''}
            {formatMoney(deltaNum)}
          </div>
          <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 4, fontWeight: 600 })}>
            {scheduleImpact != null && scheduleImpact !== 0
              ? `${scheduleImpact > 0 ? '+' : ''}${scheduleImpact}d SCHEDULE IMPACT`
              : 'NO SCHEDULE IMPACT'}
          </div>

          {/* state machine strip — the CO's real current state is highlighted */}
          <div style={{ display: 'flex', border: '2px solid var(--m-ink)', marginTop: 20 }}>
            {CHANGE_ORDER_STATES.map((s, i, arr) => {
              const current = s === latest.status.toUpperCase()
              return (
                <div
                  key={s}
                  style={mono({
                    flex: 1,
                    padding: '8px 0',
                    textAlign: 'center',
                    background: current ? 'var(--m-accent)' : 'transparent',
                    color: current ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                    borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                    fontSize: 8,
                    fontWeight: 800,
                  })}
                >
                  {s}
                </div>
              )
            })}
          </div>

          {/* actions driven by the CO's real state */}
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            {latest.status === 'draft' ? (
              <MButton
                variant="primary"
                style={{ flex: 1 }}
                onClick={() => dispatch(latest, 'SEND')}
                disabled={eventMutation.isPending}
              >
                Send to client
              </MButton>
            ) : null}
            {latest.status === 'sent' ? (
              <>
                <MButton
                  variant="primary"
                  style={{ flex: 1 }}
                  onClick={() => dispatch(latest, 'ACCEPT')}
                  disabled={eventMutation.isPending}
                >
                  Mark accepted
                </MButton>
                <MButton variant="ghost" onClick={() => dispatch(latest, 'REJECT')} disabled={eventMutation.isPending}>
                  Reject
                </MButton>
              </>
            ) : null}
            {latest.status === 'draft' || latest.status === 'sent' ? (
              <MButton variant="ghost" onClick={() => dispatch(latest, 'VOID')} disabled={eventMutation.isPending}>
                Void
              </MButton>
            ) : (
              <div
                style={mono({ flex: 1, fontSize: 11, color: 'var(--m-ink-3)', fontWeight: 600, alignSelf: 'center' })}
              >
                No further actions · {latest.status.toUpperCase()}
              </div>
            )}
          </div>

          <div style={{ marginTop: 14 }}>
            <MButton variant="ghost" onClick={() => setComposing(true)}>
              + New change order
            </MButton>
          </div>
        </>
      ) : null}
    </DDrawer>
  )
}

/** F1c · Final-margin + per-division variance lines + "next time" callout,
 * derived from the project's real closeout summary + labor variance. */
export function PostMortemDrawer({ open, onClose, projectId }: OverlayProps & { projectId: string }) {
  const closeout = useProjectCloseoutSummary(open ? projectId : undefined)
  const variance = useProjectLaborVariance(open ? projectId : undefined)

  const rawMargin = closeout.data?.margin_pct ?? null
  // margin_pct may arrive as a fraction (0.34) or a percent (34) — normalize.
  const marginPct = rawMargin == null ? null : Math.round(Math.abs(rawMargin) <= 1 ? rawMargin * 100 : rawMargin)
  const bid = closeout.data?.bid ?? null
  const totalActual = closeout.data?.total_actual ?? null

  // Per-division labor variance (real rows grouped by division).
  const byDivision = new Map<string, { est: number; act: number }>()
  for (const r of variance.data?.variance ?? []) {
    const key = r.division_code ?? 'Other'
    const d = byDivision.get(key) ?? { est: 0, act: 0 }
    d.est += r.estimated_hours
    d.act += r.actual_hours
    byDivision.set(key, d)
  }
  const lines = [...byDivision.entries()]
    .map(([label, d]) => {
      const pct = d.est > 0 ? Math.round(((d.act - d.est) / d.est) * 100) : 0
      return { label, pct, bad: pct > 0 }
    })
    .sort((a, b) => b.pct - a.pct)
  const worst = lines.find((l) => l.bad) ?? null

  const loading = (closeout.isPending || variance.isPending) && open
  const errored = closeout.isError || variance.isError

  return (
    <DDrawer open={open} onClose={onClose} title="● POST-MORTEM · CLOSED">
      {loading ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600 })}>Loading closeout…</div>
      ) : errored ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-red)', fontWeight: 600 })}>
          Could not load the post-mortem.
        </div>
      ) : (
        <>
          <div style={sectionLabel}>FINAL MARGIN</div>
          <div
            style={display({
              fontWeight: 800,
              fontSize: 52,
              marginTop: 6,
              color: marginPct != null && marginPct < 0 ? 'var(--m-red)' : 'var(--m-green)',
              lineHeight: 1,
            })}
          >
            {marginPct != null ? `${marginPct}%` : '—'}
          </div>
          <div style={mono({ fontSize: 11, color: 'var(--m-ink-2)', marginTop: 8, fontWeight: 600 })}>
            {bid != null ? `BID ${formatMoney(bid)}` : 'BID —'} ·{' '}
            {totalActual != null ? `ACTUAL ${formatMoney(totalActual)}` : 'ACTUAL —'}
          </div>

          {lines.length > 0 ? (
            <div style={{ marginTop: 20 }}>
              {lines.map((l) => (
                <div
                  key={l.label}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    padding: '10px 0',
                    borderBottom: '1px solid var(--m-line-2)',
                  }}
                >
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{l.label}</span>
                  <span className="num" style={{ fontSize: 14, color: l.bad ? 'var(--m-red)' : 'var(--m-green)' }}>
                    {l.pct > 0 ? '+' : ''}
                    {l.pct}%
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={mono({ fontSize: 11, color: 'var(--m-ink-3)', marginTop: 16, fontWeight: 600 })}>
              No labor-variance data for this job.
            </div>
          )}

          {worst ? (
            <div style={{ padding: 14, background: 'var(--m-accent)', marginTop: 18 }}>
              <div style={mono({ fontSize: 10, fontWeight: 700, color: 'var(--m-accent-ink)' })}>● NEXT TIME</div>
              <div
                style={mono({
                  fontSize: 11,
                  color: 'var(--m-accent-ink)',
                  marginTop: 8,
                  fontWeight: 600,
                  lineHeight: 1.5,
                })}
              >
                {worst.label.toUpperCase()} LABOR RAN {worst.pct}% OVER ESTIMATE. ADD A BUFFER ON SIMILAR JOBS.
              </div>
            </div>
          ) : null}
        </>
      )}
    </DDrawer>
  )
}

// ============================================================
// Invoice modal (12_app.js · DInvoiceModal)
// ============================================================

interface InvoiceModalProps {
  open: boolean
  onClose: () => void
  projectId: string
  projectName: string | null
  customerName: string | null
  contractValue: number
}

function milestoneStatusLabel(status: BillingMilestone['status']): string {
  if (status === 'paid') return '✓ PAID'
  if (status === 'invoiced') return '● INVOICED · NOT PAID'
  return '○ NOT YET'
}

/** G5 · Milestone billing list + NET 30 + send button, bound to the project's
 * real billing milestones (seed-on-empty + estimate_push send). */
export function InvoiceModal({
  open,
  onClose,
  projectId,
  projectName,
  customerName,
  contractValue,
}: InvoiceModalProps) {
  const milestonesQuery = useBillingMilestones(open ? projectId : null)
  const createMilestones = useCreateBillingMilestones(projectId)
  const createPush = useCreateEstimatePush()

  const milestones = milestonesQuery.data?.billing_milestones ?? []
  const activeId = milestones.find((m) => m.status !== 'paid')?.id ?? null
  const active = milestones.find((m) => m.id === activeId) ?? null
  const total =
    active?.amount != null
      ? Number(active.amount)
      : active?.pct != null
        ? (Number(active.pct) / 100) * contractValue
        : contractValue

  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  function seedLadder() {
    if (createMilestones.isPending) return
    setError(null)
    createMilestones.mutate(
      { contract_value: contractValue },
      { onError: (e) => setError(e instanceof Error ? e.message : 'Failed to seed milestones.') },
    )
  }

  function send() {
    if (createPush.isPending) return
    setError(null)
    // Seed a real schedule first if none exists (best-effort; a seed failure
    // must not block the load-bearing QBO push), mirroring invoice-quick.tsx.
    if (milestones.length === 0 && !createMilestones.isPending) {
      createMilestones.mutate({ contract_value: contractValue })
    }
    createPush.mutate(
      { projectId },
      {
        onSuccess: () => setSent(true),
        onError: (e) => {
          if (e instanceof ApiError && e.status === 400) {
            setError('This project has no estimate lines yet. Build/recompute the estimate before invoicing.')
            return
          }
          setError(e instanceof Error ? e.message : 'Failed to create the invoice.')
        },
      },
    )
  }

  const titleText = `INVOICE · ${(projectName ?? 'PROJECT').toUpperCase()}${
    customerName ? ` · ${customerName.toUpperCase()}` : ''
  }`

  return (
    <DModal
      open={open}
      onClose={onClose}
      title={<FloatHead>{titleText}</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" disabled title="Invoice PDF preview coming soon">
            PREVIEW
          </MButton>
          <MButton variant="primary" onClick={send} disabled={createPush.isPending || milestones.length === 0}>
            {createPush.isPending ? 'SENDING…' : `SEND · ${formatMoney(total)}`}
          </MButton>
        </div>
      }
    >
      {error ? (
        <div style={{ marginBottom: 12 }}>
          <MBanner tone="error" title="Couldn't send invoice" body={error} />
        </div>
      ) : null}
      {sent ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-green)', fontWeight: 700, marginBottom: 12 })}>
          ✓ Invoice push created.
        </div>
      ) : null}

      <div style={sectionLabel}>MILESTONE</div>
      {milestonesQuery.isPending && open ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600, marginTop: 8 })}>
          Loading billing schedule…
        </div>
      ) : milestonesQuery.isError ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-red)', fontWeight: 600, marginTop: 8 })}>
          Could not load billing schedule.
        </div>
      ) : milestones.length === 0 ? (
        <div style={{ marginTop: 8 }}>
          <div style={mono({ fontSize: 12, color: 'var(--m-ink-3)', fontWeight: 600, marginBottom: 10 })}>
            No billing schedule yet.
          </div>
          <MButton variant="ghost" onClick={seedLadder} disabled={createMilestones.isPending}>
            {createMilestones.isPending ? 'Seeding…' : 'Seed deposit / progress / final'}
          </MButton>
        </div>
      ) : (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {milestones.map((m) => {
            const onMilestone = m.id === activeId
            return (
              <div
                key={m.id}
                style={{
                  padding: '12px 14px',
                  border: '2px solid var(--m-ink)',
                  background: onMilestone ? 'var(--m-accent)' : 'transparent',
                  color: onMilestone ? 'var(--m-accent-ink)' : 'var(--m-ink)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>{m.label}</div>
                  <div style={mono({ fontSize: 9, marginTop: 3, fontWeight: 700, opacity: 0.7 })}>
                    {onMilestone && m.status !== 'paid' ? '● BILLING NOW' : milestoneStatusLabel(m.status)}
                  </div>
                </div>
                <span className="num" style={{ fontSize: 15, fontWeight: 700 }}>
                  {m.amount != null ? formatMoney(Number(m.amount)) : m.pct != null ? `${m.pct}%` : '—'}
                </span>
              </div>
            )
          })}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
        <div style={{ width: 18, height: 18, background: 'var(--m-accent)', border: '2px solid var(--m-ink)' }} />
        <span style={mono({ fontSize: 11, fontWeight: 600 })}>NET 30 · STRIPE LINK INCLUDED</span>
      </div>
    </DModal>
  )
}

// ============================================================
// Send + PDF-preview modals (04_app.js · DSendModal / DPdfPreviewModal)
// ============================================================

/** C1b · Send the bid to the client, with recipient + message + tracked link. */
export function SendModal({ open, onClose }: OverlayProps) {
  return (
    <DModal
      open={open}
      onClose={onClose}
      width={520}
      title={<FloatHead>SEND BID · $146,090</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={onClose}>
            CANCEL
          </MButton>
          <MButton variant="primary">SEND · NOTIFY JOHN</MButton>
        </div>
      }
    >
      <div style={sectionLabel}>TO</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginTop: 8,
          padding: '12px 14px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
        }}
      >
        <div
          style={display({
            width: 38,
            height: 38,
            background: 'var(--m-ink)',
            color: 'var(--m-card)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: 13,
          })}
        >
          JM
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>John Marchetti</div>
          <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 2, fontWeight: 600 })}>
            john@hillcresthomes.co
          </div>
        </div>
      </div>

      <div style={{ ...sectionLabel, marginTop: 18 }}>MESSAGE</div>
      <div
        style={{
          marginTop: 8,
          padding: 14,
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
          minHeight: 80,
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        John — bid attached for Phase 4. $146K, 7 line items. Happy to walk through.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
        <div style={{ width: 18, height: 18, background: 'var(--m-accent)', border: '2px solid var(--m-ink)' }} />
        <span style={mono({ fontSize: 11, fontWeight: 600 })}>INCLUDE SIGNED LINK · TRACK OPEN</span>
      </div>
    </DModal>
  )
}

const PDF_CONTENT_MODES: Array<{ label: string; on?: boolean }> = [
  { label: 'PLAN ONLY' },
  { label: 'WITH TAKEOFF', on: true },
  { label: 'CURRENT VIEW' },
]

/** C1a · PDF preview modal — content-mode rail + sheet list + page preview. */
export function PdfPreviewModal({ open, onClose }: OverlayProps) {
  return (
    <DModal
      open={open}
      onClose={onClose}
      width={880}
      title={<FloatHead>PDF PREVIEW · HILLCREST PH 4 · QUANTITIES</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost">DOWNLOAD</MButton>
          <MButton variant="primary">SEND TO CLIENT</MButton>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', minHeight: 460 }}>
        <div style={{ borderRight: '2px solid var(--m-ink)', background: 'var(--m-card-soft)', padding: 20 }}>
          <div style={{ ...sectionLabel, color: 'var(--m-ink-3)' }}>CONTENT</div>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PDF_CONTENT_MODES.map((t) => (
              <MButton
                key={t.label}
                variant={t.on ? 'primary' : 'ghost'}
                style={{ width: '100%', height: 40, fontSize: 12, justifyContent: 'flex-start' }}
              >
                {t.label}
              </MButton>
            ))}
          </div>
          <div style={{ ...sectionLabel, color: 'var(--m-ink-3)', marginTop: 24 }}>SHEETS · 22</div>
          <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 8, fontWeight: 600, lineHeight: 1.6 })}>
            ALL INCLUDED
            <br />
            A-101 · A-201..204
            <br />
            M-101..104 · …
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              flex: 1,
              background: 'var(--m-ink-2)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 40,
            }}
          >
            <div style={{ width: 240, height: 320, background: '#fff', border: '2px solid var(--m-ink)', padding: 16 }}>
              <div style={mono({ fontSize: 8, fontWeight: 700, color: 'var(--m-ink)' })}>HILLCREST PH 4 · TAKEOFF</div>
              <div style={display({ fontWeight: 800, fontSize: 14, marginTop: 4, color: 'var(--m-ink)' })}>
                QUANTITIES
              </div>
              <div style={{ marginTop: 14 }}>
                {['EPS · 4,785 SF', 'BASECOAT · 4,785 SF', 'STONE · 420 SF'].map((r) => (
                  <div
                    key={r}
                    style={mono({
                      fontSize: 8,
                      padding: '4px 0',
                      borderBottom: '1px dashed var(--m-line-2)',
                      color: 'var(--m-ink)',
                    })}
                  >
                    {r}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </DModal>
  )
}

// ============================================================
// New project + new assignment modals (03_app.js · DNewProjectModal /
// DNewAssignmentModal)
// ============================================================

const PROJECT_STARTING_STATES: Array<{ label: string; on?: boolean }> = [
  { label: 'BID', on: true },
  { label: 'PROJECT' },
  { label: 'LEAD' },
]

/** C1 · New-project kickoff modal — name, client, starting state, takeoff attach. */
export function NewProjectModal({ open, onClose }: OverlayProps) {
  return (
    <DModal
      open={open}
      onClose={onClose}
      title={<FloatHead>NEW PROJECT</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={onClose}>
            CANCEL
          </MButton>
          <MButton variant="primary">CREATE PROJECT</MButton>
        </div>
      }
    >
      <div style={sectionLabel}>PROJECT NAME</div>
      <div
        style={display({
          marginTop: 8,
          padding: '12px 14px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-card-soft)',
          fontWeight: 700,
          fontSize: 16,
        })}
      >
        Crestline North Annex
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, marginTop: 16 }}>
        <div>
          <div style={sectionLabel}>CLIENT</div>
          <div
            style={{
              marginTop: 8,
              padding: '12px 14px',
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card-soft)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>John Marchetti</span>
            <span style={display({ fontWeight: 800 })}>▾</span>
          </div>
          <div style={mono({ fontSize: 9, color: 'var(--m-green)', marginTop: 5, fontWeight: 700 })}>
            ✓ MATCHED IN QBO · NO DUPE
          </div>
        </div>
        <div>
          <div style={sectionLabel}>STARTING STATE</div>
          <div style={{ marginTop: 8, display: 'flex', border: '2px solid var(--m-ink)' }}>
            {PROJECT_STARTING_STATES.map((t, i, arr) => (
              <div
                key={t.label}
                style={mono({
                  flex: 1,
                  padding: '12px 0',
                  textAlign: 'center',
                  background: t.on ? 'var(--m-accent)' : 'transparent',
                  color: t.on ? 'var(--m-accent-ink)' : 'var(--m-ink-3)',
                  borderRight: i < arr.length - 1 ? '2px solid var(--m-ink)' : 'none',
                  fontSize: 9,
                  fontWeight: 700,
                })}
              >
                {t.label}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ ...sectionLabel, marginTop: 16 }}>BID FROM A TAKEOFF · OPTIONAL</div>
      <div
        style={{
          marginTop: 8,
          padding: '12px 14px',
          border: '2px solid var(--m-ink)',
          background: 'var(--m-accent)',
          color: 'var(--m-accent-ink)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>Crestline takeoff · 4,210 SF</div>
          <div style={mono({ fontSize: 9, marginTop: 2, fontWeight: 600 })}>SARAH · 2 DAYS AGO · $138K</div>
        </div>
        <span style={mono({ fontSize: 9, fontWeight: 800, border: '1.5px solid var(--m-ink)', padding: '3px 7px' })}>
          ATTACH
        </span>
      </div>
    </DModal>
  )
}

/** Minimal project shape the assignment composer needs — the bootstrap
 * `projects` rows satisfy this structurally (id + name). */
export interface AssignmentProjectOption {
  id: string
  name: string
}

/** YYYY-MM-DD for today (local), the default `scheduled_for`. */
function assignmentDefaultDate(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}

/**
 * C3 · New-assignment composer — a real schedule-create form. Picks a
 * project + a working date and an optional crew note/size, then POSTs
 * /api/schedules (via `useCreateSchedule`) to drop a draft crew assignment
 * onto the week. Mirrors the schedule-create pattern in fm-confirm-day.tsx
 * (ensure a schedule row exists for project + date). The crew note is
 * carried as a single descriptive crew entry so the size shows on the grid.
 */
export function NewAssignmentModal({
  open,
  onClose,
  projects = [],
  onSaved,
}: OverlayProps & { projects?: AssignmentProjectOption[]; onSaved?: () => void }) {
  const createSchedule = useCreateSchedule()

  const [projectId, setProjectId] = useState('')
  const [scheduledFor, setScheduledFor] = useState(assignmentDefaultDate)
  const [crewNote, setCrewNote] = useState('')
  const [crewSize, setCrewSize] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Default the project to the first available once the list arrives / opens.
  if (open && !projectId && projects.length > 0) {
    setProjectId(projects[0]!.id)
  }

  function reset() {
    setCrewNote('')
    setCrewSize('')
    setError(null)
    setSaved(false)
  }

  function close() {
    reset()
    onClose()
  }

  function save() {
    if (createSchedule.isPending) return
    if (!projectId) {
      setError('Pick a project first.')
      return
    }
    if (!scheduledFor) {
      setError('Pick a date for the assignment.')
      return
    }
    setError(null)
    // Build a crew jsonb array: one descriptive entry per the typed crew
    // size (default 1), tagged with the optional note so the grid's crew
    // count reflects the booking. The API stores `crew` opaquely.
    const size = Math.max(1, Math.min(99, Math.round(Number(crewSize) || 1)))
    const note = crewNote.trim()
    const crew = Array.from({ length: size }, (_, i) => ({
      slot: i + 1,
      ...(note ? { note } : {}),
    }))
    createSchedule.mutate(
      { project_id: projectId, scheduled_for: scheduledFor, crew },
      {
        onSuccess: () => {
          setSaved(true)
          onSaved?.()
          // Brief success flash, then close + reset.
          window.setTimeout(close, 600)
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not create the assignment.'),
      },
    )
  }

  const noProjects = projects.length === 0
  const inputStyle: CSSProperties = {
    marginTop: 8,
    width: '100%',
    padding: '12px 14px',
    border: '2px solid var(--m-ink)',
    background: 'var(--m-card-soft)',
    fontFamily: 'var(--m-num)',
    fontSize: 15,
    fontWeight: 700,
    color: 'var(--m-ink)',
  }

  return (
    <DModal
      open={open}
      onClose={close}
      title={<FloatHead>NEW ASSIGNMENT</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={close} disabled={createSchedule.isPending}>
            CANCEL
          </MButton>
          <MButton variant="primary" onClick={save} disabled={createSchedule.isPending || noProjects || !projectId}>
            {createSchedule.isPending ? 'SAVING…' : 'SAVE · NOTIFY CREW'}
          </MButton>
        </div>
      }
    >
      {error ? (
        <div style={{ marginBottom: 12 }}>
          <MBanner tone="error" title="Couldn't book the crew" body={error} />
        </div>
      ) : null}
      {saved ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-green)', fontWeight: 700, marginBottom: 12 })}>
          ✓ Assignment booked.
        </div>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14 }}>
        <div>
          <div style={sectionLabel}>PROJECT</div>
          <MSelect
            value={projectId}
            onChange={(e) => setProjectId(e.currentTarget.value)}
            disabled={noProjects}
            style={{ marginTop: 8, width: '100%' }}
          >
            {noProjects ? <option value="">No projects available</option> : null}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </MSelect>
        </div>
        <div>
          <div style={sectionLabel}>DATE</div>
          <input
            type="date"
            value={scheduledFor}
            onChange={(e) => setScheduledFor(e.currentTarget.value)}
            style={inputStyle}
          />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px', gap: 14, marginTop: 16 }}>
        <div>
          <div style={sectionLabel}>CREW NOTE · OPTIONAL</div>
          <MInput
            value={crewNote}
            onChange={(e) => setCrewNote(e.currentTarget.value)}
            placeholder="e.g. EPS East — anchor + plate"
            style={{ marginTop: 8, width: '100%' }}
          />
        </div>
        <div>
          <div style={sectionLabel}>CREW SIZE</div>
          <MInput
            value={crewSize}
            onChange={(e) => setCrewSize(e.currentTarget.value)}
            inputMode="numeric"
            placeholder="3"
            style={{ marginTop: 8, width: '100%' }}
          />
        </div>
      </div>

      <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 14, fontWeight: 600, lineHeight: 1.5 })}>
        Books a draft assignment on the week. The foreman confirms crew + hours from the field.
      </div>
    </DModal>
  )
}
