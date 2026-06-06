/**
 * Estimate-push review — drives the deterministic estimate_push workflow
 * documented in `docs/DETERMINISTIC_WORKFLOWS.md`.
 *
 * Headless UI: every business state ('drafted', 'reviewed', 'approved',
 * 'posting', 'posted', 'failed', 'voided') and the next-events list come
 * from the server snapshot. This component is a pure renderer of that
 * snapshot plus the `useEstimatePush` XState hook for loading/submitting/
 * outOfSync UI state. No business logic mirrored on the client.
 */
import { useNavigate, useParams } from 'react-router-dom'
import type { CompanyRole } from '@sitelayer/domain'
import { useEstimatePush } from '../../machines/estimate-push.js'
import {
  estimatePushLineRate,
  estimatePushLineUnit,
  type EstimatePushHumanEvent,
  type EstimatePushState,
} from '@/lib/api'
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
import { WorkRequestAction } from '../../components/work-requests/WorkRequestAction.js'
import { WorkRequestEntityStatus } from '../../components/work-requests/WorkRequestEntityStatus.js'
import { formatMoney } from './format.js'

const STATE_LABEL: Record<EstimatePushState, string> = {
  drafted: 'Drafted',
  reviewed: 'Reviewed',
  approved: 'Approved',
  posting: 'Posting to QBO…',
  posted: 'Posted',
  failed: 'Failed',
  voided: 'Voided',
}

type PillTone = 'accent' | 'green' | 'red' | 'amber' | undefined
const STATE_TONE: Record<EstimatePushState, PillTone> = {
  drafted: undefined,
  reviewed: 'accent',
  approved: 'accent',
  posting: 'amber',
  posted: 'green',
  failed: 'red',
  voided: undefined,
}

type BannerTone = 'info' | 'error' | 'ok' | 'warn'

// Lifecycle stepper — the v2 brutalist segment strip (DRAFT→REVIEWED→APPROVED→POSTED).
// Pure view-layer: each business state maps to one stepper index for active/done fill.
const LIFECYCLE_STEPS = ['DRAFT', 'REVIEWED', 'APPROVED', 'POSTED'] as const
const STATE_STEP_INDEX: Record<EstimatePushState, number> = {
  drafted: 0,
  reviewed: 1,
  approved: 2,
  posting: 3,
  posted: 3,
  failed: 3,
  voided: 0,
}

