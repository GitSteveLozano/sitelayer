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
import { useCreateChangeOrder, useProjectChangeOrders } from '@/lib/api/change-orders'
import { useChangeOrder } from '@/machines/change-order'
import { CHANGE_ORDER_ALL_STATES } from '@sitelayer/workflows'
import { ApiError, useCreateEstimatePush } from '@/lib/api'
import { useBillingMilestones, useCreateBillingMilestones, type BillingMilestone } from '@/lib/api/billing-milestones'
import { useProjectLaborVariance } from '@/lib/api/labor-variance'
import { useProjectCloseoutSummary } from '@/lib/api/closeout-summary'
import { getActiveCompanySlug } from '@/lib/api/client'
import { useProjectCloseoutMachine } from '@/machines/project-closeout'
import { formatMoney, shortDate } from '../mobile/format.js'

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

  const recoveryTitle = `● RECOVERY PLAN · LABOR ${marginPct != null ? `${marginPct >= 0 ? '+' : ''}${marginPct}%` : 'OVER'}`

  return (
    <DDrawer open={open} onClose={onClose} tone="bad" title={recoveryTitle}>
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
            AI ranked {actions.length} action{actions.length === 1 ? '' : 's'}.
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

/** F1b · Change-order value delta + DRAFT/SENT/ACCEPTED/REJECTED/VOIDED state strip,
 * bound to the project's real change orders (latest CO + author-new composer). */
export function ChangeOrderDrawer({ open, projectId, onClose }: OverlayProps & { projectId: string }) {
  const query = useProjectChangeOrders(projectId, { enabled: open && Boolean(projectId) })
  const createMutation = useCreateChangeOrder(projectId)

  const cos = query.data?.change_orders ?? []
  const latest = cos[0] ?? null
  const deltaNum = latest ? Number(latest.value_delta) : 0
  const scheduleImpact = latest && latest.schedule_impact_days != null ? Number(latest.schedule_impact_days) : null

  // Route the latest CO's workflow events through the headless machine so the
  // drawer renders action buttons from the reducer's next_events (never a
  // hand-authored per-status ladder) and gets the 409/outOfSync handling for
  // free. The composer (create-draft) stays a resource POST below.
  const co = useChangeOrder(latest?.id ?? '')
  const liveStatus = co.snapshot?.state ?? latest?.status ?? null

  const [composing, setComposing] = useState(false)
  const [description, setDescription] = useState('')
  const [valueDelta, setValueDelta] = useState('')
  const [scheduleDays, setScheduleDays] = useState('')

  const errorMessage = createMutation.error instanceof Error ? createMutation.error.message : (co.error ?? null)

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

  function dispatchCoEvent(event: 'SEND' | 'ACCEPT' | 'REJECT' | 'VOID') {
    let reason: string | undefined
    if (event === 'REJECT') {
      const entered = window.prompt('Rejection reason (optional):') ?? ''
      reason = entered.trim() === '' ? undefined : entered.trim()
    }
    co.dispatch({ event, ...(reason ? { reason } : {}) })
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
            {CHANGE_ORDER_ALL_STATES.map((state, i, arr) => {
              const current = state === liveStatus
              return (
                <div
                  key={state}
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
                  {state.toUpperCase()}
                </div>
              )
            })}
          </div>

          {co.outOfSync ? (
            <div style={{ marginTop: 14 }}>
              <MBanner
                tone="warn"
                title="This change order changed on the server"
                body="It was reloaded to the latest state — review before acting again."
              />
            </div>
          ) : null}

          {/* actions driven by the reducer's next_events — no hand-authored
              per-status ladder. The first action reads as the primary CTA. */}
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            {(co.snapshot?.next_events ?? []).length > 0 ? (
              (co.snapshot?.next_events ?? []).map((ev, i) => (
                <MButton
                  key={ev.type}
                  variant={i === 0 ? 'primary' : 'ghost'}
                  style={i === 0 ? { flex: 1 } : undefined}
                  onClick={() => dispatchCoEvent(ev.type)}
                  disabled={co.isSubmitting || co.isLoading}
                >
                  {ev.label}
                </MButton>
              ))
            ) : (
              <div
                style={mono({ flex: 1, fontSize: 11, color: 'var(--m-ink-3)', fontWeight: 600, alignSelf: 'center' })}
              >
                No further actions · {(liveStatus ?? latest.status).toUpperCase()}
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
  // Mount the closeout workflow view-model so the drawer can record the
  // human post-mortem acknowledgement (completed → post_mortem) and show
  // the acknowledged date once it's terminal. The analytics body below
  // stays a sibling read-model; the workflow fact is the only state here.
  const workflow = useProjectCloseoutMachine(projectId, getActiveCompanySlug())
  const wfSnapshot = workflow.snapshot
  const ackEvent = wfSnapshot?.next_events.find((ev) => ev.type === 'ACKNOWLEDGE_POST_MORTEM')

  const rawMargin = closeout.data?.margin_pct ?? null
  // margin_pct may arrive as a fraction (0.34) or a percent (34) — normalize.
  // This is the DELIVERED margin: (bid − total_actual) / bid.
  const deliveredMarginPct =
    rawMargin == null ? null : Math.round(Math.abs(rawMargin) <= 1 ? rawMargin * 100 : rawMargin)
  const marginPct = deliveredMarginPct
  const bid = closeout.data?.bid ?? null
  const estimateTotal = closeout.data?.estimate_total ?? null
  // Planned (BID) margin from the estimate against the contract value:
  // (bid − estimate_total) / bid. Lets the summary line compare bid-vs-delivered.
  const bidMarginPct =
    bid != null && bid > 0 && estimateTotal != null ? Math.round(((bid - estimateTotal) / bid) * 100) : null
  // Verdict tag: delivered vs the bid plan (design's 'DEAD ON' / OVER / UNDER).
  const marginVerdict =
    bidMarginPct == null || deliveredMarginPct == null
      ? null
      : deliveredMarginPct === bidMarginPct
        ? 'DEAD ON'
        : deliveredMarginPct > bidMarginPct
          ? `+${deliveredMarginPct - bidMarginPct}PTS`
          : `${deliveredMarginPct - bidMarginPct}PTS`

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
            {bidMarginPct != null ? `BID ${bidMarginPct}%` : 'BID —'} ·{' '}
            {deliveredMarginPct != null ? `DELIVERED ${deliveredMarginPct}%` : 'DELIVERED —'}
            {marginVerdict ? ` · ${marginVerdict}` : ''}
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

          {/* Post-mortem acknowledgement — the one durable workflow fact
              this drawer owns. `completed` offers ACKNOWLEDGE_POST_MORTEM
              (closes the record); `post_mortem` shows the acknowledged
              date. 409s land in the machine's outOfSync banner. */}
          {wfSnapshot ? (
            <div style={{ marginTop: 20, borderTop: '1px solid var(--m-line-2)', paddingTop: 16 }}>
              {workflow.outOfSync ? (
                <div style={mono({ fontSize: 11, color: 'var(--m-amber)', fontWeight: 600, marginBottom: 10 })}>
                  Workflow state moved — reloaded. Review before acknowledging again.
                </div>
              ) : null}
              {wfSnapshot.state === 'post_mortem' ? (
                <div style={mono({ fontSize: 11, color: 'var(--m-ink-2)', fontWeight: 600 })}>
                  ● POST-MORTEM ACKNOWLEDGED
                  {wfSnapshot.context.post_mortem_acknowledged_at
                    ? ` · ${shortDate(wfSnapshot.context.post_mortem_acknowledged_at)}`
                    : ''}
                </div>
              ) : ackEvent ? (
                <MButton
                  variant="primary"
                  disabled={workflow.isSubmitting}
                  onClick={() => workflow.dispatch('ACKNOWLEDGE_POST_MORTEM')}
                >
                  {workflow.isSubmitting ? 'Closing record…' : 'Acknowledge & close record'}
                </MButton>
              ) : null}
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
  // customerName is part of the modal's call surface but the design header is
  // "INVOICE #n · PROJECT" only — no customer line — so it is intentionally
  // not rendered here.
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

  // Design header: "INVOICE #113 · HILLCREST PH 4" — invoice number + project.
  // There is no human invoice sequence in the schema, so derive a short stable
  // marker from the active milestone's estimate_push_id once it has actually
  // been pushed (e.g. "#3F2A"); otherwise omit the number and fall back to the
  // plain "INVOICE · {PROJECT}" form. Customer is dropped to match the design.
  const invoiceNo = active?.estimate_push_id
    ? `#${active.estimate_push_id
        .replace(/[^0-9a-f]/gi, '')
        .slice(-4)
        .toUpperCase()}`
    : null
  const titleText = `INVOICE${invoiceNo ? ` ${invoiceNo}` : ''} · ${(projectName ?? 'PROJECT').toUpperCase()}`

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

/** Derive 1-2 letter initials from a name (e.g. "John Marchetti" → "JM"). */
function clientInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  const first = parts[0] ?? ''
  if (parts.length === 1) return first.slice(0, 2).toUpperCase()
  const last = parts[parts.length - 1] ?? ''
  return ((first[0] ?? '') + (last[0] ?? '')).toUpperCase()
}

/**
 * C1b · Send the bid to the client, with recipient + message + tracked link.
 *
 * Wired (U01/D10): the composer collects a recipient email + name, an editable
 * message, and the INCLUDE SIGNED LINK · TRACK OPEN toggle, then `onSend`
 * creates an estimate SHARE (POST /api/projects/:id/estimate/share) — a private
 * signable portal link — NOT the QBO estimate-push. On success the parent
 * surfaces the generated `shareUrl`. Recipient + sell total are seeded from the
 * live project summary; the message pre-fills from the bid note and is editable.
 */
export function SendModal({
  open,
  onClose,
  clientName = 'Client',
  clientEmail,
  sellTotal,
  lineCount,
  projectLabel,
  sending = false,
  error = null,
  shareUrl = null,
  onSend,
}: OverlayProps & {
  clientName?: string | undefined
  clientEmail?: string | null | undefined
  sellTotal?: number | undefined
  lineCount?: number | undefined
  projectLabel?: string | undefined
  sending?: boolean | undefined
  error?: string | null | undefined
  /** Populated once the share has been created — the private portal link. */
  shareUrl?: string | null | undefined
  onSend?: ((payload: { recipientEmail: string; message: string; includeSignedLink: boolean }) => void) | undefined
}) {
  const defaultMessage = `${clientName.split(' ')[0] || clientName} — bid attached${
    projectLabel ? ` for ${projectLabel}` : ''
  }.${sellTotal != null ? ` ${formatMoney(sellTotal)},` : ''}${
    lineCount != null ? ` ${lineCount} line item${lineCount === 1 ? '' : 's'}.` : ''
  } Happy to walk through.`
  const [message, setMessage] = useState(defaultMessage)
  const [includeSignedLink, setIncludeSignedLink] = useState(true)
  const [recipientEmail, setRecipientEmail] = useState(clientEmail ?? '')
  // Re-seed the editable fields whenever the modal (re)opens against a
  // different project/total/recipient so it never shows stale composed copy.
  const [seededFor, setSeededFor] = useState<string | null>(null)
  const seedKey = `${open}:${defaultMessage}:${clientEmail ?? ''}`
  if (open && seededFor !== seedKey) {
    setSeededFor(seedKey)
    setMessage(defaultMessage)
    setRecipientEmail(clientEmail ?? '')
  }

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail.trim())
  const firstName = clientName.split(' ')[0] || clientName
  const sendLabel = sending ? 'Sending…' : `SEND · NOTIFY ${firstName.toUpperCase()}`

  return (
    <DModal
      open={open}
      onClose={onClose}
      width={520}
      title={<FloatHead>SEND BID{sellTotal != null ? ` · ${formatMoney(sellTotal)}` : ''}</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={onClose} disabled={sending}>
            {shareUrl ? 'DONE' : 'CANCEL'}
          </MButton>
          {shareUrl ? null : (
            <MButton
              variant="primary"
              disabled={sending || !onSend || !emailValid}
              onClick={() => onSend?.({ recipientEmail: recipientEmail.trim(), message, includeSignedLink })}
            >
              {sendLabel}
            </MButton>
          )}
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
            flexShrink: 0,
          })}
        >
          {clientInitials(clientName)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{clientName}</div>
          <MInput
            type="email"
            inputMode="email"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.currentTarget.value)}
            placeholder="client@email.com"
            aria-label="Recipient email"
            disabled={sending || Boolean(shareUrl)}
            style={{ marginTop: 6, width: '100%' }}
          />
        </div>
      </div>

      {shareUrl ? (
        <>
          <div style={{ ...sectionLabel, marginTop: 18, color: 'var(--m-green)' }}>✓ SHARE LINK CREATED</div>
          <div
            style={mono({
              marginTop: 8,
              padding: '12px 14px',
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card-soft)',
              fontSize: 11,
              fontWeight: 600,
              wordBreak: 'break-all',
              color: 'var(--m-ink-2)',
            })}
          >
            {shareUrl}
          </div>
        </>
      ) : (
        <>
          <div style={{ ...sectionLabel, marginTop: 18 }}>MESSAGE</div>
          <MTextarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            style={{ marginTop: 8, minHeight: 80, lineHeight: 1.5 }}
          />

          <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={includeSignedLink}
              onChange={(e) => setIncludeSignedLink(e.target.checked)}
              aria-label="Include signed link and track open"
              style={{
                width: 18,
                height: 18,
                accentColor: 'var(--m-accent)',
                border: '2px solid var(--m-ink)',
                margin: 0,
              }}
            />
            <span style={mono({ fontSize: 11, fontWeight: 600 })}>INCLUDE SIGNED LINK · TRACK OPEN</span>
          </label>
        </>
      )}

      {error ? (
        <div style={mono({ fontSize: 12, color: 'var(--m-red)', fontWeight: 600, marginTop: 12 })}>{error}</div>
      ) : null}
    </DModal>
  )
}

const PDF_CONTENT_MODES = [
  { key: 'plan', label: 'PLAN ONLY' },
  { key: 'takeoff', label: 'WITH TAKEOFF' },
  { key: 'current', label: 'CURRENT VIEW' },
] as const
type PdfContentMode = (typeof PDF_CONTENT_MODES)[number]['key']

/**
 * C1a · PDF preview modal — content-mode rail + sheet list + page preview.
 *
 * Wired (D10): the content-mode rail is now a real selection (WITH TAKEOFF
 * default), DOWNLOAD opens the estimate PDF (estimatePdfUrl) in a new tab, and
 * SEND TO CLIENT defers to the parent's send flow. Project label, sheet count,
 * and the preview's quantity rows come from the caller so the thumbnail
 * reflects the real project. The 240x320 thumbnail is a REPRESENTATIVE preview
 * (labelled "PREVIEW"), not the actual paginated render — DOWNLOAD produces the
 * real PDF; when no estimate lines exist yet it shows a neutral placeholder
 * rather than fabricated quantities.
 */
export function PdfPreviewModal({
  open,
  onClose,
  projectLabel,
  sheetCount,
  quantities,
  onDownload,
  onSendToClient,
}: OverlayProps & {
  projectLabel?: string | undefined
  sheetCount?: number | undefined
  quantities?: ReadonlyArray<{ label: string; value: string }> | undefined
  onDownload?: ((mode: PdfContentMode) => void) | undefined
  onSendToClient?: (() => void) | undefined
}) {
  const [mode, setMode] = useState<PdfContentMode>('takeoff')
  const headLabel = projectLabel ? projectLabel.toUpperCase() : 'QUANTITIES'
  return (
    <DModal
      open={open}
      onClose={onClose}
      width={880}
      title={<FloatHead>{`PDF PREVIEW · ${headLabel} · QUANTITIES`}</FloatHead>}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <MButton variant="ghost" onClick={() => onDownload?.(mode)} disabled={!onDownload}>
            DOWNLOAD
          </MButton>
          <MButton variant="primary" onClick={() => onSendToClient?.()} disabled={!onSendToClient}>
            SEND TO CLIENT
          </MButton>
        </div>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '220px minmax(0, 1fr)', minHeight: 460 }}>
        <div style={{ borderRight: '2px solid var(--m-ink)', background: 'var(--m-card-soft)', padding: 20 }}>
          <div style={{ ...sectionLabel, color: 'var(--m-ink-3)' }}>CONTENT</div>
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {PDF_CONTENT_MODES.map((t) => (
              <MButton
                key={t.key}
                variant={t.key === mode ? 'primary' : 'ghost'}
                onClick={() => setMode(t.key)}
                aria-pressed={t.key === mode}
                style={{ width: '100%', height: 40, fontSize: 12, justifyContent: 'flex-start' }}
              >
                {t.label}
              </MButton>
            ))}
          </div>
          <div style={{ ...sectionLabel, color: 'var(--m-ink-3)', marginTop: 24 }}>SHEETS · {sheetCount ?? '—'}</div>
          <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 8, fontWeight: 600, lineHeight: 1.6 })}>
            {sheetCount ? 'ALL SHEETS INCLUDED' : 'No sheets uploaded yet'}
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
            <div
              style={{ width: 240, height: 320, background: '#fff', border: '2px solid var(--m-ink)', padding: 16 }}
              aria-label="Estimate PDF preview (representative layout)"
            >
              <div
                style={mono({
                  fontSize: 8,
                  fontWeight: 700,
                  color: 'var(--m-ink-3)',
                  display: 'flex',
                  justifyContent: 'space-between',
                })}
              >
                <span>{headLabel} · TAKEOFF</span>
                <span>PREVIEW</span>
              </div>
              <div style={display({ fontWeight: 800, fontSize: 14, marginTop: 4, color: 'var(--m-ink)' })}>
                QUANTITIES
              </div>
              <div style={{ marginTop: 14 }}>
                {quantities && quantities.length > 0 ? (
                  quantities.map((q) => (
                    <div
                      key={`${q.label}-${q.value}`}
                      style={mono({
                        fontSize: 8,
                        padding: '4px 0',
                        borderBottom: '1px dashed var(--m-line-2)',
                        color: 'var(--m-ink)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 8,
                      })}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {q.label}
                      </span>
                      <span style={{ flexShrink: 0 }}>{q.value}</span>
                    </div>
                  ))
                ) : (
                  <div style={mono({ fontSize: 8, padding: '4px 0', color: 'var(--m-ink-3)' })}>
                    Build the estimate to preview quantities.
                  </div>
                )}
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

