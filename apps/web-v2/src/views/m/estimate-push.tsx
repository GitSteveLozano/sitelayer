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
import { useEstimatePush } from '../../machines/estimate-push.js'
import {
  type EstimatePushHumanEvent,
  type EstimatePushWorkflowState as EstimatePushState,
} from '../../api-v1-compat.js'
import {
  MBanner,
  MBody,
  MButton,
  MButtonStack,
  MKpi,
  MKpiRow,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
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

export function MobileEstimatePush({ companySlug }: { companySlug: string }) {
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

  return (
    <>
      <MTopBar back title="Estimate push" onBack={back} />
      <MBody>
        <div style={{ padding: '4px 16px 12px' }}>
          <MPill tone={STATE_TONE[snapshot.state]} dot>
            {STATE_LABEL[snapshot.state]}
          </MPill>
        </div>
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
        <MKpiRow cols={2}>
          <MKpi label="Subtotal" value={formatMoney(subtotal)} />
          <MKpi
            label="QBO"
            value={ctx.qbo_estimate_id ? `#${ctx.qbo_estimate_id.slice(-6)}` : '—'}
            meta={ctx.posted_at ? 'posted' : ctx.failed_at ? 'failed' : 'pending'}
            metaTone={ctx.posted_at ? 'green' : ctx.failed_at ? 'red' : undefined}
          />
        </MKpiRow>
        <MSectionH>Line items</MSectionH>
        {lines.length === 0 ? (
          <div style={{ padding: '0 16px', color: 'var(--m-ink-3)', fontSize: 13 }}>No lines on this push.</div>
        ) : (
          <MListInset>
            {lines.map((line) => (
              <MListRow
                key={line.id}
                headline={line.description || line.service_item_code || '(unnamed)'}
                supporting={`${line.quantity} ${line.unit || ''} @ ${formatMoney(Number(line.rate))}`}
                trailing={<span className="num">{formatMoney(Number(line.amount))}</span>}
              />
            ))}
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
