import { request, type ProjectSummaryResponse } from '@/lib/api'
import type { ClockSpan } from '@/lib/clock-derive'

export function formatDateLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}

export function formatDollars(cents: number): string {
  const dollars = cents / 100
  if (dollars >= 1000) return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  return `$${dollars.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`
}

/**
 * Sum hours per project_id across the day's clock spans. Spans without
 * a project_id (e.g. legacy clocks captured before geofence join) are
 * ignored — they don't have a row to bind to anyway.
 */
export function groupHoursByProject(spans: ClockSpan[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const span of spans) {
    if (!span.project_id) continue
    const prev = out.get(span.project_id) ?? 0
    out.set(span.project_id, prev + span.hours)
  }
  return out
}

/** Calm subline copy from Sitemap §03 panel 2. */
export function buildCalmSubline({
  projectsCount,
  onSiteCount,
  attentionCount,
}: {
  projectsCount: number
  onSiteCount: number
  attentionCount: number
}): string {
  if (projectsCount === 0) return 'No jobs scheduled for today.'
  const opener = attentionCount === 0 ? "Nothing's on fire. " : ''
  const projWord = projectsCount === 1 ? 'job is' : 'jobs are'
  const crewWord = onSiteCount === 1 ? 'crew is' : 'crew are'
  return `${opener}${projectsCount} ${projWord} running, ${onSiteCount} ${crewWord} clocked in, the day's plan is set.`
}

/** All-sites subline copy. Mirrors the calm one but framed for PM density. */
export function buildAllSitesSubline({
  projectsCount,
  onSiteCount,
  attentionCount,
}: {
  projectsCount: number
  onSiteCount: number
  attentionCount: number
}): string {
  if (attentionCount > 0) {
    return `${projectsCount} active · ${onSiteCount} on the clock · ${attentionCount} need${
      attentionCount === 1 ? 's' : ''
    } your eyes.`
  }
  if (projectsCount === 0) return 'No jobs scheduled today. Per-project burn below.'
  return `${projectsCount} active · ${onSiteCount} on the clock. Per-project burn below.`
}

/** Add `days` to an ISO YYYY-MM-DD date and return the same format. */
export function isoDateOffset(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** YYYY-MM-DD → "Mon · Apr 28". Local TZ. */
export function formatDayLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', ' ·')
}

/**
 * Lightweight summary fetch for the SNAPSHOT MARGIN tile. We use
 * `request<>` directly (rather than `useProjectSummary` ×N) so the tile
 * can fan-out across active projects via `useQueries` without coupling
 * to the per-summary hook's defaults.
 */
export function fetchProjectSummaryForKpi(id: string): Promise<ProjectSummaryResponse> {
  return request<ProjectSummaryResponse>(`/api/projects/${encodeURIComponent(id)}/summary`)
}
