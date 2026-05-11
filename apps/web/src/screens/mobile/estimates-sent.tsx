/**
 * Estimates · Sent timeline (est-sent destination from Sitemap.html §02).
 *
 * Surfaces every estimate the company has shared with a customer — one
 * row per project (latest share). Each row shows the project + customer +
 * bid total and a status pill reflecting where that share is in the
 * sales funnel: Sent → Viewed → Accepted | Declined | Expired. Tapping
 * a row deep-links into the project's Estimate tab so the operator can
 * follow up, re-send, or revoke from the existing share-management UI
 * that already lives there.
 *
 * Route: `/projects/sent` (admin/office only). Accessed from the
 * Projects list top bar via the "Sent" action.
 *
 * The data source is the company-wide GET /api/estimate-shares endpoint
 * which returns the latest share per project; we don't paginate here
 * because the response is already capped server-side at 200 rows and
 * the operator-facing volume sits well below that for the foreseeable
 * future. If we outgrow it, switch to a windowed query before adding
 * client-side virtualization.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MChip, MChipRow, MI, MPill, MTapCard, MTopBar } from '../../components/m/index.js'
import { MEmptyState, MErrorState, MSkeletonList } from '../../components/m-states/index.js'
import {
  useEstimateShareTimeline,
  type EstimateShareTimelineRow,
  type EstimateShareTimelineStatus,
} from '../../lib/api/estimate-shares.js'
import { formatMoney } from './format.js'

type FilterKey = 'all' | 'awaiting' | 'accepted' | 'declined'

const FILTER_MATCHERS: Record<FilterKey, (s: EstimateShareTimelineRow) => boolean> = {
  all: () => true,
  awaiting: (s) => s.status === 'sent' || s.status === 'viewed' || s.status === 'expired',
  accepted: (s) => s.status === 'accepted',
  declined: (s) => s.status === 'declined',
}

export function MobileEstimatesSent() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<FilterKey>('all')
  const query = useEstimateShareTimeline()

  const shares = useMemo(() => query.data?.shares ?? [], [query.data])
  const counts = useMemo(() => {
    return {
      all: shares.length,
      awaiting: shares.filter(FILTER_MATCHERS.awaiting).length,
      accepted: shares.filter(FILTER_MATCHERS.accepted).length,
      declined: shares.filter(FILTER_MATCHERS.declined).length,
    }
  }, [shares])

  const visible = useMemo(() => shares.filter(FILTER_MATCHERS[filter]), [shares, filter])

  return (
    <>
      <MTopBar back title="Estimates sent" onBack={() => navigate('/projects')} />
      <MBody>
        {query.isLoading ? (
          <div style={{ padding: '12px 16px' }}>
            <MSkeletonList count={4} />
          </div>
        ) : query.isError ? (
          <MErrorState
            title="Couldn't load sent estimates"
            body={query.error instanceof Error ? query.error.message : 'Try again in a moment.'}
            primaryLabel="Retry"
            onPrimary={() => void query.refetch()}
          />
        ) : shares.length === 0 ? (
          <MEmptyState
            title="No estimates sent yet"
            body="Send a bid from a project's Estimate tab and it will show up here once the customer receives the link."
            primaryLabel="Open projects"
            onPrimary={() => navigate('/projects')}
          />
        ) : (
          <>
            <MChipRow>
              <MChip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
                All
              </MChip>
              <MChip active={filter === 'awaiting'} onClick={() => setFilter('awaiting')} count={counts.awaiting}>
                Awaiting
              </MChip>
              <MChip active={filter === 'accepted'} onClick={() => setFilter('accepted')} count={counts.accepted}>
                Accepted
              </MChip>
              <MChip active={filter === 'declined'} onClick={() => setFilter('declined')} count={counts.declined}>
                Declined
              </MChip>
            </MChipRow>
            {visible.length === 0 ? (
              <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--m-ink-3)', fontSize: 13 }}>
                No estimates match this filter.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px 16px' }}>
                {visible.map((row) => (
                  <SentRow key={row.id} row={row} onOpen={() => navigate(`/projects/${row.project_id}/estimate`)} />
                ))}
              </div>
            )}
          </>
        )}
      </MBody>
    </>
  )
}

function SentRow({ row, onOpen }: { row: EstimateShareTimelineRow; onOpen: () => void }) {
  const tone = toneFor(row.status)
  return (
    <MTapCard onClick={onOpen} borderLeft={`4px solid var(--m-${tone ?? 'line-2'})`}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <MPill tone={tone} dot>
          {statusPillLabel(row)}
        </MPill>
        <MI.ChevRight size={14} style={{ color: 'var(--m-ink-3)' }} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 2 }}>{row.project_name}</div>
      <div style={{ fontSize: 12, color: 'var(--m-ink-3)' }}>{row.customer_name ?? 'No customer'}</div>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 12,
          color: 'var(--m-ink-2)',
        }}
      >
        <span>Bid {formatMoney(row.bid_total)}</span>
        <span>{sentLabel(row.sent_at)}</span>
      </div>
    </MTapCard>
  )
}

function toneFor(status: EstimateShareTimelineStatus): 'green' | 'blue' | 'amber' | 'red' | undefined {
  switch (status) {
    case 'accepted':
      return 'green'
    case 'viewed':
      return 'blue'
    case 'sent':
      return 'amber'
    case 'declined':
      return 'red'
    case 'expired':
      return undefined
  }
}

function statusPillLabel(row: EstimateShareTimelineRow): string {
  switch (row.status) {
    case 'sent':
      return 'Sent'
    case 'viewed':
      return row.viewed_at ? `Viewed ${shortAgo(row.viewed_at)}` : 'Viewed'
    case 'accepted':
      return row.signer_name ? `Accepted · ${row.signer_name}` : 'Accepted'
    case 'declined':
      return 'Declined'
    case 'expired':
      return 'Expired'
  }
}

function sentLabel(iso: string): string {
  return `Sent ${shortAgo(iso)}`
}

/**
 * Tight relative-time formatter. Mirrors the helper used in foreman-field
 * and foreman-blocker-detail — kept inline rather than promoted to format.ts
 * so each screen can tweak its own thresholds without coordinating, but
 * we should consider promoting once a fourth caller shows up.
 */
function shortAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).valueOf()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
