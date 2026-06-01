/**
 * Foreman desktop crew view — the cross-site roster (Desktop v2 · FM ·
 * CREW · CROSS-SITE). Reuses the same bootstrap payload as the mobile
 * `foreman-crew` screen and renders every worker across every active
 * site as a dense desktop table: avatar + name, the site/assignment
 * they're booked on, role, hours logged today, and an on/off-site pill.
 *
 * Status + site are derived from today's labor (bootstrap.laborEntries),
 * falling back to today's crew schedule (bootstrap.schedules) for the
 * assignment when a worker hasn't clocked any hours yet. Mirrors
 * owner-team.tsx for the table/KPI shape. See
 * docs/V2_DESKTOP_AND_REMAINING_PLAN.md.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { apiGet, type BootstrapResponse } from '@/lib/api'
import { getActiveCompanySlug } from '@/lib/api/client'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MAvatar, MChip, MChipRow, MPill, avatarToneFor, initialsFor } from '@/components/m'
import { ForemanCrewMap } from '../mobile/foreman-crew.js'
import { formatDecimalHours, todayIso } from '../mobile/format.js'

type CrewRow = {
  id: string
  name: string
  role: string
  siteId: string | null
  site: string
  hoursToday: number
  onSite: boolean
  /** What the worker is on today (service-item code), or null. */
  onTask: string | null
  /** True when an open field blocker is tied to this worker / their site. */
  blocked: boolean
}

type OpenIssueRow = {
  id: string
  project_id: string | null
  worker_id: string | null
  resolved_at: string | null
}

// 'all' / 'on' / 'map' are fixed; any other value is a project id (By site).
type Filter = 'all' | 'on' | 'map' | string

