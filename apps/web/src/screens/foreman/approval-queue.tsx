import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { CleanBulkCard, TimeReviewRunCard, groupRunsByState, timeReviewStateLabel } from '@/components/time-review'
import {
  useProjects,
  useTimeReviewRuns,
  type ProjectListRow,
  type TimeReviewRunRow,
  type TimeReviewState,
} from '@/lib/api'

/**
 * `t-approve` — Time review approval queue (Sitemap §8 panel 1).
 *
 * Lists time_review_runs grouped into clean (no anomalies) and needs-
 * review (anomaly_count > 0). The clean group gets a single bulk
 * approve CTA; needs-review rows get per-row Approve / Dispute.
 *
 * The screen fetches all states in one shot so the tab strip can show
 * counts without three separate queries — staleness is the same since
 * any APPROVE/DISPUTE invalidates the whole list.
 *
 * "Disputed" is a UI rename of the workflow's `rejected` state. The
 * column on the row stays `rejected`; only the label moved.
 */
export function ApprovalQueueScreen() {
  const [tab, setTab] = useState<TimeReviewState>('pending')
  // null = "All projects". Workspace-wide rows (project_id===null)
  // get a synthetic key so they can be filtered alongside real ones.
  const [projectFilter, setProjectFilter] = useState<string | null>(null)
  const allRuns = useTimeReviewRuns()
  const projects = useProjects()
  const projectById = useMemo(() => new Map((projects.data?.projects ?? []).map((p) => [p.id, p])), [projects.data])

  const rows = allRuns.data?.timeReviewRuns ?? []
  const filteredRows = useMemo(() => {
    if (!projectFilter) return rows
    if (projectFilter === WORKSPACE_KEY) return rows.filter((r) => !r.project_id)
    return rows.filter((r) => r.project_id === projectFilter)
  }, [rows, projectFilter])
  const byState = useMemo(() => groupRunsByState(filteredRows), [filteredRows])
  const visible = byState[tab]
  const cleanPending = useMemo(() => byState.pending.filter((r) => r.anomaly_count === 0), [byState.pending])
  const reviewPending = useMemo(() => byState.pending.filter((r) => r.anomaly_count > 0), [byState.pending])

  const pendingEntryTotal = byState.pending.reduce((sum, r) => sum + r.total_entries, 0)
  const pendingAnomalyTotal = byState.pending.reduce((sum, r) => sum + r.anomaly_count, 0)

  // Chip set: every project that has at least one pending run, plus a
  // workspace-wide chip when any pending row has no project_id. We
  // derive the chip list from the unfiltered set so toggling chips
  // never empties the row that produced them.
  const chips = useMemo(() => buildProjectChips(rows, projectById), [rows, projectById])

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="font-display text-[28px] font-bold tracking-tight leading-tight">Time</h1>
          <Link
            to="/time/new"
            className="text-[12px] font-semibold text-accent shrink-0"
            data-testid="add-manual-entry"
          >
            + Add entry
          </Link>
        </div>
        <div className="text-[12px] text-ink-3 mt-1 flex items-center justify-between gap-2">
          <span>
            <span className="num font-medium">{pendingEntryTotal}</span> entr{pendingEntryTotal === 1 ? 'y' : 'ies'}{' '}
            waiting
            {pendingAnomalyTotal > 0 ? (
              <>
                {' · '}
                <span className="text-warn font-medium">
                  <span className="num">{pendingAnomalyTotal}</span> anomal{pendingAnomalyTotal === 1 ? 'y' : 'ies'}
                </span>
              </>
            ) : null}
          </span>
          <span className="flex items-center gap-3">
            <Link to="/time/burden" className="text-accent font-medium">
              Burden →
            </Link>
            <Link to="/time/vs" className="text-accent font-medium">
              Vs plan →
            </Link>
          </span>
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="px-4 pb-3 -mx-1 overflow-x-auto scrollbar-hide">
          <div className="flex gap-1.5 mx-1 whitespace-nowrap">
            <ProjectChip
              label="All"
              count={rows.filter((r) => r.state === 'pending').length}
              active={projectFilter === null}
              onClick={() => setProjectFilter(null)}
            />
            {chips.map((c) => (
              <ProjectChip
                key={c.key}
                label={c.label}
                count={c.pendingCount}
                active={projectFilter === c.key}
                onClick={() => setProjectFilter(c.key)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="px-4 border-b border-line">
        <div className="flex gap-1">
          {(['pending', 'approved', 'rejected'] as TimeReviewState[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`relative flex-1 py-3 text-[13px] font-medium ${tab === t ? 'text-ink' : 'text-ink-3'}`}
            >
              {timeReviewStateLabel(t)}
              {byState[t].length > 0 ? (
                <span
                  className={`ml-1.5 inline-block px-1.5 py-px rounded-full text-[10px] font-mono tabular-nums font-semibold ${
                    tab === t ? 'bg-ink text-white' : 'bg-card-soft text-ink-3'
                  }`}
                >
                  {byState[t].length}
                </span>
              ) : null}
              {tab === t ? <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pt-4 pb-8 space-y-3">
        {allRuns.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading…</div>
          </Card>
        ) : tab === 'pending' ? (
          <PendingTab clean={cleanPending} review={reviewPending} projectById={projectById} />
        ) : visible.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No {timeReviewStateLabel(tab).toLowerCase()} runs.</div>
            <div className="text-[11px] text-ink-3 mt-1">Runs land here once they transition.</div>
          </Card>
        ) : (
          <>
            {visible.map((row) => (
              <TimeReviewRunCard key={row.id} row={row} projectById={projectById} />
            ))}
            <Attribution source="Live from /api/time-review-runs" />
          </>
        )}
      </div>
    </div>
  )
}

function PendingTab({
  clean,
  review,
  projectById,
}: {
  clean: TimeReviewRunRow[]
  review: TimeReviewRunRow[]
  projectById: Map<string, ProjectListRow>
}) {
  if (clean.length === 0 && review.length === 0) {
    return (
      <Card tight>
        <div className="text-[12px] text-ink-3">No pending runs.</div>
        <div className="text-[11px] text-ink-3 mt-1">Create one from POST /api/time-review-runs to start a review.</div>
      </Card>
    )
  }
  // Group needs-review by project so the cross-project queue reads
  // like a triage list. Each group keeps the project header, then the
  // run cards underneath drop their (now redundant) project name.
  const reviewGroups = useMemo(() => groupByProject(review, projectById), [review, projectById])
  return (
    <>
      {clean.length > 0 ? <CleanBulkCard runs={clean} /> : null}
      {review.length > 0 ? (
        <>
          <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
            Needs review ({review.length})
          </div>
          {reviewGroups.map((group) => (
            <div key={group.key} className="space-y-2">
              <div className="px-1 pt-2 flex items-baseline justify-between">
                <span className="text-[12px] font-semibold">{group.label}</span>
                <span className="font-mono tabular-nums text-[11px] text-ink-3">
                  {group.runs.length} run{group.runs.length === 1 ? '' : 's'}
                </span>
              </div>
              {group.runs.map((row) => (
                <TimeReviewRunCard key={row.id} row={row} projectById={projectById} hideProject />
              ))}
            </div>
          ))}
        </>
      ) : null}
      <Attribution source="Live from /api/time-review-runs" />
    </>
  )
}

// Synthetic key for workspace-wide rows (project_id === null) so the
// chip filter can hold a string state without needing a tri-state.
const WORKSPACE_KEY = '__workspace__'

interface ProjectChipEntry {
  key: string
  label: string
  pendingCount: number
}

function buildProjectChips(rows: TimeReviewRunRow[], projectById: Map<string, ProjectListRow>): ProjectChipEntry[] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.state !== 'pending') continue
    const key = r.project_id ?? WORKSPACE_KEY
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const entries: ProjectChipEntry[] = []
  for (const [key, count] of counts) {
    const label = key === WORKSPACE_KEY ? 'Workspace' : (projectById.get(key)?.name ?? `Project ${key.slice(0, 8)}…`)
    entries.push({ key, label, pendingCount: count })
  }
  // Highest-count chips first — surfaces where the work is.
  entries.sort((a, b) => b.pendingCount - a.pendingCount || a.label.localeCompare(b.label))
  return entries
}

function ProjectChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12px] font-medium border ${
        active ? 'bg-ink text-white border-ink' : 'bg-card text-ink-2 border-line'
      }`}
    >
      {label}
      <span
        className={`font-mono tabular-nums text-[10px] font-semibold px-1 rounded ${
          active ? 'bg-white/20 text-white' : 'bg-card-soft text-ink-3'
        }`}
      >
        {count}
      </span>
    </button>
  )
}

interface ReviewGroup {
  key: string
  label: string
  runs: TimeReviewRunRow[]
}

function groupByProject(rows: TimeReviewRunRow[], projectById: Map<string, ProjectListRow>): ReviewGroup[] {
  const map = new Map<string, ReviewGroup>()
  for (const r of rows) {
    const key = r.project_id ?? WORKSPACE_KEY
    const label =
      key === WORKSPACE_KEY ? 'Workspace-wide' : (projectById.get(key)?.name ?? `Project ${key.slice(0, 8)}…`)
    const group = map.get(key) ?? { key, label, runs: [] }
    group.runs.push(r)
    map.set(key, group)
  }
  return Array.from(map.values()).sort((a, b) => b.runs.length - a.runs.length || a.label.localeCompare(b.label))
}
