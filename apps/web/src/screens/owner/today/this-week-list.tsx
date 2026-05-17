import { Link } from 'react-router-dom'
import { Card, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { type CrewScheduleRow } from '@/lib/api'
import { formatDayLabel } from './helpers'

// ---------------------------------------------------------------------------
// "This week" view — Sitemap §03 panel 2 chip
// ---------------------------------------------------------------------------

interface ThisWeekListProps {
  schedules: CrewScheduleRow[]
  isLoading: boolean
  attentionCount: number
}

export function ThisWeekList({ schedules, isLoading, attentionCount }: ThisWeekListProps) {
  if (isLoading) {
    return (
      <Card tight>
        <div className="text-[12px] text-ink-3">Loading this week…</div>
      </Card>
    )
  }

  // Bucket by day so the user sees a calendar-shaped roll-up.
  const byDay = new Map<string, CrewScheduleRow[]>()
  for (const s of schedules) {
    const key = s.scheduled_for
    const list = byDay.get(key) ?? []
    list.push(s)
    byDay.set(key, list)
  }
  const days = Array.from(byDay.entries()).sort(([a], [b]) => (a < b ? -1 : 1))

  return (
    <div className="space-y-3">
      <Card tight>
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Outlook</div>
        <div className="text-[14px] font-semibold mt-1">
          {schedules.length} scheduled {schedules.length === 1 ? 'shift' : 'shifts'} · {byDay.size}{' '}
          {byDay.size === 1 ? 'day' : 'days'}
        </div>
        <div className="text-[11px] text-ink-3 mt-1">
          {attentionCount > 0
            ? `${attentionCount} item${attentionCount === 1 ? '' : 's'} need attention before Friday.`
            : 'Nothing pending review for the week.'}
        </div>
      </Card>

      {days.length === 0 ? (
        <Card>
          <div className="text-[13px] font-semibold">No crew scheduled this week</div>
          <div className="text-[11px] text-ink-3 mt-1">Add an assignment in Schedule to see it here.</div>
        </Card>
      ) : (
        days.map(([day, scheds]) => (
          <Card key={day} tight>
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
              {formatDayLabel(day)}
            </div>
            <ul className="mt-2 divide-y divide-line">
              {scheds.map((s) => {
                const crewCount = s.crew && Array.isArray(s.crew) ? (s.crew as unknown[]).length : 0
                return (
                  <li key={s.id} className="py-1.5 first:pt-0 last:pb-0 flex items-center justify-between gap-2">
                    <Link to={`/projects/${s.project_id}`} className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium truncate">{s.project_name ?? 'Project'}</div>
                      <div className="text-[11px] text-ink-3">
                        {crewCount} crew · {s.status}
                      </div>
                    </Link>
                    <Pill tone={s.status === 'confirmed' ? 'good' : 'warn'}>{s.status}</Pill>
                  </li>
                )
              })}
            </ul>
          </Card>
        ))
      )}
      <div className="pt-1">
        <Attribution source="Live from /api/schedules?from=today&to=+7d" />
      </div>
    </div>
  )
}
