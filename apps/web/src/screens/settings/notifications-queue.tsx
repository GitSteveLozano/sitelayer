import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MButton, MChip, MChipRow, MLargeHead, MListInset, MListRow, MPill } from '@/components/m'
import type { MTone } from '@/components/m'
import { MEmptyState, MErrorState, MSkeletonList } from '@/components/m-states'
import {
  useDispatchNotificationEvent,
  useNotificationQueue,
  type NotificationQueueRow,
  type NotificationWorkflowState,
} from '@/lib/api/notifications-queue'

/**
 * Admin notification queue — view every notification's delivery state
 * and retry the failures. Mirrors the billing-run list archetype
 * (rows + state-filter chips + status pills) but reads the
 * `notification` workflow snapshot instead of rental billing.
 *
 * The worker walks each row through pending → hydrating → sending →
 * sent, or to one of three failure terminals. Two of those
 * (`failed_provider`, `failed_clerk_unreachable`) are retryable; RETRY
 * re-enters `pending` so the runner re-claims it. `failed_clerk_not_found`
 * is terminal — no Retry CTA, since re-sending to a missing user can't
 * succeed.
 *
 * Filter chips collapse the eight workflow states into the operator's
 * mental model: All / Pending / Sending / Sent / Failed. "Failed" maps
 * to all three failure terminals client-side; the rest pass straight
 * through as a `?state=` query.
 */

type FilterKey = 'all' | 'pending' | 'sending' | 'sent' | 'failed'

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'sending', label: 'Sending' },
  { key: 'sent', label: 'Sent' },
  { key: 'failed', label: 'Failed' },
]

// Map a filter chip to the workflow state passed to the API. "failed"
// and "all" are resolved client-side (failed = any failure terminal),
// so they send no `state` param and filter the returned rows locally.
const FILTER_TO_STATE: Partial<Record<FilterKey, NotificationWorkflowState>> = {
  pending: 'pending',
  sending: 'sending',
  sent: 'sent',
}

const FAILURE_STATES: ReadonlyArray<NotificationWorkflowState> = [
  'failed_provider',
  'failed_clerk_unreachable',
  'failed_clerk_not_found',
]

// Retryable failures re-enter `pending` on RETRY; the not-found
// terminal is dead-ended.
const RETRYABLE_STATES: ReadonlyArray<NotificationWorkflowState> = ['failed_provider', 'failed_clerk_unreachable']

const STATE_TONE: Record<NotificationWorkflowState, MTone> = {
  pending: 'amber',
  hydrating: 'amber',
  sending: 'blue',
  sent: 'green',
  failed_provider: 'red',
  failed_clerk_unreachable: 'red',
  failed_clerk_not_found: 'red',
  voided: 'accent',
}

const STATE_LABEL: Record<NotificationWorkflowState, string> = {
  pending: 'Pending',
  hydrating: 'Hydrating',
  sending: 'Sending',
  sent: 'Sent',
  failed_provider: 'Provider failed',
  failed_clerk_unreachable: 'Clerk unreachable',
  failed_clerk_not_found: 'User not found',
  voided: 'Voided',
}

function isFailure(state: NotificationWorkflowState): boolean {
  return FAILURE_STATES.includes(state)
}

function isRetryable(state: NotificationWorkflowState): boolean {
  return RETRYABLE_STATES.includes(state)
}

export function NotificationsQueueScreen() {
  const [filter, setFilter] = useState<FilterKey>('all')
  const queue = useNotificationQueue(FILTER_TO_STATE[filter] ? { state: FILTER_TO_STATE[filter] } : {})
  const retry = useDispatchNotificationEvent()

  const allRows = queue.data?.notifications ?? []
  // Client-side narrowing for the "failed" bucket; other filters are
  // already scoped server-side (or unscoped for "all").
  const rows = filter === 'failed' ? allRows.filter((r) => isFailure(r.state)) : allRows

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more" className="text-[12px] text-ink-3">
        ← More
      </Link>
      <MLargeHead title="Notification queue" sub={`${rows.length} notification${rows.length === 1 ? '' : 's'}`} />

      <div className="mt-3">
        <MChipRow>
          {FILTERS.map((f) => (
            <MChip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
            </MChip>
          ))}
        </MChipRow>
      </div>

      <div className="mt-3">
        {queue.isPending ? (
          <MSkeletonList count={5} />
        ) : queue.isError ? (
          <MErrorState
            title="Couldn't load the queue"
            body="The notification queue endpoint isn't reachable. Retry, or check that the admin queue route is deployed."
            primaryLabel="Retry"
            onPrimary={() => queue.refetch()}
          />
        ) : rows.length === 0 ? (
          <MEmptyState title="Nothing in this state" body="No notifications match this filter right now." />
        ) : (
          <MListInset>
            {rows.map((r) => (
              <QueueRow
                key={r.id}
                row={r}
                onRetry={() => retry.mutate({ id: r.id, event: 'RETRY', state_version: r.state_version })}
                retrying={retry.isPending && retry.variables?.id === r.id}
              />
            ))}
          </MListInset>
        )}
      </div>

      {retry.isError ? <div className="mt-3 text-[12px] text-red">Retry failed: {retry.error.message}</div> : null}
    </div>
  )
}

function QueueRow({ row, onRetry, retrying }: { row: NotificationQueueRow; onRetry: () => void; retrying: boolean }) {
  const recipient = row.recipient_email ?? row.recipient_clerk_user_id ?? 'Unknown recipient'
  const channelLabel = row.channel ? row.channel.toUpperCase() : null
  const failed = isFailure(row.state)

  // Supporting line: recipient + channel + (on failure) the reason.
  const supporting = (
    <span>
      {recipient}
      {channelLabel ? ` · ${channelLabel}` : ''}
      {failed && row.error ? (
        <>
          <br />
          <span className="text-red">{row.error}</span>
        </>
      ) : null}
    </span>
  )

  return (
    <div>
      <MListRow
        headline={row.subject || row.kind}
        supporting={supporting}
        badge={<MPill tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</MPill>}
      />
      {isRetryable(row.state) ? (
        <div className="px-3 pb-3 -mt-1">
          <MButton variant="ghost" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Retrying…' : 'Retry delivery'}
          </MButton>
        </div>
      ) : null}
    </div>
  )
}
