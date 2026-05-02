import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Sheet, Pill, Avatar } from '@/components/mobile'
import { useProjects, type ProjectListRow } from '@/lib/api'
import { useCurrentProjectId } from '@/lib/current-project'
import { cn } from '@/lib/cn'

/**
 * Project switcher bottom sheet — Sitemap §02 panel 4 ("Switch project").
 *
 * Triggered from the drawer's avatar header. Shows:
 *   - Search box (debounced, server-side ILIKE via `useProjects({q})`).
 *   - PINNED list — currently the persisted current project + the
 *     three most-recently-updated active projects (placeholder for a
 *     real "pinned" persistence model in Phase 2).
 *
 * Tapping a row sets the current-project pin and navigates to its
 * detail screen. The sheet closes on selection.
 */
export interface ProjectSwitcherSheetProps {
  open: boolean
  onClose: () => void
}

export function ProjectSwitcherSheet({ open, onClose }: ProjectSwitcherSheetProps) {
  const [searchInput, setSearchInput] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQ(searchInput.trim()), 200)
    return () => window.clearTimeout(id)
  }, [searchInput])

  // Reset the search field whenever the sheet closes so re-opening
  // starts fresh — avoids surprising stale state on second open.
  useEffect(() => {
    if (!open) setSearchInput('')
  }, [open])

  return (
    <Sheet open={open} onClose={onClose} title="Switch project">
      <div className="flex flex-col gap-3">
        <label className="relative block">
          <span className="sr-only">Search projects</span>
          <span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              width="16"
              height="16"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </span>
          <input
            type="search"
            autoFocus
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search projects, addresses…"
            className="w-full h-10 pl-9 pr-3 rounded-[12px] bg-card-soft border border-line text-[14px] focus:outline-none focus:border-accent"
          />
        </label>

        <SwitcherList query={debouncedQ} onSelect={onClose} />
      </div>
    </Sheet>
  )
}

function SwitcherList({ query, onSelect }: { query: string; onSelect: () => void }) {
  const [currentId, setCurrentId] = useCurrentProjectId()
  const navigate = useNavigate()

  // Always fetch active projects; if the user is searching we widen
  // the filter so non-active matches surface too.
  const params = useMemo(
    () => (query ? { q: query, limit: 12 } : { status: 'active' as const, limit: 12 }),
    [query],
  )
  const projects = useProjects(params)
  const rows = projects.data?.projects ?? []

  const sorted = useMemo(() => {
    if (!currentId) return rows
    // Pin the current project to the top so the sheet always opens
    // with the user's primary in the first slot.
    const pinned = rows.find((p) => p.id === currentId)
    if (!pinned) return rows
    return [pinned, ...rows.filter((p) => p.id !== currentId)]
  }, [rows, currentId])

  const handlePick = (project: ProjectListRow) => {
    setCurrentId(project.id)
    navigate(`/projects/${project.id}`)
    onSelect()
  }

  if (projects.isPending) {
    return <div className="text-[13px] text-ink-3 px-1 py-3">Loading projects…</div>
  }
  if (projects.isError) {
    return <div className="text-[13px] text-bad px-1 py-3">Couldn't load projects.</div>
  }
  if (sorted.length === 0) {
    return (
      <div className="text-[13px] text-ink-3 px-1 py-6 text-center">
        {query ? `No matches for "${query}".` : 'No active projects yet.'}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div className="px-1 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-3">
        {query ? 'Matches' : 'Pinned'}
      </div>
      <ul className="flex flex-col gap-1">
        {sorted.map((p) => (
          <li key={p.id}>
            <SwitcherRow project={p} active={p.id === currentId} onPick={() => handlePick(p)} />
          </li>
        ))}
      </ul>
    </div>
  )
}

function SwitcherRow({
  project,
  active,
  onPick,
}: {
  project: ProjectListRow
  active: boolean
  onPick: () => void
}) {
  const tone = project.status === 'active' ? 'good' : project.status === 'completed' ? 'default' : 'warn'
  const initials = project.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('') || '··'
  const customer = project.customer_name ?? 'No customer'

  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'flex items-center gap-3 px-3 py-3 rounded-[14px] text-left',
        'border border-line bg-bg active:bg-card-soft',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        active ? 'ring-2 ring-accent border-transparent' : '',
      )}
    >
      <Avatar size="md" tone="amber" initials={initials} />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold tracking-tight truncate">{project.name}</div>
        <div className="text-[11px] text-ink-3 truncate">
          {customer}
          {project.division_code ? ` · ${project.division_code}` : ''}
        </div>
      </div>
      <Pill tone={tone}>{project.status}</Pill>
    </button>
  )
}
