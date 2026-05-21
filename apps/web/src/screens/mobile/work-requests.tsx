import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  MBanner,
  MBody,
  MChip,
  MChipRow,
  MI,
  MListInset,
  MListRow,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { WorkRequestAction } from '../../components/work-requests/WorkRequestAction.js'
import { WorkRequestSeverityPill, WorkRequestStatusPill } from '../../components/work-requests/status.js'
import { fetchWorkRequestQueueHealth, fetchWorkRequests, queryKeys, type WorkItemStatus } from '@/lib/api'
import { MSkeletonList } from '../../components/m-states/index.js'

const FILTERS: ReadonlyArray<{ id: 'open' | 'mine' | WorkItemStatus; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'new', label: 'New' },
  { id: 'agent_running', label: 'Agent' },
  { id: 'review_ready', label: 'Review' },
  { id: 'resolved', label: 'Resolved' },
]

const OPEN_STATUSES = new Set<WorkItemStatus>([
  'new',
  'triaged',
  'agent_running',
  'human_assigned',
  'review_ready',
  'review_stale',
  'proposal_expired',
  'reopened',
])

export function MobileWorkRequests() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('open')
  const navigate = useNavigate()
  const params = useMemo(
    () => ({
      limit: 75,
      ...(filter !== 'open' && filter !== 'mine' ? { status: filter } : {}),
    }),
    [filter],
  )
  const query = useQuery({
    queryKey: queryKeys.workRequests.list(params),
    queryFn: () => fetchWorkRequests(params),
  })
  const health = useQuery({
    queryKey: queryKeys.workRequests.health(),
    queryFn: fetchWorkRequestQueueHealth,
    refetchInterval: 30_000,
  })
  const rows =
    filter === 'open'
      ? (query.data?.work_items ?? []).filter((item) => OPEN_STATUSES.has(item.status))
      : (query.data?.work_items ?? [])

  return (
    <>
      <MTopBar title="Work" />
      <MBody>
        <WorkRequestAction defaultTitle="New work item" defaultSummary="" collapsedLabel="New work item" />
        <MChipRow>
          {FILTERS.map((entry) => (
            <MChip key={entry.id} active={filter === entry.id} onClick={() => setFilter(entry.id)}>
              {entry.label}
            </MChip>
          ))}
        </MChipRow>
        {health.data ? <WorkQueueHealthStrip health={health.data} /> : null}
        {query.error ? (
          <div style={{ padding: '0 16px 8px' }}>
            <MBanner
              tone="error"
              title="Load failed"
              body={query.error instanceof Error ? query.error.message : 'Request failed.'}
            />
          </div>
        ) : null}
        {query.isPending ? (
          <MSkeletonList count={5} />
        ) : rows.length === 0 ? (
          <div style={{ padding: '24px 16px', fontSize: 13, color: 'var(--m-ink-3)' }}>No work items.</div>
        ) : (
          <>
            <MSectionH>Queue</MSectionH>
            <MListInset>
              {rows.map((item) => (
                <MListRow
                  key={item.id}
                  leading={<MI.FileText size={18} />}
                  leadingTone="accent"
                  headline={item.title}
                  supporting={item.summary || item.route || item.entity_type || 'No summary'}
                  trailing={
                    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      <WorkRequestStatusPill status={item.status} />
                      <WorkRequestSeverityPill severity={item.severity} />
                    </span>
                  }
                  chev
                  onTap={() => navigate(`/work/${item.id}`)}
                />
              ))}
            </MListInset>
          </>
        )}
      </MBody>
    </>
  )
}

function WorkQueueHealthStrip({ health }: { health: Awaited<ReturnType<typeof fetchWorkRequestQueueHealth>> }) {
  const failedDispatches = health.dispatch_outbox.failed + health.dispatch_outbox.dead
  const activeDispatches = health.dispatch_outbox.pending + health.dispatch_outbox.processing
  const staleReview = health.work_items.review_stale + health.work_items.proposal_expired
  const dispatchMisconfigured = !health.config.mesh_dispatch_configured || !health.config.scoped_callbacks_enabled
  return (
    <>
      <MSectionH>Health</MSectionH>
      <MListInset>
        <MListRow
          leading={<MI.CloudOff size={18} />}
          leadingTone={failedDispatches > 0 || dispatchMisconfigured ? 'red' : activeDispatches > 0 ? 'amber' : 'green'}
          headline="Agent dispatch"
          supporting={[
            dispatchMisconfigured ? 'config missing' : null,
            `${activeDispatches} active`,
            `${failedDispatches} failed`,
            health.dispatch_outbox.oldest_pending_age_seconds
              ? `oldest ${formatAge(health.dispatch_outbox.oldest_pending_age_seconds)}`
              : null,
          ]
            .filter(Boolean)
            .join(' - ')}
        />
        <MListRow
          leading={<MI.Clock size={18} />}
          leadingTone={staleReview > 0 ? 'amber' : 'blue'}
          headline="Review"
          supporting={`${health.work_items.review_ready} ready - ${staleReview} stale`}
        />
      </MListInset>
    </>
  )
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}
