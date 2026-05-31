/**
 * Field events inbox — `fm-field`. Lists open worker_issues with severity
 * stripes + type pills + worker avatar. Tap a row to see the message and
 * resolve it (PATCH /api/worker-issues/:id when implemented; for Phase 8
 * we surface the detail and a stub Resolve button).
 *
 * AI summary stripe appears when 3+ events are open within the last hour
 * for the same project — same heuristic as the foreman README's "3 events
 * in <30 min" trigger, relaxed slightly because we don't have realtime.
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet, type BootstrapResponse } from '@/lib/api'
import { MBody, MChip, MChipRow, MI, MPill, MTopBar } from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'

type IssueRow = {
  id: string
  project_id: string | null
  worker_id: string | null
  reporter_clerk_user_id: string
  kind: string
  message: string
  /** Typed urgency band. Present on the list DTO since worker-issues.ts
   *  ISSUE_COLUMNS selects it; the message-tag fallback covers legacy rows. */
  severity?: 'question' | 'slowing' | 'stopped' | null
  resolved_at: string | null
  resolved_by_clerk_user_id: string | null
  created_at: string
}

type Filter = 'all' | 'blockers' | 'photos' | 'resolved'

export function ForemanField({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const [issues, setIssues] = useState<readonly IssueRow[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const refresh = async () => {
    try {
      const r = await apiGet<{ worker_issues: IssueRow[] }>('/api/worker-issues?resolved=true', companySlug)
      setIssues(r.worker_issues ?? [])
    } catch {
      setIssues([])
    }
  }

  useEffect(() => {
    void refresh()
  }, [companySlug])

  const counts = useMemo(() => {
    const arr = issues ?? []
    const open = arr.filter((i) => !i.resolved_at)
    return {
      all: open.length,
      blockers: open.filter((i) => isPhotoLog(i) === false).length,
      photos: open.filter((i) => isPhotoLog(i)).length,
      resolved: arr.filter((i) => i.resolved_at).length,
    }
  }, [issues])

  const visible = useMemo(() => {
    if (!issues) return []
    if (filter === 'resolved') return issues.filter((i) => i.resolved_at)
    const open = issues.filter((i) => !i.resolved_at)
    if (filter === 'all') return open
    if (filter === 'blockers') return open.filter((i) => !isPhotoLog(i))
    if (filter === 'photos') return open.filter((i) => isPhotoLog(i))
    return open
  }, [issues, filter])

  return (
    <>
      <MTopBar title="Field" actionIcon={<MI.AlertTri size={20} />} actionLabel="Filter" />
      <MBody>
        <div style={{ padding: '16px 20px 4px' }}>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              color: 'var(--m-ink-3)',
              fontWeight: 700,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
            }}
          >
            Field · today
          </div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '-0.02em',
              textTransform: 'uppercase',
              marginTop: 4,
            }}
          >
            {counts.all} incoming{' '}
            {counts.all > 0 ? (
              <span style={{ color: 'var(--m-red)', fontSize: 13, fontWeight: 700, marginLeft: 4 }}>· need you</span>
            ) : null}
          </div>
        </div>
        <MChipRow>
          <MChip active={filter === 'all'} onClick={() => setFilter('all')} count={counts.all}>
            All
          </MChip>
          <MChip active={filter === 'blockers'} onClick={() => setFilter('blockers')} count={counts.blockers}>
            Blockers
          </MChip>
          <MChip active={filter === 'photos'} onClick={() => setFilter('photos')} count={counts.photos}>
            Photos
          </MChip>
          <MChip active={filter === 'resolved'} onClick={() => setFilter('resolved')} count={counts.resolved}>
            Resolved
          </MChip>
        </MChipRow>
        {issues === null ? (
          <MSkeletonList count={4} />
        ) : visible.length === 0 ? (
          <MEmptyState title="No open events" body="Nice quiet day." />
        ) : (
          <>
            <ClusterStripe issues={visible} bootstrap={bootstrap} />
            {visible.map((i) => {
              const w = bootstrap?.workers.find((x) => x.id === i.worker_id)
              const p = bootstrap?.projects.find((x) => x.id === i.project_id)
              const resolved = Boolean(i.resolved_at)
              const photo = isPhotoLog(i)
              const sev = severityFromMessage(i)
              const tone = resolved ? 'green' : photo ? 'blue' : sevTone(sev, i.kind)
              const pillLabel = resolved
                ? 'resolved'
                : photo
                  ? 'photo'
                  : (sev ?? (i.kind === 'safety' ? 'stopped' : 'blocker'))
              // The message body carries inline `[tag]` markers (photo_log,
              // severity) that aren't meant for the foreman — strip them.
              const body = i.message
                .replace(/^\[[^\]]+\]\s*/, '')
                .replace(/\[severity:[^\]]+\]/g, '')
                .trim()
              return (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => navigate(`/foreman/blocker/${i.id}`)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '16px 20px',
                    borderTop: 'none',
                    borderRight: 'none',
                    borderLeft: 'none',
                    borderBottom: '2px solid var(--m-ink)',
                    // Blockers ride the warmer sand fill; photos/notes use the soft tint.
                    background: photo || resolved ? 'var(--m-card-soft)' : 'var(--m-sand-2)',
                    color: 'var(--m-ink)',
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: 'var(--m-num)',
                        fontWeight: 700,
                        fontSize: 11,
                        letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                      }}
                    >
                      <span>{w?.name ?? 'Unknown worker'}</span>
                      {' · '}
                      <span>{p?.name ?? 'unknown'}</span>
                    </div>
                    <MPill tone={tone}>{pillLabel}</MPill>
                  </div>
                  <div style={{ fontSize: 15, lineHeight: 1.45, color: 'var(--m-ink)' }}>{body}</div>
                  {photo ? (
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      {Array.from({ length: 4 }).map((_, j) => (
                        <div
                          key={j}
                          style={{
                            width: 54,
                            height: 54,
                            background: 'linear-gradient(135deg, #E8A86B 0%, #A05A33 100%)',
                            border: '2px solid var(--m-ink)',
                          }}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      marginTop: 12,
                    }}
                  >
                    <span
                      className="m-btn"
                      data-variant={photo || resolved ? 'ghost' : 'primary'}
                      style={{ flex: 2, minHeight: 48, fontSize: 14 }}
                    >
                      {resolved ? 'VIEW' : photo ? 'REPLY' : 'ORDER MATERIALS'}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--m-num)',
                        fontWeight: 700,
                        color: 'var(--m-ink-3)',
                        fontSize: 12,
                      }}
                    >
                      {shortAgo(i.created_at)}
                    </span>
                  </div>
                </button>
              )
            })}
          </>
        )}
      </MBody>
    </>
  )
}

