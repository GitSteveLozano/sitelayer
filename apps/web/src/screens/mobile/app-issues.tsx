import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { MBanner, MBody, MChip, MChipRow, MSectionH, MTopBar } from '../../components/m/index.js'
import { MSkeletonList } from '../../components/m-states/index.js'
import { WorkRequestSeverityPill, WorkRequestStatusPill } from '../../components/work-requests/status.js'
import { useAppIssueBoard, useAppIssueCapabilities, type AppIssue, type AppIssueBoardGroupBy } from '@/lib/api'

/**
 * Capability gate for the /issues route. Renders the board only when the caller
 * effectively holds `app_issue.view` (off /api/session); otherwise redirects to
 * /more so a non-platform-admin never lands on (or even briefly sees) the
 * internal board. Defense-in-depth: the API 403s regardless of this gate.
 */
export function MobileAppIssuesGate() {
  const caps = useAppIssueCapabilities()
  if (caps.isPending) {
    return (
      <>
        <MTopBar title="App issues" />
        <MBody>
          <MSkeletonList count={5} />
        </MBody>
      </>
    )
  }
  if (!caps.data?.includes('app_issue.view')) {
    return <Navigate to="/more" replace />
  }
  return <MobileAppIssues />
}

/**
 * The internal APP-ISSUE board — read-only view over the `app_issue` half of
 * context_work_items, gated server-side by the PLATFORM capability
 * `app_issue.view`. The route is only mounted for callers who hold the
 * capability (App.tsx reads `session.app_issue_capabilities`), and the API 403s
 * regardless, so a non-platform-admin can neither see nor reach it. Reuses the
 * field-request work board card components (status/severity pills) for parity.
 */
export function MobileAppIssues() {
  const navigate = useNavigate()
  const [groupBy, setGroupBy] = useState<AppIssueBoardGroupBy>('status_group')
  const board = useAppIssueBoard({ groupBy, limit: 200 })
  const itemCount = board.data?.issues.length ?? 0

  return (
    <>
      <MTopBar back title="App issues" onBack={() => navigate('/more')} />
      <MBody>
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
        {board.isPending ? (
          <MSkeletonList count={5} />
        ) : itemCount === 0 ? (
          <div style={{ padding: '24px 16px', fontSize: 13, color: 'var(--m-ink-3)' }}>No app issues.</div>
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
                    {column.work_items.length}
                  </span>
                </div>
                <div style={{ borderTop: '2px solid var(--m-ink)' }}>
                  {column.work_items.length === 0 ? (
                    <div style={{ padding: '14px 16px', fontSize: 13, color: 'var(--m-ink-3)' }}>Empty</div>
                  ) : (
                    column.work_items.map((item) => <AppIssueCard key={item.id} item={item} />)
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </MBody>
    </>
  )
}

function AppIssueCard({ item }: { item: AppIssue }) {
  const meta = [item.route, relativeAge(item.created_at), item.capture_session_id ? 'CAPTURED' : null]
    .filter(Boolean)
    .join(' · ')
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
          APP ISSUE
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
