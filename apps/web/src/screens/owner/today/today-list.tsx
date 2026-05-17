import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution, StripeCard } from '@/components/ai'
import { type CrewScheduleRow } from '@/lib/api'
import type { AttentionItem } from './attention-list'

interface TodayListProps {
  projects: CrewScheduleRow[]
  totalHoursToday: number
  /** Real per-project hours from `pairClockSpans` so each row can show "4.2h" per Sitemap §03 panel 2. */
  hoursByProjectId: Map<string, number>
}
export function TodayList({ projects, totalHoursToday, hoursByProjectId }: TodayListProps) {
  // Group by project_id — multiple schedules per project today collapse
  // into one row.
  const byProject = new Map<string, CrewScheduleRow[]>()
  for (const s of projects) {
    const list = byProject.get(s.project_id) ?? []
    list.push(s)
    byProject.set(s.project_id, list)
  }
  const rows = Array.from(byProject.entries()).slice(0, 3)

  return (
    <div className="space-y-2.5">
      {rows.length === 0 ? (
        <Card>
          <div className="text-[13px] font-semibold">No projects today</div>
          <div className="text-[11px] text-ink-3 mt-1">Schedule something via Projects → Schedule.</div>
        </Card>
      ) : (
        rows.map(([projectId, scheds]) => {
          const first = scheds[0]
          const crewCount = first?.crew && Array.isArray(first.crew) ? (first.crew as unknown[]).length : 0
          const hours = hoursByProjectId.get(projectId) ?? 0
          return (
            <Link key={projectId} to={`/projects/${projectId}`} className="block">
              <Card>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold truncate">{first?.project_name ?? 'Project'}</div>
                    <div className="text-[11px] text-ink-3 mt-1 truncate">
                      {scheds.length} scope · {crewCount} on plan
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <span className="font-mono tabular-nums text-[15px] font-semibold">
                      {hours > 0 ? `${hours.toFixed(1)}h` : '—'}
                    </span>
                    <Pill tone={first?.status === 'confirmed' ? 'good' : 'warn'}>{first?.status ?? '—'}</Pill>
                  </div>
                </div>
              </Card>
            </Link>
          )
        })
      )}
      {totalHoursToday > 0 ? (
        <div className="pt-2 px-1 text-[11px] text-ink-3 text-center">
          {totalHoursToday.toFixed(1)} crew-hrs logged so far today.
        </div>
      ) : null}
      <div className="pt-3 text-center text-[12px] text-ink-4">Tap a project for detail. Pull down to refresh.</div>
    </div>
  )
}

/**
 * Single inline preview of the highest-priority attention item, shown
 * on the calm/today view when at least one item exists. The full
 * attention list still lives behind the "what needs me?" chip; this
 * preview is the design audit's "with attention card" state — calm
 * view morphs to surface one signal without leaving the today filter.
 *
 * Tapping "See all N →" jumps to the attention chip, where the user
 * can dismiss / approve / open project per the existing affordances.
 */
export function InlineAttentionPreview({
  top,
  totalCount,
  onSeeAll,
}: {
  top: AttentionItem
  totalCount: number
  onSeeAll: () => void
}) {
  return (
    <StripeCard tone={top.tone}>
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-warn">{top.eyebrow}</div>
        {totalCount > 1 ? (
          <button
            type="button"
            onClick={onSeeAll}
            className="text-[11px] text-accent font-medium underline-offset-2 hover:underline shrink-0"
          >
            See all {totalCount} →
          </button>
        ) : null}
      </div>
      <div className="text-[14.5px] font-semibold leading-snug">{top.title}</div>
      <div className="text-[12px] text-ink-2 mt-1 leading-relaxed">{top.detail}</div>
      <div className="mt-2.5 pt-2.5 border-t border-dashed border-line-2 flex items-center justify-between gap-2">
        <Attribution source={top.attribution} state="muted" />
        <Link to={top.action_to}>
          <MobileButton variant="primary" size="sm" fullWidth={false}>
            {top.action_label}
          </MobileButton>
        </Link>
      </div>
    </StripeCard>
  )
}
