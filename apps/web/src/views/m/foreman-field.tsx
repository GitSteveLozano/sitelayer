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
import { apiGet, apiPatch, type BootstrapResponse } from '../../api.js'
import {
  MBody,
  MButton,
  MChip,
  MChipRow,
  MI,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
  avatarToneFor,
  initialsFor,
  MAvatar,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { MEmptyState, MSkeletonList } from '../../components/m-states/index.js'
import { timeOfDay } from './format.js'

type IssueRow = {
  id: string
  project_id: string | null
  worker_id: string | null
  reporter_clerk_user_id: string
  kind: string
  message: string
  resolved_at: string | null
  resolved_by_clerk_user_id: string | null
  created_at: string
}

type Filter = 'all' | 'blockers' | 'photos' | 'resolved'

export function ForemanField({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const [issues, setIssues] = useState<readonly IssueRow[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<IssueRow | null>(null)
  const [busy, setBusy] = useState(false)

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  if (selected) {
    return (
      <ForemanIssueDetail
        issue={selected}
        bootstrap={bootstrap}
        busy={busy}
        onResolve={async () => {
          setBusy(true)
          try {
            await apiPatch(`/api/worker-issues/${selected.id}`, { resolved: true }, companySlug)
            await refresh()
            setSelected(null)
          } catch {
            // PATCH may not exist server-side yet; close anyway.
            setSelected(null)
          } finally {
            setBusy(false)
          }
        }}
        onBack={() => setSelected(null)}
      />
    )
  }

  return (
    <>
      <MTopBar title="Field" actionIcon={<MI.AlertTri size={20} />} actionLabel="Filter" />
      <MBody>
        <div style={{ padding: '8px 16px 0' }}>
          <div
            style={{
              fontSize: 11,
              color: 'var(--m-ink-3)',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            From the field · today
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>
            {counts.all} incoming{' '}
            {counts.all > 0 ? (
              <span style={{ color: 'var(--m-red)', fontSize: 13, fontWeight: 600, marginLeft: 4 }}>· need you</span>
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
            <MListInset>
              {visible.map((i) => {
                const w = bootstrap?.workers.find((x) => x.id === i.worker_id)
                const p = bootstrap?.projects.find((x) => x.id === i.project_id)
                const resolved = Boolean(i.resolved_at)
                const photo = isPhotoLog(i)
                const tone = photo ? 'blue' : i.kind === 'safety' ? 'red' : 'amber'
                return (
                  <MListRow
                    key={i.id}
                    leading={
                      w ? (
                        <MAvatar initials={initialsFor(w.name)} tone={avatarToneFor(w.id)} size="sm" />
                      ) : (
                        <MI.Users size={18} />
                      )
                    }
                    leadingTone={resolved ? 'green' : tone}
                    headline={w?.name ?? 'Unknown worker'}
                    supporting={`${p?.name ?? 'unknown'} · ${shortAgo(i.created_at)}`}
                    trailing={
                      <MPill tone={resolved ? 'green' : tone}>
                        {resolved ? 'resolved' : photo ? 'photo' : i.kind === 'safety' ? 'safety' : 'blocker'}
                      </MPill>
                    }
                    chev
                    onTap={() => setSelected(i)}
                  />
                )
              })}
            </MListInset>
          </>
        )}
      </MBody>
    </>
  )
}

function ClusterStripe({ issues, bootstrap }: { issues: readonly IssueRow[]; bootstrap: BootstrapResponse | null }) {
  // Groups by project, surfaces an AI stripe when 3+ open events are on
  // the same site within the last hour. Heuristic; tune in production.
  const cluster = useMemo(() => {
    const map = new Map<string, IssueRow[]>()
    const cutoff = Date.now() - 60 * 60 * 1000
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
        const project = bootstrap?.projects.find((p) => p.id === pid)
        return { project: project?.name ?? 'A site', count: arr.length }
      }
    }
    return null
  }, [issues, bootstrap?.projects])

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

function ForemanIssueDetail({
  issue,
  bootstrap,
  busy,
  onResolve,
  onBack,
}: {
  issue: IssueRow
  bootstrap: BootstrapResponse | null
  busy: boolean
  onResolve: () => void
  onBack: () => void
}) {
  const w = bootstrap?.workers.find((x) => x.id === issue.worker_id)
  const p = bootstrap?.projects.find((x) => x.id === issue.project_id)
  const resolved = Boolean(issue.resolved_at)
  return (
    <>
      <MTopBar back title="Field event" sub={p?.name} onBack={onBack} />
      <MBody pad>
        <div className="m-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {w ? <MAvatar initials={initialsFor(w.name)} tone={avatarToneFor(w.id)} size="lg" /> : null}
            <div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>{w?.name ?? 'Unknown worker'}</div>
              <div className="m-quiet-sm">
                {shortAgo(issue.created_at)} · {timeOfDay(issue.created_at)}
              </div>
            </div>
          </div>
          <div style={{ borderTop: '1px solid var(--m-line)', margin: '12px 0' }} />
          <MPill tone={resolved ? 'green' : issue.kind === 'safety' ? 'red' : 'amber'}>
            {issue.kind.replace(/_/g, ' ')}
          </MPill>
          <div style={{ fontSize: 15, lineHeight: 1.5, marginTop: 10 }}>
            {issue.message.replace(/^\[[^\]]+\]\s*/, '')}
          </div>
        </div>
        {!resolved ? (
          <>
            <MSectionH>How are you fixing it?</MSectionH>
            <MListInset>
              <MListRow
                leading={<MI.Truck size={18} />}
                headline="Order more"
                supporting="Drewski's preferred vendor"
                chev
              />
              <MListRow
                leading={<MI.Home size={18} />}
                headline="Bring from another site"
                supporting="Pick a truck"
                chev
              />
              <MListRow
                leading={<MI.Check size={18} />}
                headline="Use what's on hand"
                supporting="Reply to worker"
                chev
              />
              <MListRow leading={<MI.Clock size={18} />} headline="Park for now" supporting="Low priority" chev />
            </MListInset>
            <div style={{ padding: 16 }}>
              <MButton variant="primary" onClick={onResolve} disabled={busy}>
                {busy ? 'Resolving…' : 'Send & resolve'}
              </MButton>
            </div>
          </>
        ) : (
          <div style={{ padding: '16px', fontSize: 13, color: 'var(--m-green)', textAlign: 'center' }}>
            Resolved {issue.resolved_at ? shortAgo(issue.resolved_at) : ''}
          </div>
        )}
      </MBody>
    </>
  )
}

function isPhotoLog(i: IssueRow): boolean {
  return /^\[photo_log\]/.test(i.message)
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