/** Minimal worker shape the crew multi-select needs — bootstrap `workers`
 * rows satisfy this structurally (id + name). */
export interface AssignmentCrewOption {
  id: string
  name: string
}

/** YYYY-MM-DD for today (local), the default `scheduled_for`. */
function assignmentDefaultDate(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}

const ASSIGN_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const

/** "MAY 7" / "MAY 7–9" range label for a start (+optional end) YYYY-MM-DD. */
function assignmentDatesLabel(startIso: string, endIso?: string): string {
  if (!startIso) return ''
  const s = new Date(`${startIso}T00:00:00`)
  if (Number.isNaN(s.getTime())) return ''
  const startLabel = `${ASSIGN_MONTHS[s.getMonth()]} ${s.getDate()}`
  if (!endIso || endIso === startIso) return startLabel
  const e = new Date(`${endIso}T00:00:00`)
  if (Number.isNaN(e.getTime()) || e.getTime() < s.getTime()) return startLabel
  // Same month → "MAY 7–9"; cross-month → "MAY 30 – JUN 2".
  if (e.getMonth() === s.getMonth()) return `${startLabel}–${e.getDate()}`
  return `${startLabel} – ${ASSIGN_MONTHS[e.getMonth()]} ${e.getDate()}`
}

/** Working-day (Mon–Fri) YYYY-MM-DD strings inclusive in [start, end]. */
function assignmentWorkingDays(startIso: string, endIso: string): string[] {
  const out: string[] = []
  const s = new Date(`${startIso}T00:00:00`)
  const e = new Date(`${endIso}T00:00:00`)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e.getTime() < s.getTime()) {
    return startIso ? [startIso] : []
  }
  const cur = new Date(s)
  // Cap the span to avoid an accidental runaway range.
  for (let i = 0; i < 28 && cur.getTime() <= e.getTime(); i += 1) {
    const dow = cur.getDay() // 0=Sun … 6=Sat
    if (dow >= 1 && dow <= 5) {
      const off = cur.getTimezoneOffset()
      out.push(new Date(cur.getTime() - off * 60_000).toISOString().slice(0, 10))
    }
    cur.setDate(cur.getDate() + 1)
  }
  return out.length > 0 ? out : [startIso]
}