function weekStartIso(): string {
  // Monday-based week start in local time, as YYYY-MM-DD to compare against
  // laborEntries.occurred_on (which is a local-date string).
  const now = new Date()
  const day = (now.getDay() + 6) % 7 // 0 = Monday
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day)
  const y = monday.getFullYear()
  const m = String(monday.getMonth() + 1).padStart(2, '0')
  const d = String(monday.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function FmCrew({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const [filter, setFilter] = useState<Filter>('all')
  const navigate = useNavigate()
  const companySlug = getActiveCompanySlug()

  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const schedules = useMemo(() => bootstrap?.schedules ?? [], [bootstrap?.schedules])
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  // Open field blockers — same feed FM Today uses — to mark crew/sites blocked
  // in the ON TASK column (design dsg__34: "Basecoat · blocked").
  const issuesQuery = useQuery({
    queryKey: ['worker-issues', 'open', companySlug],
    queryFn: () => apiGet<{ worker_issues: OpenIssueRow[] }>('/api/worker-issues?resolved=false', companySlug),
    enabled: Boolean(companySlug),
    refetchInterval: 60_000,
  })
  const openIssues = useMemo(
    () => (issuesQuery.data?.worker_issues ?? []).filter((i) => !i.resolved_at),
    [issuesQuery.data],
  )

  const { rows, onSiteCount, offCount, siteCount, weekTotal, sites } = useMemo(() => {
    const blockedWorkerIds = new Set(openIssues.map((i) => i.worker_id).filter(Boolean) as string[])
    const blockedSiteIds = new Set(openIssues.map((i) => i.project_id).filter(Boolean) as string[])
    const active = workers.filter((w) => !w.deleted_at)
    const today = todayIso()
    const weekStart = weekStartIso()
    const projectName = new Map(projects.map((p) => [p.id, p.name]))

    // Today's hours + the site each worker logged the most hours against, plus
    // the service-item code they spent the most time on (the ON TASK column).
    const hoursToday = new Map<string, number>()
    const siteHours = new Map<string, Map<string, number>>() // worker -> (project -> hrs)
    const taskHours = new Map<string, Map<string, number>>() // worker -> (service_item_code -> hrs)
    let weekTotal = 0
    for (const l of labor) {
      if (l.deleted_at || !l.worker_id) continue
      const hrs = Number(l.hours ?? 0)
      if (!Number.isFinite(hrs)) continue
      if (l.occurred_on >= weekStart) weekTotal += hrs
      if (l.occurred_on !== today) continue
      hoursToday.set(l.worker_id, (hoursToday.get(l.worker_id) ?? 0) + hrs)
      if (l.project_id) {
        const byProject = siteHours.get(l.worker_id) ?? new Map<string, number>()
        byProject.set(l.project_id, (byProject.get(l.project_id) ?? 0) + hrs)
        siteHours.set(l.worker_id, byProject)
      }
      if (l.service_item_code) {
        const byTask = taskHours.get(l.worker_id) ?? new Map<string, number>()
        byTask.set(l.service_item_code, (byTask.get(l.service_item_code) ?? 0) + hrs)
        taskHours.set(l.worker_id, byTask)
      }
    }

    // Scheduled assignment fallback — first crew schedule for today that
    // lists the worker, so off-clock crew still show where they're booked.
    const scheduledSite = new Map<string, string>()
    for (const s of schedules) {
      if (s.deleted_at || s.scheduled_for !== today || !s.project_id) continue
      for (const member of s.crew ?? []) {
        const wid =
          typeof member === 'string'
            ? member
            : ((member as { worker_id?: string; id?: string })?.worker_id ?? (member as { id?: string })?.id)
        if (wid && !scheduledSite.has(wid)) scheduledSite.set(wid, s.project_id)
      }
    }

    const rows: CrewRow[] = active.map((w) => {
      const hours = hoursToday.get(w.id) ?? 0
      const byProject = siteHours.get(w.id)
      const siteId: string | null =
        byProject && byProject.size > 0
          ? [...byProject.entries()].sort((a, b) => b[1] - a[1])[0]![0]
          : (scheduledSite.get(w.id) ?? null)
      const byTask = taskHours.get(w.id)
      const onTask =
        byTask && byTask.size > 0 ? ([...byTask.entries()].sort((a, b) => b[1] - a[1])[0]![0] ?? null) : null
      const blocked = blockedWorkerIds.has(w.id) || (siteId !== null && blockedSiteIds.has(siteId))
      return {
        id: w.id,
        name: w.name,
        role: w.role,
        siteId,
        site: siteId ? (projectName.get(siteId) ?? 'Unknown site') : 'Unassigned',
        hoursToday: hours,
        onSite: hours > 0,
        onTask,
        blocked,
      }
    })

    const onSiteCount = rows.filter((r) => r.onSite).length
    const siteIds = new Set(rows.map((r) => r.siteId).filter((id): id is string => Boolean(id)))
    const sites = [...siteIds].map((id) => ({ id, name: projectName.get(id) ?? 'Unknown site' }))
    sites.sort((a, b) => a.name.localeCompare(b.name))

    return {
      rows,
      onSiteCount,
      offCount: rows.length - onSiteCount,
      siteCount: siteIds.size,
      weekTotal,
      sites,
    }
  }, [workers, labor, schedules, projects, openIssues])

  const visibleRows = useMemo(() => {
    if (filter === 'all' || filter === 'map') return rows
    if (filter === 'on') return rows.filter((r) => r.onSite)
    return rows.filter((r) => r.siteId === filter)
  }, [rows, filter])

  const columns: Array<DColumn<CrewRow>> = [
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
          <MAvatar initials={initialsFor(r.name) || '—'} tone={avatarToneFor(r.id)} size="sm" />
          <span className="d-table-cell-strong">{r.name}</span>
        </span>
      ),
    },
    { key: 'site', header: 'Site', render: (r) => r.site },
    {
      key: 'onTask',
      header: 'On task',
      render: (r) =>
        r.onTask ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, color: 'var(--m-ink-2)' }}>{r.onTask}</span>
            {r.blocked ? (
              <span
                style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700, color: 'var(--m-bad, #b3261e)' }}
              >
                · BLOCKED
              </span>
            ) : null}
          </span>
        ) : r.blocked ? (
          <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700, color: 'var(--m-bad, #b3261e)' }}>
            BLOCKED
          </span>
        ) : (
          <span style={{ color: 'var(--m-ink-3)' }}>—</span>
        ),
    },
    {
      key: 'hours',
      header: 'Hours today',
      numeric: true,
      render: (r) => (r.hoursToday > 0 ? formatDecimalHours(r.hoursToday, 1) : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={r.blocked ? 'red' : r.onSite ? 'green' : undefined} dot>
          {r.blocked ? 'Blocked' : r.onSite ? 'On site' : 'Off'}
        </MPill>
      ),
    },
  ]

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Foreman · Crew</DEyebrow>
          <DH1>
            {onSiteCount} of {rows.length} on site
            {siteCount > 0 ? ` across ${siteCount} ${siteCount === 1 ? 'site' : 'sites'}.` : '.'}
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi
            label="On site"
            value={String(onSiteCount)}
            tone={onSiteCount > 0 ? 'accent' : undefined}
            meta={onSiteCount > 0 ? 'Clocked in today' : 'Nobody on site'}
            metaTone={onSiteCount > 0 ? 'good' : undefined}
          />
          <DKpi label="Off" value={String(offCount)} meta="Not clocked in" />
          <DKpi label="Sites" value={String(siteCount)} meta={siteCount > 0 ? 'With crew today' : 'No active sites'} />
          <DKpi
            label="This-week hours"
            value={formatDecimalHours(weekTotal, 1).replace('h', '')}
            unit="h"
            meta={weekTotal > 0 ? 'Across the crew' : 'No hours yet'}
            metaTone={weekTotal > 0 ? 'good' : undefined}
          />
        </DKpiStrip>

        <MChipRow>
          <MChip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
            All
          </MChip>
          <MChip active={filter === 'on'} onClick={() => setFilter('on')} count={onSiteCount}>
            On site
          </MChip>
          {sites.map((s) => (
            <MChip
              key={s.id}
              active={filter === s.id}
              onClick={() => setFilter(s.id)}
              count={rows.filter((r) => r.siteId === s.id).length}
            >
              {s.name}
            </MChip>
          ))}
          {/* MAP chip (design dsg__34): toggles the shared crew map body. */}
          <MChip active={filter === 'map'} onClick={() => setFilter('map')}>
            Map
          </MChip>
        </MChipRow>

        {filter === 'map' ? (
          <div className="d-card" style={{ padding: 0, overflow: 'hidden' }}>
            <ForemanCrewMap
              projects={projects}
              workers={workers}
              labor={labor}
              today={todayIso()}
              onOpenProject={(projectId) => navigate(`/desktop/projects/${projectId}`)}
            />
          </div>
        ) : (
          <DataTable<CrewRow>
            title="Crew across sites"
            columns={columns}
            rows={visibleRows}
            rowKey={(r) => r.id}
            empty={
              filter === 'all'
                ? 'No crew yet. Workers land here once they’re added to the company.'
                : 'No crew match this filter.'
            }
          />
        )}
      </div>
    </div>
  )
}