function ClusterStripe({ issues, bootstrap }: { issues: readonly IssueRow[]; bootstrap: BootstrapResponse | null }) {
  // Groups by project, surfaces an AI stripe when 3+ open events are on
  // the same site within the last hour. Heuristic; tune in production.
  // Cutoff captured lazily at mount; "last hour" drifts relative to first
  // render, which is fine for this surface — re-mounting refreshes it. The
  // React Compiler auto-memoizes the body, so no manual useMemo here.
  const [cutoff] = useState(() => Date.now() - 60 * 60 * 1000)
  const cluster = computeCluster(issues, bootstrap?.projects ?? [], cutoff)

  if (!cluster) return null
  return (
    <div style={{ padding: '0 16px 12px' }}>
      <MAiStripe
        tone="warn"
        eyebrow="Cluster"
        title={`${cluster.project} has ${cluster.count} open events in the last hour`}
        attribution={
          <>
            Based on <strong>open issues</strong>.
          </>
        }
      >
        Likely the same root cause. Resolve once and ack the rest.
      </MAiStripe>
    </div>
  )
}

function isPhotoLog(i: IssueRow): boolean {
  return /^\[photo_log\]/.test(i.message)
}

/** Reads the typed `severity` column off the list DTO, falling back to the
 *  legacy `[severity:...]` message tag for rows created before the column was
 *  wired (worker-issue.tsx now sends severity as a field). */
function severityFromMessage(i: IssueRow): 'question' | 'slowing' | 'stopped' | null {
  if (i.severity) return i.severity
  const m = i.message.match(/\[severity:(question|slowing|stopped)\]/)
  return (m?.[1] as 'question' | 'slowing' | 'stopped' | undefined) ?? null
}

function sevTone(sev: 'question' | 'slowing' | 'stopped' | null, kind: string): 'red' | 'amber' | 'blue' {
  if (sev === 'stopped' || kind === 'safety') return 'red'
  if (sev === 'slowing') return 'amber'
  if (sev === 'question') return 'blue'
  return 'amber'
}

function computeCluster(
  issues: readonly IssueRow[],
  projects: readonly { id: string; name: string }[],
  cutoff: number,
): { project: string; count: number } | null {
  const map = new Map<string, IssueRow[]>()
  for (const i of issues) {
    if (i.resolved_at) continue
    if (new Date(i.created_at).valueOf() < cutoff) continue
    if (!i.project_id) continue
    const arr = map.get(i.project_id) ?? []
    arr.push(i)
    map.set(i.project_id, arr)
  }
  for (const [pid, arr] of map) {
    if (arr.length >= 3) {
      const project = projects.find((p) => p.id === pid)
      return { project: project?.name ?? 'A site', count: arr.length }
    }
  }
  return null
}

function shortAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).valueOf()
  if (!Number.isFinite(ms) || ms < 0) return iso
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}