function LifecycleStepper({ state }: { state: EstimatePushState }) {
  const activeIdx = STATE_STEP_INDEX[state]
  const terminalGood = state === 'posted'
  const terminalBad = state === 'failed'
  return (
    <div style={{ padding: '18px 20px', borderBottom: '2px solid var(--m-ink)' }}>
      <div
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
        }}
      >
        Lifecycle
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 0, border: '2px solid var(--m-ink)' }}>
        {LIFECYCLE_STEPS.map((step, i, arr) => {
          const active = i === activeIdx
          const done = i < activeIdx
          const isLast = i === arr.length - 1
          // Terminal failure tints the final (POSTED) cell red so the strip reads at a glance.
          const activeBg =
            isLast && terminalBad ? 'var(--m-red)' : isLast && terminalGood ? 'var(--m-green)' : 'var(--m-accent)'
          const activeFg = isLast && (terminalBad || terminalGood) ? '#fff' : 'var(--m-accent-ink)'
          return (
            <div
              key={step}
              style={{
                flex: 1,
                padding: '10px 0',
                textAlign: 'center',
                background: active ? activeBg : done ? 'var(--m-ink)' : 'transparent',
                color: active ? activeFg : done ? 'var(--m-accent)' : 'var(--m-ink-4)',
                borderRight: isLast ? 'none' : '2px solid var(--m-ink)',
              }}
            >
              <div
                className="num"
                style={{ fontFamily: 'var(--m-num)', fontSize: 9, fontWeight: 800, letterSpacing: '0.04em' }}
              >
                {step}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function MobileEstimatePush({ companySlug, companyRole }: { companySlug: string; companyRole: CompanyRole }) {
  const params = useParams<{ projectId: string; pushId: string }>()
  const navigate = useNavigate()
  const projectId = params.projectId ?? ''
  const pushId = params.pushId ?? ''
  const { snapshot, error, outOfSync, isLoading, isSubmitting, dispatch, dismissError } = useEstimatePush(
    pushId,
    companySlug,
  )

  const back = () => navigate(`/projects/${projectId}/estimate`)

  if (isLoading && !snapshot) {
    return (
      <>
        <MTopBar back title="Estimate push" onBack={back} />
        <MBody>
          <MSkeletonList count={4} />
        </MBody>
      </>
    )
  }

  if (!snapshot) {
    return (
      <>
        <MTopBar back title="Estimate push" onBack={back} />
        <MBody>
          <div style={{ padding: 24, fontSize: 13, color: 'var(--m-red)' }}>
            {error ?? 'Failed to load estimate push.'}
          </div>
        </MBody>
      </>
    )
  }

  const ctx = snapshot.context
  const lines = ctx.lines
  const subtotal = Number(ctx.subtotal)
  const workRequestContext = {
    source: 'estimate_push_mobile',
    page: {
      path: `/projects/${projectId}/estimate-push/${pushId}`,
      route: `/projects/${projectId}/estimate-push/${pushId}`,
    },
    entity: {
      entity_type: 'estimate_push',
      entity_id: pushId,
    },
    project: {
      entity_type: 'project',
      entity_id: projectId,
    },
    workflow: {
      name: 'estimate_push',
      state: snapshot.state,
      next_events: snapshot.next_events.map((evt) => evt.type),
      line_count: lines.length,
      subtotal,
      qbo_estimate_id: ctx.qbo_estimate_id ?? null,
      posted_at: ctx.posted_at ?? null,
      failed_at: ctx.failed_at ?? null,
      error: ctx.error ?? null,
    },
  }

  return (
    <>
      <MTopBar back title="Estimate push" onBack={back} />
      <MBody>
        {/* State header — mono dot-label + big-number total, v2 brutalist. */}
        <div style={{ padding: '24px 20px 20px', borderBottom: '2px solid var(--m-ink)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <MPill tone={STATE_TONE[snapshot.state]} dot>
              {STATE_LABEL[snapshot.state]}
            </MPill>
          </div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 800,
              fontSize: 48,
              lineHeight: 0.92,
              letterSpacing: '-0.035em',
              marginTop: 16,
              fontFeatureSettings: "'tnum'",
              fontVariantNumeric: 'tabular-nums',
            }}
            className="num"
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
            Subtotal · {lines.length} {lines.length === 1 ? 'line' : 'lines'} ·{' '}
            {ctx.qbo_estimate_id ? `QBO #${ctx.qbo_estimate_id.slice(-6)}` : 'QBO pending'}
          </div>
        </div>
        <LifecycleStepper state={snapshot.state} />
        {outOfSync ? (
          <div style={{ padding: '0 16px 8px' }}>
            <MBanner
              tone={'warn' satisfies BannerTone}
              title="Out of sync"
              body="Someone else moved this push forward. We loaded the latest snapshot — review then try again."
            />
          </div>
        ) : null}
        {error && !outOfSync ? (
          <div style={{ padding: '0 16px 8px' }}>
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
        <WorkRequestAction
          companyRole={companyRole}
          defaultTitle="Estimate push issue"
          defaultSummary={ctx.error ? `QBO push failed: ${ctx.error}` : ''}
          category="estimate_push"
          route={`/projects/${projectId}/estimate-push/${pushId}`}
          client={workRequestContext}
        />
        <WorkRequestEntityStatus entityType="estimate_push" entityId={pushId} />
        <MSectionH>Line items</MSectionH>
        {lines.length === 0 ? (
          <div style={{ padding: '0 16px', color: 'var(--m-ink-3)', fontSize: 13 }}>No lines on this push.</div>
        ) : (
          <MListInset>
            {lines.map((line) => {
              const unit = estimatePushLineUnit(line)
              const rate = estimatePushLineRate(line)
              return (
                <MListRow
                  key={line.id}
                  headline={line.description || line.service_item_code || '(unnamed)'}
                  supporting={`${line.quantity}${unit ? ` ${unit}` : ''} @ ${formatMoney(Number(rate))}`}
                  trailing={<span className="num">{formatMoney(Number(line.amount))}</span>}
                />
              )
            })}
          </MListInset>
        )}
        {ctx.error ? (
          <div style={{ padding: '12px 16px 0' }}>
            <MBanner tone="error" title="Last QBO push failed" body={ctx.error} />
          </div>
        ) : null}
        <div style={{ padding: 16 }}>
          <MButtonStack>
            {snapshot.next_events.map((evt) => (
              <MButton
                key={evt.type}
                variant={primaryEvents.has(evt.type) ? 'primary' : 'ghost'}
                onClick={() => dispatch(evt.type)}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Working…' : evt.label}
              </MButton>
            ))}
            {snapshot.next_events.length === 0 ? (
              <MButton variant="ghost" onClick={back}>
                Back to estimate
              </MButton>
            ) : null}
          </MButtonStack>
        </div>
      </MBody>
    </>
  )
}

const primaryEvents = new Set<EstimatePushHumanEvent>(['APPROVE', 'POST_REQUESTED', 'RETRY_POST'])
