import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { useProjects, type ProjectListRow, type ProjectStatus } from '@/lib/api'

/**
 * `prj-list` — Projects list with status filter chips.
 *
 * Filter chips mirror the design (Active / Bids / Closeout / Archive).
 * The API's project status vocabulary ('lead', 'active', 'completed',
 * 'archived') doesn't exactly match the chip labels — we map below.
 *
 * Tap a row → /projects/:id (Phase 2B detail shell).
 */
type FilterChip = 'active' | 'bids' | 'closeout' | 'archive'

const FILTERS: ReadonlyArray<{ key: FilterChip; label: string; status: ProjectStatus | undefined }> = [
  { key: 'active', label: 'Active', status: 'active' },
  { key: 'bids', label: 'Bids', status: 'lead' },
  { key: 'closeout', label: 'Closeout', status: 'completed' },
  { key: 'archive', label: 'Archive', status: 'archived' },
]

export function ProjectsListScreen() {
  const [chip, setChip] = useState<FilterChip>('active')
  const filter = FILTERS.find((f) => f.key === chip)!
  const params = filter.status ? { status: filter.status } : {}
  const projects = useProjects(params)
  const rows = projects.data?.projects ?? []

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Tab · Projects</div>
        <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Projects</h1>
        <div className="text-[12px] text-ink-3 mt-1">{projects.isPending ? 'Loading…' : `${rows.length} ${chip}`}</div>
      </div>

      <div className="px-4 pb-2 flex gap-1.5 overflow-x-auto scrollbar-hide">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setChip(f.key)}
            className={`shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium border transition-colors ${
              chip === f.key ? 'bg-accent text-white border-transparent' : 'bg-card-soft text-ink-2 border-line'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="px-4 pt-2 pb-8">
        {projects.isPending ? (
          <Card>
            <div className="text-[13px] text-ink-3">Loading projects…</div>
          </Card>
        ) : rows.length === 0 ? (
          <Card>
            <div className="text-[13px] font-semibold">No {chip} projects</div>
            <div className="text-[11px] text-ink-3 mt-1">
              {chip === 'bids'
                ? 'Bids land here when a project is created with status=lead.'
                : chip === 'closeout'
                  ? 'Projects move here after POST /api/projects/:id/closeout.'
                  : 'Add a project via Phase 2E project setup.'}
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            <Attribution source={`Live from /api/projects?status=${filter.status ?? 'any'}`} />
            {rows.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ProjectRow({ project }: { project: ProjectListRow }) {
  const updated = formatRelative(project.updated_at)
  const tone = project.status === 'active' ? 'good' : project.status === 'completed' ? 'default' : 'warn'
  const bid = Number(project.bid_total)
  return (
    <Link to={`/projects/${project.id}`} className="block">
      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold truncate">{project.name}</div>
            <div className="text-[11px] text-ink-3 mt-0.5 truncate">
              {project.customer_name ?? 'No customer'}
              {project.division_code ? ` · ${project.division_code}` : ''}
            </div>
          </div>
          <Pill tone={tone}>{project.status}</Pill>
        </div>
        <div className="flex items-center justify-between mt-2 text-[11px] text-ink-3">
          <span className="num">{bid > 0 ? `$${bid.toLocaleString()}` : 'No bid set'}</span>
          <span>updated {updated}</span>
        </div>
      </Card>
    </Link>
  )
}

function formatRelative(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const delta = Date.now() - ms
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
