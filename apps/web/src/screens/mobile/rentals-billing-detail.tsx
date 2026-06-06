/**
 * Mobile rental billing-run detail — a thin renderer of the
 * `rental_billing_run` workflow snapshot inside MobileShell. Twin of the
 * desktop `screens/financial/billing-run-detail.tsx`; both drive the same
 * `useBillingReview` headless XState hook (`machines/billing-review.ts`),
 * which owns only loading/submitting/error/outOfSync. All business state,
 * the action affordances, and version arithmetic come from the server
 * snapshot — this component invents nothing.
 *
 * See docs/DETERMINISTIC_WORKFLOWS.md. State arc:
 * generated → approved → posting → posted | failed → voided. The action
 * grid is driven verbatim by `snapshot.next_events`, so the posting-state
 * CANCEL_POST escape hatch (and any future affordance) surfaces here with
 * no code change.
 */
import { useNavigate, useParams } from 'react-router-dom'
import type { CompanyRole } from '@sitelayer/domain'
import { useBillingReview } from '../../machines/billing-review.js'
import { useControlPlaneProbePublish } from '@/lib/control-plane-probe-pub'
import type { RentalBillingHumanEvent, RentalBillingState } from '@/lib/api'
import {
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { formatMoney, shortDate } from './format.js'

const STATE_LABEL: Record<RentalBillingState, string> = {
  generated: 'Generated',
  approved: 'Approved',
  posting: 'Posting to QBO…',
  posted: 'Posted',
  failed: 'Failed',
  voided: 'Voided',
}

type PillTone = 'accent' | 'green' | 'red' | 'amber' | undefined
const STATE_TONE: Record<RentalBillingState, PillTone> = {
  generated: undefined,
  approved: 'accent',
  posting: 'amber',
  posted: 'green',
  failed: 'red',
  voided: undefined,
}

// Events the UI styles as primary. VOID / CANCEL_POST render as ghost so a
// destructive escape hatch never reads as the happy-path action. The API
// (requireRole(['admin','office'])) is authoritative; the role gate here is
// display-only.
const PRIMARY_EVENTS = new Set<RentalBillingHumanEvent>(['APPROVE', 'POST_REQUESTED', 'RETRY_POST'])

export function MobileRentalBillingDetail({
  companySlug,
  companyRole,
}: {
  companySlug: string
  companyRole: CompanyRole
}) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const runId = id ?? ''
  const { snapshot, error, outOfSync, isLoading, isSubmitting, dispatch, dismissError } = useBillingReview(
    runId,
    companySlug,
  )

  // Fold the live billing-review state into the control-plane probe so the
  // browser-bridge capture modal can pick it up, matching the desktop screen.
  useControlPlaneProbePublish('billingReviewState', snapshot?.state ?? null)

  const back = () => navigate('/rentals/billing')
  const canAct = companyRole === 'admin' || companyRole === 'office'

  if (isLoading && !snapshot) {
    return (
      <>
        <MTopBar back title="Billing run" onBack={back} />
        <MBody>
          <MSkeletonList count={4} />
        </MBody>
      </>
    )
  }

  if (!snapshot) {
    return (
      <>
        <MTopBar back title="Billing run" onBack={back} />
        <MBody>
          <div style={{ padding: 24, fontSize: 13, color: 'var(--m-red)' }}>
            {error ?? 'Failed to load billing run.'}
          </div>
        </MBody>
      </>
    )
  }

  const ctx = snapshot.context
  const lines = ctx.lines ?? []
  const subtotal = Number(ctx.subtotal)

  return (
    <>
      <MTopBar back title="Billing run" onBack={back} />
      <MBody>
        <div style={{ padding: '24px 20px 20px', borderBottom: '2px solid var(--m-ink)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <MPill tone={STATE_TONE[snapshot.state]} dot>
              {STATE_LABEL[snapshot.state]}
            </MPill>
          </div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 48,
              lineHeight: 0.92,
              letterSpacing: '-0.035em',
              marginTop: 16,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {formatMoney(subtotal)}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              marginTop: 8,
            }}
          >
            {shortDate(ctx.period_start)} → {shortDate(ctx.period_end)} · v{snapshot.state_version} ·{' '}
            {ctx.qbo_invoice_id ? `QBO #${ctx.qbo_invoice_id}` : 'QBO pending'}
          </div>
        </div>

        {outOfSync ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner
              tone="warn"
              title="Out of sync"
              body="Run state moved on the server. We loaded the latest snapshot — pick the next action again."
            />
          </div>
        ) : null}
        {error && !outOfSync ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner
              tone="error"
              title="Submit failed"
              body={error}
              action={
                <MButton variant="ghost" size="sm" onClick={dismissError}>
                  Dismiss
                </MButton>
              }
            />
          </div>
        ) : null}
        {ctx.error ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner tone="error" title="Last QBO push failed" body={ctx.error} />
          </div>
        ) : null}

        <MSectionH>Line items</MSectionH>
        {lines.length === 0 ? (
          <div style={{ padding: '0 16px', color: 'var(--m-ink-3)', fontSize: 13 }}>No lines on this run.</div>
        ) : (
          <MListInset>
            {lines.map((line) => (
              <MListRow
                key={line.id}
                headline={line.description || line.inventory_item_id}
                supporting={`${Number(line.quantity).toFixed(0)} × ${formatMoney(Number(line.agreed_rate))} / ${line.rate_unit} · ${line.billable_days}d`}
                trailing={<span className="num">{formatMoney(Number(line.amount))}</span>}
              />
            ))}
          </MListInset>
        )}

        <MSectionH>Trail</MSectionH>
        <MListInset>
          <MListRow headline="Approved" trailing={<TrailAt at={ctx.approved_at} />} />
          <MListRow headline="Posted" trailing={<TrailAt at={ctx.posted_at} />} />
          <MListRow headline="Failed" trailing={<TrailAt at={ctx.failed_at} />} />
        </MListInset>

        <MSectionH>Actions</MSectionH>
        <div style={{ padding: 16 }}>
          {snapshot.next_events.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>Terminal state — no further actions.</div>
          ) : !canAct ? (
            <div style={{ fontSize: 13, color: 'var(--m-ink-3)' }}>
              Billing actions are limited to admin / office roles.
            </div>
          ) : (
            <MButtonStack>
              {snapshot.next_events.map((ev) => (
                <MButton
                  key={ev.type}
                  variant={PRIMARY_EVENTS.has(ev.type) ? 'primary' : 'ghost'}
                  onClick={() => dispatch(ev.type)}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Working…' : ev.label}
                </MButton>
              ))}
            </MButtonStack>
          )}
        </div>
      </MBody>
    </>
  )
}

function TrailAt({ at }: { at: string | null }) {
  return (
    <span className="num" style={{ color: 'var(--m-ink-2)' }}>
      {at
        ? new Date(at).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : '—'}
    </span>
  )
}
