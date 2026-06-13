/**
 * Live crew — `fm-crew`. Per-site stacked groups with avatar + role +
 * status dot. By site / By person / Map chip toggles control grouping.
 *
 * Status (on site / on break / off-clock) is derived from the latest
 * /api/clock/timeline event per worker. For Phase 8 we render from
 * bootstrap labor counts as a proxy until the timeline call is wired.
 *
 * Responsive consolidation (Phase B): the single responsive Foreman Crew
 * screen. The mobile per-site/per-person stacked composition renders by
 * default; the dense cross-site DataTable command-center composition (the
 * former `screens/desktop/fm-crew.tsx`, `ForemanCrewDesktop`) renders at
 * >=1024px. Both share the same bootstrap roster + the open-blocker feed and
 * the shared `ForemanCrewMap` body; only the layout + the navigation prefix
 * (resolved via `resolveForemanNav`) differ. Only ONE render mounts at a time.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { apiGet, type BootstrapResponse, type WorkerRow } from '@/lib/api'
import { getActiveCompanySlug } from '@/lib/api/client'
import {
  MAvatar,
  MBanner,
  MBody,
  MButton,
  MChip,
  MChipRow,
  MI,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTextarea,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '../../components/d/index.js'
import { useSendWorkerMessage } from '../../lib/api/workers.js'
import { useIsDesktop } from '../../lib/use-is-desktop.js'
import { resolveForemanNav } from '../foreman-nav.js'
import { formatDecimalHours, todayIso } from './format.js'

type GroupBy = 'site' | 'person' | 'map'
type StatusFilter = 'all' | 'on_site' | 'on_break' | 'off_clock'
type WorkerStatus = 'on_site' | 'on_break' | 'off_clock' | 'blocked'

/** Returns the live status dot color/label for a worker.
 *  blocked (red): worker has an open field event/blocker — takes priority
 *  on_site (green): 0 < hours <= 8 today
 *  on_break (amber): hours > 8 today (proxy for "still here past a shift")
 *  off_clock (gray): no hours today */
function statusFor(hours: number, blocked = false): WorkerStatus {
  if (blocked) return 'blocked'
  if (hours <= 0) return 'off_clock'
  if (hours > 8) return 'on_break'
  return 'on_site'
}

const STATUS_TONE: Record<WorkerStatus, 'green' | 'amber' | 'red' | undefined> = {
  on_site: 'green',
  on_break: 'amber',
  off_clock: undefined,
  blocked: 'red',
}

const STATUS_LABEL: Record<WorkerStatus, string> = {
  on_site: 'on site',
  on_break: 'on break',
  off_clock: 'off-clock',
  blocked: 'blocked',
}

type OpenIssueRow = { worker_id: string | null; resolved_at: string | null }

/**
 * Responsive Foreman Crew. Mounts the dense desktop cross-site DataTable layout
 * at >=1024px and the mobile per-site/per-person stacked layout below it. Only
 * one mounts at a time so neither twin's data hooks run on the wrong surface.
 */
export function ForemanCrew(props: { bootstrap: BootstrapResponse | null; companySlug?: string }) {
  const isDesktop = useIsDesktop()
  return isDesktop ? <ForemanCrewDesktop bootstrap={props.bootstrap} /> : <ForemanCrewMobile {...props} />
}

/** Desktop-route alias — kept so desktop-workspace.tsx can keep importing
 *  `FmCrew` after the desktop twin file was deleted. */
export const FmCrew = ForemanCrewDesktop

