import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  MBanner,
  MBody,
  MButton,
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
import {
  fetchWorkRequestQueueHealth,
  fetchWorkRequests,
  queryKeys,
  type ContextWorkItem,
  type WorkItemStatus,
} from '@/lib/api'
import { canTriageWorkRequests } from '@/lib/work-request-permissions'
import type { CompanyRole } from '@sitelayer/domain'
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

export function MobileWorkRequests({
  companyRole,
  currentUserId,
}: {
  companyRole: CompanyRole
  currentUserId: string | null
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('open')
  const navigate = useNavigate()
  const canTriage = canTriageWorkRequests(companyRole)
  const filters = currentUserId ? FILTERS : FILTERS.filter((entry) => entry.id !== 'mine')
  const params = useMemo(
    () => ({
      limit: 75,
      ...(filter !== 'open' && filter !== 'mine' ? { status: filter } : {}),
      ...(filter === 'mine' && currentUserId ? { created_by_user_id: currentUserId } : {}),
    }),
    [currentUserId, filter],
  )
  const query = useQuery({
    queryKey: queryKeys.workRequests.list(params),
    queryFn: () => fetchWorkRequests(params),
  })
  const health = useQuery({
    queryKey: queryKeys.workRequests.health(),
    queryFn: fetchWorkRequestQueueHealth,
    enabled: canTriage,
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
        <WorkRequestAction
          companyRole={companyRole}
          defaultTitle="New work item"
          defaultSummary=""
          collapsedLabel="New work item"
        />
        <MChipRow>
          {filters.map((entry) => (
            <MChip key={entry.id} active={filter === entry.id} onClick={() => setFilter(entry.id)}>
              {entry.label}
            </MChip>
          ))}
        </MChipRow>
        {canTriage && health.data ? <WorkQueueHealthStrip health={health.data} /> : null}
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
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                padding: '4px 16px 0',
              }}
            >
              <MSectionH>Intake queue</MSectionH>
              <span
                style={{
                  fontFamily: 'var(--m-num)',
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  color: 'var(--m-ink-3)',
                }}
              >
                {rows.length} ITEM{rows.length === 1 ? '' : 'S'}
              </span>
            </div>
            <div style={{ borderTop: '2px solid var(--m-ink)' }}>
              {rows.map((item) => (
                <WorkRequestCard key={item.id} item={item} onOpen={() => navigate(`/work/${item.id}`)} />
              ))}
            </div>
          </>
        )}
      </MBody>
    </>
  )
}

function WorkRequestCard({ item, onOpen }: { item: ContextWorkItem; onOpen: () => void }) {
  const kind = (item.entity_type ?? 'work').toUpperCase()
  const age = relativeAge(item.created_at)
  const meta = [item.route, age].filter(Boolean).join(' · ')
  return (
    <article
      style={{
        padding: '16px',
        borderBottom: '2px solid var(--m-ink)',
        background: item.severity === 'urgent' ? 'var(--m-card-soft)' : 'transparent',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.06em',
            color: 'var(--m-accent-ink)',
            background: 'var(--m-accent)',
            border: '1.5px solid var(--m-ink)',
            padding: '3px 7px',
          }}
        >
          {kind}
        </span>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <WorkRequestSeverityPill severity={item.severity} />
          <WorkRequestStatusPill status={item.status} />
        </span>
      </div>
      <div
        style={{
          fontFamily: 'var(--m-font-display)',
          fontWeight: 700,
          fontSize: 16,
          lineHeight: 1.3,
          color: 'var(--m-ink)',
        }}
      >
        {item.title}
      </div>
      {item.summary ? (
        <div style={{ marginTop: 6, fontSize: 14, lineHeight: 1.45, color: 'var(--m-ink-2)' }}>{item.summary}</div>
      ) : null}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginTop: 14,
        }}
      >
        {meta ? (
          <span
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.04em',
              color: 'var(--m-ink-3)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {meta.toUpperCase()}
          </span>
        ) : (
          <span />
        )}
        <MButton size="sm" onClick={onOpen}>
          Open
        </MButton>
      </div>
    </article>
  )
}

function relativeAge(iso: string): string | null {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return null
  return formatAge((Date.now() - ts) / 1000)
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