/** True when any working day in the (inclusive) range is a Wednesday — the
 * presentational rain-forecast flag the schedule grid surfaces. */
function assignmentHasRainDay(days: string[]): boolean {
  return days.some((iso) => {
    const d = new Date(`${iso}T00:00:00`)
    return !Number.isNaN(d.getTime()) && d.getDay() === 3 // Wednesday
  })
}

/**
 * C3 · New-assignment composer — a real schedule-create form. Picks a
 * project, a working date range, a multi-select crew (named workers) and an
 * optional scope, then POSTs /api/schedules (via `useCreateSchedule`) for
 * each working day in the range to drop draft crew assignments onto the week.
 * Mirrors the schedule-create pattern in fm-confirm-day.tsx (ensure a
 * schedule row exists for project + date). The selected crew is carried as
 * the `crew` jsonb array so the count + names show on the grid.
 */
export function NewAssignmentModal({
  open,
  onClose,
  projects = [],
  crew: crewRoster = [],
  onSaved,
}: OverlayProps & {
  projects?: AssignmentProjectOption[]
  crew?: AssignmentCrewOption[]
  onSaved?: () => void
}) {
  const createSchedule = useCreateSchedule()

  const [projectId, setProjectId] = useState('')
  const [scheduledFor, setScheduledFor] = useState(assignmentDefaultDate)
  const [scheduledTo, setScheduledTo] = useState('')
  const [scope, setScope] = useState('')
  const [selectedCrew, setSelectedCrew] = useState<string[]>([])
  const [addingCrew, setAddingCrew] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Default the project to the first available once the list arrives / opens.
  if (open && !projectId && projects.length > 0) {
    setProjectId(projects[0]!.id)
  }

  function reset() {
    setScope('')
    setSelectedCrew([])
    setScheduledTo('')
    setAddingCrew(false)
    setError(null)
    setSaved(false)
  }

  function close() {
    reset()
    onClose()
  }

  function toggleCrew(id: string) {
    setSelectedCrew((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  // Working-day range + the dates label / rain flag derived from the picker.
  const workingDays = scheduledFor && open ? assignmentWorkingDays(scheduledFor, scheduledTo || scheduledFor) : []
  const datesLabel = assignmentDatesLabel(scheduledFor, scheduledTo || undefined)
  const rainFlagged = assignmentHasRainDay(workingDays)
  const rainDay = workingDays.find((iso) => {
    const d = new Date(`${iso}T00:00:00`)
    return !Number.isNaN(d.getTime()) && d.getDay() === 3
  })
  const rainLabel = rainDay ? assignmentDatesLabel(rainDay) : ''

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
    if (scheduledTo && scheduledTo < scheduledFor) {
      setError('The end date is before the start date.')
      return
    }
    setError(null)
    // Build the crew jsonb array from the selected named workers (the API
    // stores `crew` opaquely). When none are picked we book a single
    // unnamed slot so the grid still reflects the booking.
    const named = crewRoster.filter((w) => selectedCrew.includes(w.id))
    const scopeText = scope.trim()
    const crew =
      named.length > 0
        ? named.map((w) => ({ worker_id: w.id, name: w.name, ...(scopeText ? { scope: scopeText } : {}) }))
        : [{ slot: 1, ...(scopeText ? { scope: scopeText } : {}) }]

    const days = workingDays.length > 0 ? workingDays : [scheduledFor]
    let pending = days.length
    let failed = false
    for (const day of days) {
      createSchedule.mutate(
        { project_id: projectId, scheduled_for: day, crew },
        {
          onSuccess: () => {
            pending -= 1
            if (pending === 0 && !failed) {
              setSaved(true)
              onSaved?.()
              // Brief success flash, then close + reset.
              window.setTimeout(close, 600)
            }
          },
          onError: (e) => {
            if (!failed) {
              failed = true
              setError(e instanceof Error ? e.message : 'Could not create the assignment.')
            }
          },
        },
      )
    }
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
  const unselectedCrew = crewRoster.filter((w) => !selectedCrew.includes(w.id))

  return (
    <DModal
      open={open}
      onClose={close}
      title={<FloatHead>{datesLabel ? `NEW ASSIGNMENT · ${datesLabel}` : 'NEW ASSIGNMENT'}</FloatHead>}
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
          <div style={sectionLabel}>DATES</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="date"
              aria-label="Assignment start date"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.currentTarget.value)}
              style={inputStyle}
            />
            <span style={mono({ fontSize: 13, fontWeight: 800, color: 'var(--m-ink-3)', marginTop: 8 })}>–</span>
            <input
              type="date"
              aria-label="Assignment end date (optional)"
              value={scheduledTo}
              min={scheduledFor}
              onChange={(e) => setScheduledTo(e.currentTarget.value)}
              style={inputStyle}
            />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={sectionLabel}>CREW · MULTI-SELECT</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          {crewRoster
            .filter((w) => selectedCrew.includes(w.id))
            .map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => toggleCrew(w.id)}
                title="Remove from crew"
                style={mono({
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  padding: '8px 12px',
                  border: '2px solid var(--m-ink)',
                  background: 'var(--m-ink)',
                  color: 'var(--m-card)',
                  cursor: 'pointer',
                })}
              >
                {w.name}
              </button>
            ))}
          {addingCrew && unselectedCrew.length > 0 ? (
            <MSelect
              aria-label="Add crew member"
              value=""
              onChange={(e) => {
                const id = e.currentTarget.value
                if (id) toggleCrew(id)
                setAddingCrew(false)
              }}
              style={{ minWidth: 160 }}
            >
              <option value="">Pick a worker…</option>
              {unselectedCrew.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </MSelect>
          ) : (
            <button
              type="button"
              onClick={() => setAddingCrew(true)}
              disabled={unselectedCrew.length === 0}
              style={mono({
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                padding: '8px 12px',
                border: '2px solid var(--m-ink)',
                background: 'var(--m-card)',
                color: 'var(--m-ink)',
                cursor: unselectedCrew.length === 0 ? 'not-allowed' : 'pointer',
                opacity: unselectedCrew.length === 0 ? 0.4 : 1,
              })}
            >
              + ADD
            </button>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <div style={sectionLabel}>SCOPE</div>
        <MInput
          value={scope}
          onChange={(e) => setScope(e.currentTarget.value)}
          placeholder="e.g. EPS East — anchor + plate"
          style={{ marginTop: 8, width: '100%' }}
        />
      </div>

      {rainFlagged ? (
        <div style={{ marginTop: 16 }}>
          <MBanner tone="error" title={`● WED ${rainLabel} RAIN FORECAST — CONSIDER SHIFTING`} />
        </div>
      ) : null}

      <div style={mono({ fontSize: 10, color: 'var(--m-ink-3)', marginTop: 14, fontWeight: 600, lineHeight: 1.5 })}>
        Books a draft assignment on the week. The foreman confirms crew + hours from the field.
      </div>
    </DModal>
  )
}
