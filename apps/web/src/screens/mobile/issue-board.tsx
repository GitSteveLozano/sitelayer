import { type ChangeEvent, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBanner, MBody, MButton, MChip, MChipRow, MSectionH, MSelect, MTopBar } from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { WorkRequestSeverityPill, WorkRequestStatusPill } from '../../components/work-requests/status.js'
import {
  useIssueBoard,
  useMoveIssueBoardItem,
  type IssueBoardGroupBy,
  type IssueBoardItem,
  type IssueBoardStatus,
} from '@/lib/api'
import { canTriageWorkRequests } from '@/lib/work-request-permissions'
import type { CompanyRole } from '@sitelayer/domain'

const STATUS_OPTIONS: ReadonlyArray<{ value: IssueBoardStatus; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'agent_running', label: 'Agent running' },
  { value: 'human_assigned', label: 'Human assigned' },
  { value: 'review_ready', label: 'Review ready' },
  { value: 'review_stale', label: 'Review stale' },
  { value: 'proposal_expired', label: 'Proposal expired' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'reopened', label: 'Reopened' },
  { value: 'wont_do', label: 'Wont do' },
]

export function MobileIssueBoard({ companyRole }: { companyRole: CompanyRole }) {
  const navigate = useNavigate()
  const canTriage = canTriageWorkRequests(companyRole)
  const [groupBy, setGroupBy] = useState<IssueBoardGroupBy>('status_group')
  const board = useIssueBoard({ groupBy, limit: 200 }, { enabled: canTriage })
  const move = useMoveIssueBoardItem()
  const movingId = move.variables?.id ?? null
  const itemCount = useMemo(() => board.data?.items.length ?? 0, [board.data?.items.length])

  const moveItem = (item: IssueBoardItem, status: IssueBoardStatus) => {
    if (status === item.status || status === 'reversed') return
    move.mutate({ id: item.id, input: { status, expectedUpdatedAt: item.updatedAt } })
  }

  return (
    <>
      <MTopBar back title="Issue board" onBack={() => navigate('/work')} />
      <MBody>
        {!canTriage ? (
          <div style={{ padding: '16px' }}>
            <MBanner tone="error" title="Forbidden" body="You do not have access to triage work items." />
          </div>
        ) : (
          <>
            <MChipRow>
              <MChip active={groupBy === 'status_group'} onClick={() => setGroupBy('status_group')}>
                Status
              </MChip>
              <MChip active={groupBy === 'lane'} onClick={() => setGroupBy('lane')}>
                Lane
              </MChip>
            </MChipRow>
            {board.error ? (
              <div style={{ padding: '0 16px 8px' }}>
                <MBanner
                  tone="error"
                  title="Load failed"
                  body={board.error instanceof Error ? board.error.message : 'Request failed.'}
                />
              </div>
            ) : null}
            {move.error ? (
              <div style={{ padding: '0 16px 8px' }}>
                <MBanner
                  tone="error"
                  title="Move failed"
                  body={move.error instanceof Error ? move.error.message : 'Request failed.'}
                />
              </div>
            ) : null}
            {board.isPending ? (
              <MSkeletonList count={5} />
            ) : itemCount === 0 ? (
              <div style={{ padding: '24px 16px', fontSize: 13, color: 'var(--m-ink-3)' }}>No work items.</div>
            ) : (
              <div style={{ display: 'grid', gap: 18, paddingBottom: 24 }}>
                {board.data?.columns.map((column) => (
                  <section key={column.id}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                        gap: 12,
                        padding: '4px 16px 0',
                      }}
                    >
                      <MSectionH>{column.title}</MSectionH>
                      <span
                        style={{
                          fontFamily: 'var(--m-num)',
                          fontSize: 11,
                          fontWeight: 700,
                          color: 'var(--m-ink-3)',
                        }}
                      >
                        {column.items.length}
                      </span>
                    </div>
                    <div style={{ borderTop: '2px solid var(--m-ink)' }}>
                      {column.items.length === 0 ? (
                        <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--m-ink-3)' }}>Empty</div>
                      ) : (
                        column.items.map((item) => (
                          <IssueBoardCard
                            key={item.id}
                            item={item}
                            disabled={move.isPending && movingId === item.id}
                            onOpen={() => navigate(`/work/${item.id}`)}
                            onMove={(status) => moveItem(item, status)}
                          />
                        ))
                      )}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
      </MBody>
    </>
  )
}

function IssueBoardCard({
  item,
  disabled,
  onOpen,
  onMove,
}: {
  item: IssueBoardItem
  disabled: boolean
  onOpen: () => void
  onMove: (status: IssueBoardStatus) => void
}) {
  const kind = (item.entityType ?? 'issue').toUpperCase()
  const meta = [item.route, relativeAge(item.createdAt), item.captureSessionId ? 'CAPTURED' : null]
    .filter(Boolean)
    .join(' · ')
  const onStatusChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onMove(event.target.value as IssueBoardStatus)
  }
  return (
    <article
      style={{
        padding: '16px',
        borderBottom: '2px solid var(--m-ink)',
        background: item.severity === 'urgent' ? 'var(--m-card-soft)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--m-accent-ink)',
            background: 'var(--m-accent)',
            border: '1.5px solid var(--m-ink)',
            padding: '3px 7px',
          }}
        >
          {kind}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <WorkRequestSeverityPill severity={item.severity} />
          <WorkRequestStatusPill status={item.status} />
        </span>
      </div>
      <div
        style={{
          marginTop: 10,
          fontFamily: 'var(--m-font-display)',
          fontSize: 16,
          fontWeight: 700,
          lineHeight: 1.3,
          color: 'var(--m-ink)',
        }}
      >
        {item.title}
      </div>
      {item.summary ? (
        <div style={{ marginTop: 6, fontSize: 14, lineHeight: 1.45, color: 'var(--m-ink-2)' }}>{item.summary}</div>
      ) : null}
      {meta ? (
        <div
          style={{
            marginTop: 12,
            fontFamily: 'var(--m-num)',
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--m-ink-3)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {meta.toUpperCase()}
        </div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 10, marginTop: 14 }}>
        <MSelect
          aria-label="Status"
          value={item.status}
          disabled={disabled || item.status === 'reversed'}
          onChange={onStatusChange}
        >
          {item.status === 'reversed' ? (
            <option value="reversed" disabled>
              Reversed
            </option>
          ) : null}
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </MSelect>
        <MButton size="sm" variant="ghost" onClick={onOpen}>
          Open
        </MButton>
      </div>
    </article>
  )
}

function relativeAge(iso: string): string | null {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return null
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
