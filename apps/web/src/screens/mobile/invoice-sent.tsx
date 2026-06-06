/**
 * Invoice sent — `invoice-sent` (mobile, v2 brutalist).
 *
 * The post-send invoice state, wired to the REAL estimate_push workflow
 * (`apps/api/src/routes/estimate-pushes.ts` → `useEstimatePush` /
 * `useDispatchEstimatePushEvent`). Mirrors Steve's `V2InvoiceSent`: an accent
 * hero block (state + amount big-number + due date), a TIMELINE driven by the
 * snapshot's real lifecycle timestamps, and an action bar driven by the
 * snapshot's `next_events`.
 *
 * Reached from `invoice-quick.tsx` on send via `/invoice-sent/:projectId`
 * with the freshly-created push id passed through navigation state. On a
 * cold deep-link / refresh (no nav state) it recovers the push by listing
 * the project's estimate_pushes and picking the most recent non-voided one.
 *
 * NUDGE / MARK-PAID mapping (see WIRING REPORT):
 *  - "Nudge / advance" surfaces the snapshot's `next_events` — the real
 *    forward transitions (Mark reviewed → Approve → Push to QuickBooks →
 *    Retry). This is how the invoice actually moves toward QBO.
 *  - "Mark paid" is now REAL: it sets the project's active billing milestone
 *    (migration 104 `project_billing_milestones`) to `paid` via
 *    usePatchBillingMilestone. This is a MANUAL status set — there is no QBO
 *    payment-webhook auto-detection. The estimate_push workflow itself still
 *    terminates at `posted`; milestones are the additive paid/invoiced
 *    tracking layer alongside it.
 *
 * Built from the `components/m/` primitives + `var(--m-*)` tokens only.
 */
import { useMemo } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  getActiveCompanySlug,
  useEstimatePushes,
  type BootstrapResponse,
  type EstimatePushHumanEvent,
  type EstimatePushState,
} from '@/lib/api'
import { useEstimatePush } from '@/machines/estimate-push'
import {
  useBillingMilestones,
  usePatchBillingMilestone,
  type BillingMilestone,
  type BillingMilestoneStatus,
} from '@/lib/api/billing-milestones'
import { MBanner, MBody, MButton, MTopBar } from '../../components/m/index.js'
import { formatMoney } from './format.js'

function milestoneStatusLabel(status: BillingMilestoneStatus): string {
  if (status === 'paid') return '✓ PAID'
  if (status === 'invoiced') return '● INVOICED · NOT PAID'
  return '○ NOT YET INVOICED'
}

// The milestone "Mark paid" targets: the first not-yet-paid milestone (the one
// currently being billed). Null when every milestone is already paid.
function nextPayableMilestone(milestones: BillingMilestone[]): BillingMilestone | null {
  return milestones.find((m) => m.status !== 'paid') ?? null
}

const TIGHT = 'var(--m-font-display)'
const MONO = 'var(--m-num)'

type InvoiceSentNavState = {
  pushId?: string
  amount?: string | number
  memo?: string
} | null

type TimelineStep = {
  date: string
  label: string
  current?: boolean
  done?: boolean
}

function fmtStamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .toUpperCase()}`
}

// Header label + accent dot copy per real workflow state.
const STATE_HERO: Record<EstimatePushState, string> = {
  drafted: '● DRAFTED · NOT YET SENT',
  reviewed: '● REVIEWED · READY TO APPROVE',
  approved: '● APPROVED · READY FOR QUICKBOOKS',
  posting: '● POSTING TO QUICKBOOKS…',
  posted: '✓ POSTED TO QUICKBOOKS',
  failed: '✕ QUICKBOOKS PUSH FAILED',
  voided: '○ VOIDED',
}

// Primary (filled) vs ghost treatment for the action buttons.
const PRIMARY_EVENTS = new Set<EstimatePushHumanEvent>(['REVIEW', 'APPROVE', 'POST_REQUESTED', 'RETRY_POST'])

export function MobileInvoiceSent({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { projectId } = useParams<{ projectId: string }>()

  const navState = (location.state ?? null) as InvoiceSentNavState
  const project = bootstrap?.projects?.find((p) => p.id === projectId)
  const eyebrow = project ? project.name.toUpperCase() : 'INVOICE'

  // Resolve the push id. Prefer the nav-state id handed over from the create
  // screen; on a cold deep-link, recover by listing the project's pushes and
  // picking the most recent non-voided one.
  const navPushId = navState?.pushId ?? null
  const pushList = useEstimatePushes()
  const recoveredPushId = useMemo(() => {
    if (navPushId) return null
    const rows = pushList.data?.estimatePushes ?? []
    const forProject = rows
      .filter((r) => r.project_id === projectId && r.status !== 'voided')
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    return forProject[0]?.id ?? null
  }, [navPushId, pushList.data, projectId])

  const pushId = navPushId ?? recoveredPushId
  // Re-pointed onto the canonical headless XState machine (the hook
  // mobile/estimate-push.tsx uses) — gains the outOfSync 409 reload the
  // TanStack path lacked. Push-id resolution above is unchanged; once a
  // pushId is known it feeds the machine, which re-LOADs when it changes.
  const {
    snapshot: machineSnapshot,
    isLoading: pushLoading,
    isSubmitting,
    dispatch,
  } = useEstimatePush(pushId ?? '', getActiveCompanySlug())

  // Real billing milestones for this project (migration 104). Drives the
  // milestone status strip + the manual "Mark paid" control below.
  const milestonesQuery = useBillingMilestones(projectId ?? null)
  const milestones = milestonesQuery.data?.billing_milestones ?? []
  const payable = nextPayableMilestone(milestones)
  const patchMilestone = usePatchBillingMilestone(projectId ?? '')

  const snapshot = pushId ? machineSnapshot : null
  const ctx = snapshot?.context ?? null

  // Amount: prefer the real workflow subtotal; fall back to the nav-state
  // amount only while the snapshot is still loading.
  const subtotal = ctx ? Number(ctx.subtotal) : Number(navState?.amount ?? 0)

  const back = () => navigate(-1)

  // Loading / resolution states.
  const resolving = pushList.isPending && !navPushId
  if (!pushId && !resolving) {
    return (
      <>
        <MTopBar back title="Invoice" eyebrow={eyebrow} onBack={back} />
        <MBody>
          <div style={{ padding: 24, fontSize: 13, color: 'var(--m-ink-3)' }}>
            No invoice found for this project yet. Create one from Quick invoice.
          </div>
        </MBody>
      </>
    )
  }
  if (!snapshot) {
    return (
      <>
        <MTopBar back title="Invoice" eyebrow={eyebrow} onBack={back} />
        <MBody>
          <div style={{ padding: 24, fontSize: 13, color: 'var(--m-ink-3)' }}>
            {pushLoading ? 'Loading invoice…' : 'Failed to load the invoice.'}
          </div>
        </MBody>
      </>
    )
  }

  // Build the timeline from the snapshot's real lifecycle stamps.
  // reviewed/approved/posted/failed light up as the workflow advances. The
  // current step is the first one that hasn't happened yet for a live state,
  // or the terminal stamp for posted/failed.
  const reviewedStamp = fmtStamp(ctx?.reviewed_at)
  const approvedStamp = fmtStamp(ctx?.approved_at)
  const postedStamp = fmtStamp(ctx?.posted_at)
  const failedStamp = fmtStamp(ctx?.failed_at)
  const state = snapshot.state

  const timeline: TimelineStep[] = [
    {
      date: reviewedStamp || 'PENDING',
      label: 'REVIEWED',
      done: Boolean(ctx?.reviewed_at),
      current: state === 'drafted',
    },
    {
      date: approvedStamp || 'PENDING',
      label: 'APPROVED',
      done: Boolean(ctx?.approved_at),
      current: state === 'reviewed',
    },
    {
      date: postedStamp || (state === 'posting' ? 'POSTING…' : 'PENDING'),
      label: 'POSTED TO QUICKBOOKS',
      done: state === 'posted',
      current: state === 'approved' || state === 'posting',
    },
  ]
  if (failedStamp) {
    timeline.push({ date: failedStamp, label: 'QUICKBOOKS PUSH FAILED', current: state === 'failed' })
  }

  const onDispatch = (event: EstimatePushHumanEvent) => {
    if (isSubmitting) return
    // The machine reads state_version off its stored snapshot and handles
    // the 409 outOfSync reload itself, so the screen no longer threads it.
    dispatch(event)
  }

  return (
    <>
      <MTopBar back title="Invoice" eyebrow={eyebrow} onBack={back} />
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {/* Accent hero — real workflow state + subtotal big-number + QBO ref. */}
        <div
          style={{
            padding: '24px 20px',
            background: 'var(--m-accent)',
            color: 'var(--m-accent-ink)',
            borderBottom: '2px solid var(--m-ink)',
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 800, letterSpacing: '0.08em' }}>
            {STATE_HERO[state]}
          </div>
          <div
            style={{
              fontFamily: TIGHT,
              fontSize: 64,
              fontWeight: 800,
              letterSpacing: '-0.03em',
              marginTop: 14,
              lineHeight: 0.9,
              color: 'var(--m-accent-ink)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {subtotal ? formatMoney(subtotal) : '$0'}
          </div>
          <div style={{ marginTop: 10, fontFamily: MONO, fontWeight: 600, fontSize: 12, color: 'var(--m-accent-ink)' }}>
            {ctx?.qbo_estimate_id
              ? `QBO #${ctx.qbo_estimate_id}`
              : `${ctx?.lines.length ?? 0} LINES · v${snapshot.state_version}`}
          </div>
        </div>

        <MBody>
          {/* TIMELINE — driven by the snapshot's real lifecycle stamps. */}
          <div
            className="m-section-h"
            style={{ borderTop: '2px solid var(--m-ink)', borderBottom: '2px solid var(--m-ink)' }}
          >
            Timeline
          </div>
          {timeline.map((t, i, arr) => (
            <div
              key={t.label}
              style={{
                padding: '14px 20px',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                borderBottom: i < arr.length - 1 ? '1px solid var(--m-line-2)' : 'none',
              }}
            >
              <div
                style={{
                  width: 24,
                  height: 24,
                  background: t.done || t.current ? 'var(--m-accent)' : 'transparent',
                  border: '2px solid var(--m-ink)',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: 'var(--m-ink-3)' }}>{t.date}</div>
                <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, marginTop: 3 }}>{t.label}</div>
              </div>
            </div>
          ))}

          {/* MILESTONE STATUS — the real billing schedule (migration 104).
              paid / invoiced / not-yet per phase. Mark paid (below) advances
              the first not-yet-paid milestone. */}
          {milestones.length > 0 ? (
            <>
              <div
                className="m-section-h"
                style={{ borderTop: '2px solid var(--m-ink)', borderBottom: '2px solid var(--m-ink)' }}
              >
                Billing milestones
              </div>
              {milestones.map((m, i, arr) => (
                <div
                  key={m.id}
                  style={{
                    padding: '12px 20px',
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                    gap: 10,
                    borderBottom: i < arr.length - 1 ? '1px solid var(--m-line-2)' : 'none',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700 }}>{m.label}</div>
                    <div
                      style={{ fontFamily: MONO, fontSize: 10, fontWeight: 600, marginTop: 4, color: 'var(--m-ink-3)' }}
                    >
                      {milestoneStatusLabel(m.status)}
                    </div>
                  </div>
                  <div
                    className="num"
                    style={{ fontFamily: MONO, fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {m.amount !== null ? formatMoney(m.amount) : m.pct !== null ? `${m.pct}%` : '—'}
                  </div>
                </div>
              ))}
            </>
          ) : null}

          {ctx?.error ? (
            <div style={{ padding: '12px 20px 0' }}>
              <MBanner tone="error" title="Last QuickBooks push failed" body={ctx.error} />
            </div>
          ) : null}

          {navState?.memo ? (
            <>
              <div
                className="m-section-h"
                style={{ borderTop: '2px solid var(--m-ink)', borderBottom: '2px solid var(--m-ink)' }}
              >
                Memo
              </div>
              <div style={{ padding: '14px 20px', fontSize: 14, lineHeight: 1.45, color: 'var(--m-ink-2)' }}>
                {navState.memo}
              </div>
            </>
          ) : null}
        </MBody>

        {/* Action bar — the real forward transitions from next_events drive the
            "nudge/advance" controls (the QBO push). MARK PAID is a real manual
            milestone status set (migration 104), not a QBO payment webhook. */}
        <div
          style={{
            padding: '14px 20px 18px',
            borderTop: '2px solid var(--m-ink)',
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          {snapshot.next_events.length === 0 ? (
            <span style={{ flex: 1 }}>
              <MButton variant="ghost" onClick={back}>
                Done
              </MButton>
            </span>
          ) : (
            snapshot.next_events.map((evt) => (
              <span key={evt.type} style={{ flex: PRIMARY_EVENTS.has(evt.type) ? 2 : 1, minWidth: 120 }}>
                <MButton
                  variant={PRIMARY_EVENTS.has(evt.type) ? 'primary' : 'ghost'}
                  disabled={isSubmitting}
                  onClick={() => onDispatch(evt.type)}
                >
                  {isSubmitting ? 'Working…' : evt.label}
                </MButton>
              </span>
            ))
          )}
          {/* MARK PAID — real, MANUAL milestone status set (migration 104). No
              QBO payment-webhook auto-detection: this advances the first
              not-yet-paid billing milestone to `paid`. Disabled only when there
              is nothing payable (no milestones, or all already paid). */}
          <span style={{ flex: 2, minWidth: 120 }}>
            <MButton
              variant="ghost"
              disabled={!payable || patchMilestone.isPending}
              title={
                payable
                  ? `Mark "${payable.label}" paid`
                  : milestones.length === 0
                    ? 'No billing milestones — seed them from Quick invoice'
                    : 'All milestones paid'
              }
              onClick={() => {
                if (!payable || patchMilestone.isPending) return
                patchMilestone.mutate({ id: payable.id, input: { status: 'paid' } })
              }}
            >
              {patchMilestone.isPending
                ? 'Marking…'
                : payable
                  ? `Mark "${payable.label}" paid`
                  : milestones.length === 0
                    ? 'Mark paid (no milestones)'
                    : 'All milestones paid'}
            </MButton>
          </span>
        </div>
      </div>
    </>
  )
}