function ForemanCrewMobile({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug?: string }) {
  const navigate = useNavigate()
  const nav = resolveForemanNav(useLocation().pathname)
  const [grp, setGrp] = useState<GroupBy>('site')
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [actionWorker, setActionWorker] = useState<WorkerRow | null>(null)
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const today = todayIso()

  // Open field events → blocked workers. A worker with an unresolved blocker
  // surfaces a red BLOCKED pill (design msg__37), prioritized over the
  // hours-derived status. The endpoint scopes to the company; failures fall
  // back to no blockers so the screen still renders.
  const [blockedWorkers, setBlockedWorkers] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!companySlug) return
    let cancelled = false
    apiGet<{ worker_issues: OpenIssueRow[] }>('/api/worker-issues', companySlug)
      .then((r) => {
        if (cancelled) return
        const ids = new Set<string>()
        for (const i of r.worker_issues ?? []) {
          if (!i.resolved_at && i.worker_id) ids.add(i.worker_id)
        }
        setBlockedWorkers(ids)
      })
      .catch(() => {
        if (!cancelled) setBlockedWorkers(new Set())
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  const todayHoursByWorker = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of labor) {
      if (l.occurred_on === today && !l.deleted_at && l.worker_id) {
        map.set(l.worker_id, (map.get(l.worker_id) ?? 0) + Number(l.hours ?? 0))
      }
    }
    return map
  }, [labor, today])

  const statusOf = (w: WorkerRow): WorkerStatus =>
    statusFor(todayHoursByWorker.get(w.id) ?? 0, blockedWorkers.has(w.id))

  const onSiteCount = workers.filter((w) => statusOf(w) === 'on_site').length
  const onBreakCount = workers.filter((w) => statusOf(w) === 'on_break').length
  const blockedCount = workers.filter((w) => statusOf(w) === 'blocked').length
  const offClock = workers.length - onSiteCount - onBreakCount - blockedCount

  const visibleWorkers = useMemo(() => {
    if (filter === 'all') return workers
    return workers.filter((w) => {
      const s = statusFor(todayHoursByWorker.get(w.id) ?? 0, blockedWorkers.has(w.id))
      // The status filters are hours-based; a blocked worker still matches the
      // hours bucket they'd otherwise be in so they don't vanish from the list.
      if (s === 'blocked') return statusFor(todayHoursByWorker.get(w.id) ?? 0) === filter
      return s === filter
    })
  }, [workers, todayHoursByWorker, blockedWorkers, filter])

  return (
    <>
      <MTopBar
        eyebrow="Crew · across sites"
        title={`${onSiteCount} OF ${workers.length} ON SITE`}
        actionIcon={<MI.Plus size={20} />}
        actionLabel="Add"
      />
      <MBody>
        {blockedCount > 0 || onBreakCount > 0 || offClock > 0 ? (
          <div
            style={{
              padding: '10px 20px',
              borderBottom: '2px solid var(--m-ink)',
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              display: 'flex',
              gap: 14,
            }}
          >
            {blockedCount > 0 ? <span style={{ color: 'var(--m-red)' }}>{blockedCount} blocked</span> : null}
            {onBreakCount > 0 ? <span style={{ color: 'var(--m-amber)' }}>{onBreakCount} on break</span> : null}
            {offClock > 0 ? <span>{offClock} off-clock</span> : null}
          </div>
        ) : null}
        <MChipRow>
          <MChip active={grp === 'site'} onClick={() => setGrp('site')}>
            BY SITE
          </MChip>
          <MChip active={grp === 'person'} onClick={() => setGrp('person')}>
            BY PERSON
          </MChip>
          <MChip active={grp === 'map'} onClick={() => navigate(nav.crewMap)}>
            MAP
          </MChip>
        </MChipRow>
        {grp === 'person' ? (
          <MChipRow>
            <MChip active={filter === 'all'} onClick={() => setFilter('all')} count={workers.length}>
              All
            </MChip>
            <MChip active={filter === 'on_site'} onClick={() => setFilter('on_site')} count={onSiteCount}>
              On site
            </MChip>
            <MChip active={filter === 'on_break'} onClick={() => setFilter('on_break')} count={onBreakCount}>
              On break
            </MChip>
            <MChip active={filter === 'off_clock'} onClick={() => setFilter('off_clock')} count={offClock}>
              Off clock
            </MChip>
          </MChipRow>
        ) : null}
        {grp === 'map' ? (
          <ForemanCrewMap
            projects={projects}
            workers={workers}
            labor={labor}
            today={today}
            onOpenProject={(projectId) => navigate(nav.project(projectId))}
          />
        ) : grp === 'person' ? (
          <>
            <MSectionH>{filter === 'all' ? 'All crew' : STATUS_LABEL[filter]}</MSectionH>
            <MListInset>
              {visibleWorkers.map((w) => {
                const hrs = todayHoursByWorker.get(w.id) ?? 0
                const status = statusFor(hrs, blockedWorkers.has(w.id))
                const tone = STATUS_TONE[status]
                return (
                  <CrewPersonRow
                    key={w.id}
                    name={w.name}
                    role={w.role ?? 'Crew'}
                    initials={initialsFor(w.name)}
                    avatarTone={avatarToneFor(w.id)}
                    hours={hrs}
                    statusLabel={STATUS_LABEL[status]}
                    pillTone={tone}
                    onLongPress={() => setActionWorker(w)}
                  />
                )
              })}
            </MListInset>
          </>
        ) : (
          <div>
            {projects
              .filter((p) => /progress|active/i.test(p.status))
              .map((p) => {
                const hrs = labor
                  .filter((l) => l.occurred_on === today && !l.deleted_at && l.project_id === p.id)
                  .reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
                const onSiteWorkers = workers.filter((w) =>
                  labor.some(
                    (l) => l.occurred_on === today && !l.deleted_at && l.project_id === p.id && l.worker_id === w.id,
                  ),
                )
                if (onSiteWorkers.length === 0) return null
                return (
                  <div key={p.id} style={{ borderBottom: '2px solid var(--m-ink)' }}>
                    <div className="m-section-bar">
                      <div>
                        <div
                          style={{
                            fontFamily: 'var(--m-num)',
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: '0.08em',
                            textTransform: 'uppercase',
                            color: 'var(--m-ink)',
                          }}
                        >
                          {p.name}
                        </div>
                        <div style={{ marginTop: 3, fontSize: 10, fontWeight: 600, color: 'var(--m-ink-3)' }}>
                          Briefed by you · {p.division_code}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span className="num" style={{ fontWeight: 700, color: 'var(--m-ink-3)' }}>
                          {formatDecimalHours(hrs, 1)}
                        </span>
                        <MButton size="sm" variant="ghost" onClick={() => navigate(nav.brief(p.id))}>
                          Edit brief
                        </MButton>
                      </div>
                    </div>
                    {onSiteWorkers.map((w, j) => {
                      const whrs = todayHoursByWorker.get(w.id) ?? 0
                      const status = statusFor(whrs, blockedWorkers.has(w.id))
                      const tone = STATUS_TONE[status]
                      return (
                        <div
                          key={w.id}
                          style={{
                            padding: '14px 20px',
                            borderBottom: j < onSiteWorkers.length - 1 ? '1px solid var(--m-line-2)' : 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                          }}
                        >
                          <MAvatar initials={initialsFor(w.name)} tone={avatarToneFor(w.id)} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--m-font-display)', fontWeight: 700, fontSize: 15 }}>
                              {w.name}
                            </div>
                            <div
                              style={{
                                fontFamily: 'var(--m-num)',
                                fontSize: 10,
                                fontWeight: 600,
                                marginTop: 2,
                                letterSpacing: '0.04em',
                                textTransform: 'uppercase',
                                color: 'var(--m-ink-3)',
                              }}
                            >
                              {w.role ?? 'Crew'}
                              {whrs > 0 ? ` · ${formatDecimalHours(whrs, 1)}` : ''}
                            </div>
                          </div>
                          <MPill tone={tone ?? 'green'} dot>
                            {STATUS_LABEL[status]}
                          </MPill>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
          </div>
        )}
      </MBody>
      {actionWorker ? (
        <CrewQuickActions
          worker={actionWorker}
          onClose={() => setActionWorker(null)}
          onAdjustHours={() => {
            navigate(nav.time)
            setActionWorker(null)
          }}
        />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Desktop composition — the former screens/desktop/fm-crew.tsx, folded in
// verbatim (data + behavior preserved) with navigation resolved through
// resolveForemanNav so it works under the /desktop/fm shell.
// ---------------------------------------------------------------------------

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

type DesktopOpenIssueRow = {
  id: string
  project_id: string | null
  worker_id: string | null
  resolved_at: string | null
}

// 'all' / 'on' / 'map' are fixed; any other value is a project id (By site).
type CrewFilter = 'all' | 'on' | 'map' | string

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

function ForemanCrewDesktop({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const [filter, setFilter] = useState<CrewFilter>('all')
  const navigate = useNavigate()
  const nav = resolveForemanNav(useLocation().pathname)
  const companySlug = getActiveCompanySlug()

  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const schedules = useMemo(() => bootstrap?.schedules ?? [], [bootstrap?.schedules])
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  // Open field blockers — same feed FM Today uses — to mark crew/sites blocked
  // in the ON TASK column (design dsg__34: "Basecoat · blocked").
  const issuesQuery = useQuery({
    queryKey: ['worker-issues', 'open', companySlug],
    queryFn: () => apiGet<{ worker_issues: DesktopOpenIssueRow[] }>('/api/worker-issues?resolved=false', companySlug),
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
              onOpenProject={(projectId) => navigate(nav.project(projectId))}
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

function CrewPersonRow({
  name,
  role,
  initials,
  avatarTone,
  hours,
  statusLabel,
  pillTone,
  onLongPress,
}: {
  name: string
  role: string
  initials: string
  avatarTone: '2' | '3' | '4' | '5' | undefined
  hours: number
  statusLabel: string
  pillTone: 'green' | 'amber' | 'red' | undefined
  onLongPress: () => void
}) {
  // Long-press detection — 600ms hold without significant movement
  // triggers the quick-actions sheet. Click still drills into a future
  // person sheet (left as a navigate stub).
  const timerRef = useRef<number | null>(null)
  const triggeredRef = useRef(false)
  const start = () => {
    triggeredRef.current = false
    timerRef.current = window.setTimeout(() => {
      triggeredRef.current = true
      onLongPress()
    }, 600)
  }
  const cancel = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }
  return (
    <div
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => {
        // Right-click on desktop — fire long-press equivalent and
        // suppress the browser menu so the sheet works in the preview.
        e.preventDefault()
        onLongPress()
      }}
    >
      <MListRow
        leading={<MAvatar initials={initials} tone={avatarTone} />}
        headline={name}
        supporting={role}
        trailing={
          hours > 0 ? (
            <>
              <span className="num">{formatDecimalHours(hours, 1)}</span>
              <MPill tone={pillTone} dot={Boolean(pillTone)}>
                {statusLabel}
              </MPill>
            </>
          ) : (
            <MPill>{statusLabel}</MPill>
          )
        }
      />
    </div>
  )
}

export function CrewQuickActions({
  worker,
  onClose,
  onAdjustHours,
}: {
  worker: WorkerRow
  onClose: () => void
  onAdjustHours: () => void
}) {
  // Local mode: 'menu' shows the action buttons; 'compose' shows the
  // textarea to type a message. The mutation state (pending/error/data)
  // lives in useSendWorkerMessage so the sheet renders directly from it.
  const [mode, setMode] = useState<'menu' | 'compose' | 'sent'>('menu')
  const [body, setBody] = useState('')
  const sendMessage = useSendWorkerMessage()

  const handleSend = async () => {
    const trimmed = body.trim()
    if (!trimmed) return
    try {
      await sendMessage.mutateAsync({ workerId: worker.id, input: { body: trimmed } })
      setMode('sent')
    } catch {
      // sendMessage.error renders inline below; stay in compose mode.
    }
  }

  return (
    <div
      role="dialog"
      aria-label={`Actions for ${worker.name}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 50,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--m-card)',
          borderTopLeftRadius: 16,
          borderTopRightRadius: 16,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{worker.name}</div>
        <div className="m-quiet-sm" style={{ marginBottom: 8 }}>
          {worker.role ?? 'Crew'}
        </div>

        {mode === 'menu' ? (
          <>
            <MButton variant="ghost" onClick={() => setMode('compose')}>
              <MI.Mic size={16} /> Send message
            </MButton>
            <MButton variant="ghost" onClick={onAdjustHours}>
              <MI.Clock size={16} /> Adjust hours
            </MButton>
            <MButton variant="quiet" onClick={onClose}>
              Cancel
            </MButton>
          </>
        ) : null}

        {mode === 'compose' ? (
          <>
            <MTextarea
              value={body}
              onChange={(e) => setBody(e.currentTarget.value)}
              placeholder={`Message to ${worker.name}…`}
              maxLength={2000}
              style={{ minHeight: 100 }}
              autoFocus
            />
            {sendMessage.error ? (
              <MBanner
                tone="error"
                title="Couldn't send"
                body={
                  // 422 = no clerk mapping. Surface the server's hint so the
                  // foreman knows the worker needs to onboard first.
                  /422|associated user account/i.test(sendMessage.error.message)
                    ? `${worker.name} hasn't signed in to the app yet — ask them to clock in or file an issue, then try again.`
                    : sendMessage.error.message
                }
              />
            ) : null}
            <MButton variant="primary" onClick={handleSend} disabled={sendMessage.isPending || !body.trim()}>
              {sendMessage.isPending ? 'Sending…' : 'Send'}
            </MButton>
            <MButton variant="quiet" onClick={() => setMode('menu')} disabled={sendMessage.isPending}>
              Back
            </MButton>
          </>
        ) : null}

        {mode === 'sent' ? (
          <>
            <MBanner tone="ok" title="Message sent" body={`${worker.name} will see it in their notifications.`} />
            <MButton variant="primary" onClick={onClose}>
              Done
            </MButton>
          </>
        ) : null}
      </div>
    </div>
  )
}

export type ForemanCrewMapProps = {
  projects: BootstrapResponse['projects']
  workers: BootstrapResponse['workers']
  labor: BootstrapResponse['laborEntries']
  today: string
  onOpenProject: (projectId: string) => void
}

/**
 * The stylized "crew on site" map body — roads/blocks backdrop, a
 * geofence ring + label per active site, worker pins colored by clock
 * status, plus a stat strip and a live roster beneath. Shared between
 * the in-screen Crew "Map" toggle and the dedicated `fm-map` screen
 * (`foreman-map.tsx`) so the two stay visually identical.
 */
export function ForemanCrewMap({ projects, workers, labor, today, onOpenProject }: ForemanCrewMapProps) {
  const activeProjects = projects.filter((p) => /progress|active/i.test(p.status)).slice(0, 3)
  const mappedProjects = activeProjects.length > 0 ? activeProjects : projects.slice(0, 3)
  const todayLabor = labor.filter((l) => l.occurred_on === today && !l.deleted_at && l.worker_id)
  const workersById = new Map(workers.map((w) => [w.id, w]))
  const pins = todayLabor
    .map((entry, index) => {
      const worker = entry.worker_id ? workersById.get(entry.worker_id) : null
      const projectIndex = Math.max(
        0,
        mappedProjects.findIndex((p) => p.id === entry.project_id),
      )
      if (!worker) return null
      return {
        id: `${entry.id}-${worker.id}`,
        worker,
        projectId: entry.project_id,
        hours: Number(entry.hours ?? 0),
        x: 24 + ((index * 17 + projectIndex * 29) % 56),
        y: 26 + ((index * 23 + projectIndex * 11) % 38),
      }
    })
    .filter((pin): pin is NonNullable<typeof pin> => Boolean(pin))

  const roster =
    pins.length > 0
      ? pins
      : workers.slice(0, 4).map((worker, index) => ({
          id: `offline-${worker.id}`,
          worker,
          projectId: mappedProjects[index % Math.max(1, mappedProjects.length)]?.id ?? null,
          hours: 0,
          x: 24 + index * 13,
          y: 30 + index * 9,
        }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          position: 'relative',
          height: 'clamp(300px, 46dvh, 430px)',
          flex: '0 0 auto',
          overflow: 'hidden',
          borderTop: '1px solid var(--m-line)',
          borderBottom: '1px solid var(--m-line)',
          background: '#e7decc',
        }}
      >
        <MapRoad top="42%" left="-8%" width="116%" rotate={0} />
        <MapRoad top="-8%" left="48%" width="116%" rotate={90} />
        <MapRoad top="19%" left="38%" width="78%" rotate={57} />
        <MapBlock top="12%" left="11%" width="28%" height="30%" />
        <MapBlock top="55%" left="7%" width="34%" height="32%" />
        <MapBlock top="53%" left="63%" width="28%" height="27%" />
        {mappedProjects.map((project, index) => {
          const anchors = [
            { x: 25, y: 25, r: 94 },
            { x: 66, y: 55, r: 72 },
            { x: 38, y: 70, r: 66 },
          ]
          const anchor = anchors[index % anchors.length]!
          return (
            <button
              key={project.id}
              type="button"
              onClick={() => onOpenProject(project.id)}
              aria-label={`Open ${project.name}`}
              style={{
                position: 'absolute',
                left: `${anchor.x}%`,
                top: `${anchor.y}%`,
                width: anchor.r,
                height: anchor.r,
                transform: 'translate(-50%, -50%)',
                borderRadius: '50%',
                border: '2px dashed rgba(44, 138, 85, 0.75)',
                background: 'rgba(44, 138, 85, 0.08)',
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  left: '50%',
                  top: -10,
                  transform: 'translateX(-50%)',
                  background: '#1c1816',
                  color: '#f3ecdf',
                  padding: '3px 8px',
                  fontSize: 9,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                }}
              >
                {project.name.split(/\s+/).slice(0, 2).join(' ')}
              </span>
            </button>
          )
        })}
        {/* Worker map pins intentionally use the 24px avatar size; map
         * markers are a dense-data exception to the 44×44 rule (bumping
         * them would overlap on adjacent clocked-in workers). The pin is
         * still keyboard-reachable via the roster list below. */}
        {roster.map((pin) => {
          const onSite = pin.hours > 0
          return (
            <button
              key={pin.id}
              type="button"
              aria-label={`${pin.worker.name} ${onSite ? 'clocked in' : 'off clock'}`}
              style={{
                position: 'absolute',
                left: `${pin.x}%`,
                top: `${pin.y}%`,
                transform: 'translate(-50%, -50%)',
                border: 0,
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <MAvatar initials={initialsFor(pin.worker.name)} tone={avatarToneFor(pin.worker.id)} size="sm" />
                <span
                  style={{
                    position: 'absolute',
                    right: -1,
                    bottom: -1,
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    border: '2px solid #fff',
                    background: onSite ? 'var(--m-green)' : 'var(--m-ink-4)',
                  }}
                />
              </span>
              <span
                style={{
                  display: 'block',
                  marginTop: 2,
                  background: '#1c1816',
                  color: '#f3ecdf',
                  padding: '2px 6px',
                  fontSize: 10,
                  fontWeight: 700,
                  whiteSpace: 'nowrap',
                }}
              >
                {pin.worker.name.split(/\s+/).slice(0, 2).join(' ')}
              </span>
            </button>
          )
        })}
        <div style={{ position: 'absolute', right: 12, top: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <MapZoom label="+" />
          <MapZoom label="-" />
        </div>
        {roster.some((pin) => pin.hours === 0) ? (
          <div
            style={{
              position: 'absolute',
              left: 16,
              right: 16,
              bottom: 14,
              background: 'var(--m-amber)',
              color: '#fffaf2',
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 12,
              fontWeight: 600,
              boxShadow: 'var(--m-shadow-2)',
            }}
          >
            <MI.AlertTri size={18} />
            <span>{roster.filter((pin) => pin.hours === 0).length} crew member needs a clock-in check.</span>
          </div>
        ) : null}
      </div>
      <div style={{ background: 'var(--m-bg)', borderTop: '1px solid var(--m-line)', paddingTop: 10 }}>
        <div style={{ padding: '0 16px 10px' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: 8,
            }}
          >
            <MapStat label="In fence" value={String(pins.length)} />
            <MapStat label="Sites" value={String(mappedProjects.length)} />
            <MapStat label="Off map" value={String(Math.max(0, workers.length - roster.length))} />
          </div>
        </div>
        <MSectionH>Roster · live</MSectionH>
        <MListInset>
          {roster.slice(0, 5).map((pin) => (
            <MListRow
              key={pin.id}
              leading={
                <MAvatar initials={initialsFor(pin.worker.name)} tone={avatarToneFor(pin.worker.id)} size="sm" />
              }
              headline={pin.worker.name}
              supporting={mappedProjects.find((p) => p.id === pin.projectId)?.name ?? pin.worker.role ?? 'Crew'}
              trailing={
                pin.hours > 0 ? (
                  <MPill tone="green" dot>
                    in fence
                  </MPill>
                ) : (
                  <MPill tone="amber" dot>
                    check
                  </MPill>
                )
              }
            />
          ))}
        </MListInset>
      </div>
    </div>
  )
}

function MapRoad({ top, left, width, rotate }: { top: string; left: string; width: string; rotate: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left,
        width,
        height: 42,
        transform: `rotate(${rotate}deg)`,
        background: '#cbbda7',
        borderTop: '1px solid rgba(255,255,255,0.45)',
        borderBottom: '1px solid rgba(130,111,88,0.18)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: '50%',
          borderTop: '2px dashed rgba(255,255,255,0.45)',
        }}
      />
    </div>
  )
}

function MapBlock({ top, left, width, height }: { top: string; left: string; width: string; height: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left,
        width,
        height,
        border: '1px solid rgba(117, 101, 79, 0.18)',
        background: 'rgba(245, 241, 236, 0.62)',
      }}
    />
  )
}

function MapZoom({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label={label === '+' ? 'Zoom in' : 'Zoom out'}
      style={{
        // 44×44 minimum (WCAG 2.1) — map zoom is core navigation.
        width: 44,
        height: 44,
        border: '2px solid var(--m-ink)',
        background: '#fff',
        color: 'var(--m-ink)',
        fontSize: 22,
        fontWeight: 700,
        boxShadow: 'var(--m-shadow-1)',
      }}
    >
      {label}
    </button>
  )
}

function MapStat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        border: '2px solid var(--m-ink)',
        background: 'var(--m-card)',
        padding: '9px 10px',
      }}
    >
      <div className="num" style={{ fontSize: 18, fontWeight: 700 }}>
        {value}
      </div>
      <div
        style={{
          marginTop: 2,
          color: 'var(--m-ink-3)',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
    </div>
  )
}
