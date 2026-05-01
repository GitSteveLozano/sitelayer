import { useMemo } from 'react'
import { useRole } from '@/lib/role'
import { PlaceholderScreen } from '@/components/shell/PlaceholderScreen'
import { ForemanDailyLogScreen } from '@/screens/foreman'
import { useClockTimeline } from '@/lib/api'
import { findOpenSpan, pairClockSpans } from '@/lib/clock-derive'

/**
 * `/log` — Foreman daily log composer destination.
 *
 * The screen is project-scoped (one log per (project, day, foreman)).
 * Phase 1D.3 derives the active project from the foreman's most recent
 * clock-in event; if there's no open span, the screen renders an empty
 * state asking the user to clock in first.
 *
 * Phase 1D.4 will swap the derivation for a richer "current project"
 * resolver that reads from bootstrap + the foreman's day plan.
 *
 * Worker / owner roles get a placeholder — daily logs are foreman
 * surfaces only.
 */
export default function LogRoute() {
  const role = useRole()
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso }, { enabled: role === 'foreman' })
  const events = timeline.data?.events ?? []
  const open = useMemo(() => findOpenSpan(pairClockSpans(events)), [events])

  if (role !== 'foreman') {
    return (
      <PlaceholderScreen eyebrow="Daily log" title="Foreman only">
        Daily logs are authored by the foreman on shift. Switch to the foreman role to compose one.
      </PlaceholderScreen>
    )
  }

  return <ForemanDailyLogScreen projectId={open?.project_id ?? null} />
}
