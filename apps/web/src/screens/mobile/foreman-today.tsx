/**
 * Foreman home — `fm-today`. Multi-site stacked view: header summary,
 * "FROM THE FIELD" block (worker_issues that need triage), then a card
 * per active site with crew + progress + briefed-by line.
 *
 * Polls /api/worker-issues for the open issues so the foreman gets a
 * realistic triage queue without the SSE channel that Phase 8's roadmap
 * note describes (that's a follow-up).
 *
 * Sites are sorted by triage priority:
 *   1. Crews with no brief sent today float to the top.
 *   2. Then sites with open blockers.
 *   3. Then alphabetical.
 *
 * Responsive consolidation (Phase B): this is the single responsive Foreman
 * Today screen. It mounts the mobile stacked composition by default and the
 * dense desktop command-center composition (`ForemanTodayDesktop`, the former
 * `screens/desktop/fm-today.tsx`) at the >=1024px breakpoint. Both renders
 * share the SAME bootstrap-derived signals + the worker-issues / per-site brief
 * lookups; only the layout and the navigation prefix (resolved via
 * `resolveForemanNav`) differ. The desktop render's data layer is preserved
 * verbatim — it still uses TanStack `useQuery`/`useQueries` (refetching) where
 * the mobile render uses the original effect-based fetches. Only ONE render
 * mounts at a time so neither twin's hooks run on the wrong surface.
 */
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { apiGet, type BootstrapResponse, type ProjectRow } from '@/lib/api'
import {
  MAvatarGroup,
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MI,
  MKpi,
  MLargeHead,
  MPill,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '../../components/d/index.js'
import { request } from '../../lib/api/client.js'
import type { ProjectBriefListResponse } from '../../lib/api/projects.js'
import { useIsDesktop } from '../../lib/use-is-desktop.js'
import { resolveForemanNav } from '../foreman-nav.js'
import { formatDecimalHours, formatMoney, formatStatusLabel, statusTone, timeOfDay, todayIso } from './format.js'

// Cutoff for "overnight" delta: 5pm local on the previous calendar day.
// The foreman left the field around then; anything after that and before
// the morning render is "while they were off the clock."
function yesterdayCutoffMs(now: Date = new Date()): number {
  const d = new Date(now)
  d.setDate(d.getDate() - 1)
  d.setHours(17, 0, 0, 0)
  return d.getTime()
}

function parseTs(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

// sessionStorage key namespaced by the cutoff so a new morning gets a
// fresh stripe even after dismissal the previous day.
function overnightDismissKey(cutoffMs: number): string {
  return `fm-today.overnight-dismissed.${cutoffMs}`
}

// 12-hour clock with no leading zero, e.g. "6:42 PM" — matches the design's
// example body copy.
function formatClock(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

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

export type OvernightDelta = {
  buckets: string[]
  total: number
  scheduleCount: number
  issueCount: number
  projectCount: number
}

/**
 * Pure-function overnight-delta computation, exported for unit tests.
 * Counts items whose `created_at`/`updated_at` falls in
 * `(cutoffMs, firstRenderMs]`. Schedule + project work is filtered to
 * active projects only; issues count regardless of project (workers can
 * file issues without a project).
 */
export function computeOvernightDelta(args: {
  bootstrap: BootstrapResponse | null
  issues: readonly IssueRow[] | null
  cutoffMs: number
  firstRenderMs: number
}): OvernightDelta {
  const { bootstrap, issues, cutoffMs, firstRenderMs } = args
  const inWindow = (ts: number | null) => ts !== null && ts > cutoffMs && ts <= firstRenderMs

  const activeIds = new Set(
    (bootstrap?.projects ?? []).filter((p) => /progress|active/i.test(p.status)).map((p) => p.id),
  )

  const scheduleChanges = (bootstrap?.schedules ?? []).filter((s) => {
    if (s.deleted_at) return false
    if (!activeIds.has(s.project_id)) return false
    return inWindow(parseTs(s.created_at ?? null))
  })

  const issuesFiled = (issues ?? []).filter((i) => inWindow(parseTs(i.created_at)))

  // Bootstrap doesn't ship estimate_lines today; the closest available
  // signal of "estimate revisions on active projects" is a project row
  // whose updated_at advanced overnight (estimate recompute, brief edits,
  // status changes all bump it).
  const projectTouches = (bootstrap?.projects ?? []).filter((p) => {
    if (!/progress|active/i.test(p.status)) return false
    const u = parseTs(p.updated_at)
    const c = parseTs(p.created_at)
    // updated_at strictly after creation → a real edit, not just an insert.
    return u !== null && c !== null && u > c && inWindow(u)
  })

  const buckets: string[] = []
  if (scheduleChanges.length > 0) {
    buckets.push(`Crew schedule: ${scheduleChanges.length} ${scheduleChanges.length === 1 ? 'change' : 'changes'}`)
  }
  if (issuesFiled.length > 0) {
    const latestIssueTs = issuesFiled
      .map((i) => parseTs(i.created_at))
      .filter((t): t is number => t !== null)
      .reduce<number | null>((m, t) => (m === null || t > m ? t : m), null)
    const timePart = latestIssueTs !== null ? ` at ${formatClock(new Date(latestIssueTs))}` : ''
    buckets.push(`${issuesFiled.length} ${issuesFiled.length === 1 ? 'issue' : 'issues'} filed${timePart}`)
  }
  if (projectTouches.length > 0) {
    buckets.push(`${projectTouches.length} ${projectTouches.length === 1 ? 'project' : 'projects'} updated`)
  }

  return {
    buckets,
    total: scheduleChanges.length + issuesFiled.length + projectTouches.length,
    scheduleCount: scheduleChanges.length,
    issueCount: issuesFiled.length,
    projectCount: projectTouches.length,
  }
}

export const __overnightInternals = { yesterdayCutoffMs, overnightDismissKey, parseTs, formatClock }

/**
 * Responsive Foreman Today. Mounts the dense desktop command-center layout at
 * >=1024px and the mobile stacked layout below it. Both are driven from the
 * same bootstrap + companySlug; only one mounts at a time so neither twin's
 * data hooks run on the wrong surface.
 */
export function ForemanToday(props: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const isDesktop = useIsDesktop()
  return isDesktop ? <ForemanTodayDesktop {...props} /> : <ForemanTodayMobile {...props} />
}

/** Desktop-route alias — kept so screens/desktop/desktop-workspace.tsx can keep
 *  importing `FmToday` after the desktop twin file was deleted. */
export const FmToday = ForemanToday

function ForemanTodayMobile({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const nav = resolveForemanNav(useLocation().pathname)
  const [issues, setIssues] = useState<readonly IssueRow[] | null>(null)
  // Per-project bool: did the foreman already send a brief today? Set
  // as we discover them (one fetch per active project) — simple and
  // honest. The fm-brief screen invalidates the brief query keys, so a
  // refresh here just means a re-mount.
  const [briefedSet, setBriefedSet] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    apiGet<{ worker_issues: IssueRow[] }>('/api/worker-issues?resolved=false', companySlug)
      .then((r) => {
        if (!cancelled) setIssues(r.worker_issues ?? [])
      })
      .catch(() => {
        if (!cancelled) setIssues([])
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])

  const today = todayIso()
  const activeSites = useMemo(() => projects.filter((p) => /progress|active/i.test(p.status)), [projects])

  // Pre-fetch today's briefs for each active site so we can surface the
  // "needs brief" priority. One round-trip per project — cheap on the
  // small site counts foremen handle.
  useEffect(() => {
    if (activeSites.length === 0) return
    let cancelled = false
    Promise.all(
      activeSites.map((p) =>
        request<ProjectBriefListResponse>(`/api/projects/${encodeURIComponent(p.id)}/briefs?date=${today}`)
          .then((r) => ({ pid: p.id, briefed: (r.briefs?.length ?? 0) > 0 }))
          .catch(() => ({ pid: p.id, briefed: false })),
      ),
    ).then((rows) => {
      if (cancelled) return
      const next = new Set<string>()
      for (const row of rows) if (row.briefed) next.add(row.pid)
      setBriefedSet(next)
    })
    return () => {
      cancelled = true
    }
  }, [activeSites, today])

  const todayHoursByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of labor) {
      if (l.occurred_on === today && !l.deleted_at && l.project_id) {
        map.set(l.project_id, (map.get(l.project_id) ?? 0) + Number(l.hours ?? 0))
      }
    }
    return map
  }, [labor, today])

  const issuesByProject = useMemo(() => {
    const map = new Map<string, IssueRow[]>()
    for (const i of issues ?? []) {
      if (i.resolved_at) continue
      if (!i.project_id) continue
      const arr = map.get(i.project_id) ?? []
      arr.push(i)
      map.set(i.project_id, arr)
    }
    return map
  }, [issues])

  const todayLaborCost = Array.from(todayHoursByProject.entries()).reduce((sum, [pid, hrs]) => {
    const p = projects.find((x) => x.id === pid)
    return sum + hrs * Number(p?.labor_rate ?? 0)
  }, 0)
  const totalHours = Array.from(todayHoursByProject.values()).reduce((s, h) => s + h, 0)

  const openIssues = issues?.filter((i) => !i.resolved_at) ?? []
  const needYou = openIssues.length

  const sortedSites = useMemo(() => {
    return [...activeSites].sort((a, b) => sitePriority(a, b, briefedSet, issuesByProject))
  }, [activeSites, briefedSet, issuesByProject])

  // --- Overnight delta -------------------------------------------------
  // Lock the cutoff and "first render" wall on first mount so the stripe
  // doesn't drift as state churns through the morning.
  const [overnightWindow] = useState(() => {
    const now = Date.now()
    return { cutoffMs: yesterdayCutoffMs(new Date(now)), firstRenderMs: now }
  })
  const [overnightDismissed, setOvernightDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.sessionStorage.getItem(overnightDismissKey(overnightWindow.cutoffMs)) === '1'
    } catch {
      return false
    }
  })

  const overnight = useMemo(
    () =>
      computeOvernightDelta({
        bootstrap,
        issues,
        cutoffMs: overnightWindow.cutoffMs,
        firstRenderMs: overnightWindow.firstRenderMs,
      }),
    [bootstrap, issues, overnightWindow],
  )

  const showOvernight = !overnightDismissed && overnight.total > 0
  const dismissOvernight = () => {
    setOvernightDismissed(true)
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.setItem(overnightDismissKey(overnightWindow.cutoffMs), '1')
      } catch {
        // sessionStorage can throw in private mode; the in-memory
        // dismissal is enough for this tab.
      }
    }
  }

  // Quiet/busy posture: when the field is clear, the screen leads with a
  // big clock + "field is clear" line; when issues are open it leads with
  // the hi-vis "From the field" attention banner.
  const fieldClear = needYou === 0
  const nowClock = formatClock(new Date())

  return (
    <>
      <MTopBar title="Today" />
      <MBody>
        <MLargeHead
          eyebrow={`FOREMAN · ${shortMonthDay()}`}
          title={`${activeSites.length} ${activeSites.length === 1 ? 'SITE' : 'SITES'} · ${workers.length} CREW`}
          sub={`${formatDecimalHours(totalHours, 1)} CREW-HRS · ${formatMoney(todayLaborCost)} LIVE`}
        />

        {/* From-the-field hi-vis attention banner — bold yellow w/ ink CTA.
            When quiet it flips to a neutral "field is clear" status banner. */}
        {needYou > 0 ? (
          <MBanner
            tone="attention"
            icon={<MI.AlertTri size={18} />}
            title={`FROM THE FIELD · ${needYou} NEED YOU`}
            body={
              <>
                {openIssues.slice(0, 3).map((i) => {
                  const w = workers.find((x) => x.id === i.worker_id)
                  return (
                    <div key={i.id} style={{ marginBottom: 2 }}>
                      <strong>{w?.name ?? 'A worker'}</strong> ·{' '}
                      {projects.find((p) => p.id === i.project_id)?.name ?? 'unknown site'} —{' '}
                      {i.message.replace(/^\[[^\]]+\]\s*/, '').slice(0, 60)}
                    </div>
                  )
                })}
              </>
            }
            action={
              <MButton variant="primary" size="sm" onClick={() => navigate(nav.field)}>
                See all
              </MButton>
            }
          />
        ) : (
          <MBanner
            tone="ok"
            icon={<MI.Check size={18} />}
            title="FIELD IS CLEAR"
            body="No open pings from the crew."
            action={
              <MPill tone="green" dot>
                CLEAR
              </MPill>
            }
          />
        )}

        {/* Overnight delta — kept as a quiet status banner with a CTA. */}
        {showOvernight ? (
          <MBanner
            tone="info"
            title={
              <>
                OVERNIGHT · {overnight.total} CHANGE{overnight.total === 1 ? '' : 'S'}
              </>
            }
            body={
              <>
                <div style={{ marginBottom: 4, fontFamily: 'var(--m-num)', fontSize: 11, letterSpacing: '0.04em' }}>
                  SINCE 5:00 PM · {overnight.scheduleCount} SCHEDULE · {overnight.issueCount} FIELD ·{' '}
                  {overnight.projectCount} PROJECT
                </div>
                {overnight.buckets.slice(0, 3).map((label, idx) => (
                  <div key={idx} style={{ marginBottom: 2 }}>
                    {label}
                  </div>
                ))}
              </>
            }
            action={
              <MButton
                variant="quiet"
                size="sm"
                onClick={() => {
                  // Freshest signal is usually a field issue. Route to
                  // /field when any landed overnight; otherwise scroll
                  // to the My sites list. (Dismiss happens on the same tap.)
                  dismissOvernight()
                  if (overnight.issueCount > 0) {
                    navigate(nav.field)
                  } else if (typeof document !== 'undefined') {
                    const el = document.getElementById('fm-today-sites')
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                }}
              >
                See changes
              </MButton>
            }
          />
        ) : null}

        {/* Big-number lead block: a clock when quiet, the live all-sites
            spend when busy. Mono micro-labels, full-bleed hard rules. */}
        <div
          style={{
            padding: '24px 20px',
            borderTop: '2px solid var(--m-ink)',
            borderBottom: '2px solid var(--m-ink)',
          }}
        >
          <div className="m-kpi-eyebrow">
            {fieldClear
              ? `TODAY · ${activeSites.length} ${activeSites.length === 1 ? 'SITE' : 'SITES'} OPEN`
              : 'ALL SITES · SPENT TODAY'}
          </div>
          <div
            className="num"
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: fieldClear ? 64 : 56,
              fontWeight: 800,
              letterSpacing: '-0.035em',
              lineHeight: 0.9,
              marginTop: 8,
              color: 'var(--m-ink)',
            }}
          >
            {fieldClear ? nowClock : formatMoney(todayLaborCost)}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              marginTop: 8,
            }}
          >
            <span style={{ color: 'var(--m-green)' }}>● </span>
            {formatDecimalHours(totalHours, 1)} CREW-HRS LIVE
          </div>
        </div>

        <div id="fm-today-sites" />
        <div className="m-section-bar">
          <span>MY SITES</span>
          <span>{sortedSites.length}</span>
        </div>
        {sortedSites.length === 0 ? (
          <div
            style={{
              padding: '24px 20px',
              fontFamily: 'var(--m-num)',
              fontSize: 12,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            No active sites. Sites you're assigned to land here.
          </div>
        ) : (
          sortedSites.map((p) => (
            <SiteCard
              key={p.id}
              project={p}
              hours={todayHoursByProject.get(p.id) ?? 0}
              workers={workers}
              briefed={briefedSet.has(p.id)}
              openBlockerCount={(issuesByProject.get(p.id) ?? []).length}
              onBrief={() => navigate(nav.brief(p.id))}
              onView={() => navigate(nav.project(p.id))}
            />
          ))
        )}
        <div style={{ padding: 20 }}>
          <MButton variant="primary" onClick={() => navigate(nav.brief())}>
            BRIEF THE CREW
          </MButton>
        </div>
      </MBody>
    </>
  )
}

// ---------------------------------------------------------------------------
// Desktop composition — the former screens/desktop/fm-today.tsx, folded in
// verbatim (data + behavior preserved) with navigation resolved through
// resolveForemanNav so it works under the /desktop/fm shell.
// ---------------------------------------------------------------------------

type SiteRow = {
  id: string
  name: string
  crew: number
  scope: string
  spent: number
  status: string
  /** Brief pushed time (HH:MM) for today, or null when not yet briefed. */
  briefedAt: string | null
}

// Real open worker_issues feed (the field_event workflow), parity with the
// mobile foreman-field inbox. Replaces the old bootstrap-derived crew proxy.
type OpenIssueRow = {
  id: string
  project_id: string | null
  worker_id: string | null
  kind: string
  message: string
  severity?: 'question' | 'slowing' | 'stopped' | null
  resolved_at: string | null
  created_at: string
}

// A "field event" is a recent, glanceable change on an active site, derived
// purely from bootstrap (no worker-issues SSE here): a schedule landed today
// or a project row was edited today. Mirrors the mobile overnight-delta idea
// at desktop altitude.
type FieldEvent = {
  id: string
  site: string
  text: string
}

function isActive(status: string): boolean {
  return /progress|active/i.test(status)
}

function ForemanTodayDesktop({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const nav = resolveForemanNav(useLocation().pathname)

  // Poll the same open-issues feed the mobile foreman inbox uses. The desktop
  // used to fake "open blockers" from "active sites with no crew logged"; this
  // is the real field_event feed.
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

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const schedules = useMemo(() => bootstrap?.schedules ?? [], [bootstrap?.schedules])

  const today = todayIso()
  const activeSitesForBriefs = useMemo(() => projects.filter((p) => isActive(p.status)), [projects])

  // Per-active-site brief lookup for today: did the foreman push a brief, and
  // when? Drives the "Unbriefed" KPI + the table's BRIEF column (design dsg__33).
  // One cheap round-trip per active site, mirroring the mobile render above.
  const briefQueries = useQueries({
    queries: activeSitesForBriefs.map((p) => ({
      queryKey: ['projects', 'briefs', p.id, today],
      queryFn: () =>
        request<ProjectBriefListResponse>(`/api/projects/${encodeURIComponent(p.id)}/briefs?date=${today}`),
      enabled: Boolean(p.id),
      staleTime: 60_000,
    })),
  })
  const briefedAtByProject = useMemo(() => {
    const map = new Map<string, string | null>()
    activeSitesForBriefs.forEach((p, i) => {
      const briefs = briefQueries[i]?.data?.briefs ?? []
      const latest = briefs[briefs.length - 1]
      map.set(p.id, latest ? (latest.updated_at ?? latest.created_at ?? null) : null)
    })
    return map
  }, [activeSitesForBriefs, briefQueries])

  const { activeSites, rows, totalHours, totalSpent, crewOnSite, fieldEvents } = useMemo(() => {
    const activeSites = projects.filter((p) => isActive(p.status))
    const activeIds = new Set(activeSites.map((p) => p.id))

    // Today's hours + crew-on-site per active project.
    const hoursByProject = new Map<string, number>()
    const crewByProject = new Map<string, Set<string>>()
    for (const l of labor) {
      if (l.occurred_on !== today || l.deleted_at || !l.project_id) continue
      if (!activeIds.has(l.project_id)) continue
      hoursByProject.set(l.project_id, (hoursByProject.get(l.project_id) ?? 0) + Number(l.hours ?? 0))
      if (l.worker_id) {
        const set = crewByProject.get(l.project_id) ?? new Set<string>()
        set.add(l.worker_id)
        crewByProject.set(l.project_id, set)
      }
    }

    const rows: SiteRow[] = activeSites.map((p) => {
      const hrs = hoursByProject.get(p.id) ?? 0
      const briefedIso = briefedAtByProject.get(p.id) ?? null
      return {
        id: p.id,
        name: p.name,
        crew: crewByProject.get(p.id)?.size ?? 0,
        scope: p.division_code ?? '—',
        spent: hrs * Number(p.labor_rate ?? 0),
        status: p.status,
        briefedAt: briefedIso ? timeOfDay(briefedIso) : null,
      }
    })

    const totalHours = Array.from(hoursByProject.values()).reduce((s, h) => s + h, 0)
    const totalSpent = rows.reduce((s, r) => s + r.spent, 0)
    const crewOnSite = new Set<string>()
    for (const set of crewByProject.values()) for (const w of set) crewOnSite.add(w)

    // From the field: schedules confirmed for today + sites edited today.
    const fieldEvents: FieldEvent[] = []
    const nameById = new Map(projects.map((p) => [p.id, p.name]))
    for (const s of schedules) {
      if (s.deleted_at) continue
      if (!activeIds.has(s.project_id)) continue
      if (s.scheduled_for !== today) continue
      const crewCount = Array.isArray(s.crew) ? s.crew.length : 0
      fieldEvents.push({
        id: `sched-${s.id}`,
        site: nameById.get(s.project_id) ?? 'Site',
        text: crewCount > 0 ? `Crew of ${crewCount} scheduled today` : 'Scheduled for today',
      })
    }
    for (const p of activeSites) {
      const u = parseTs(p.updated_at)
      const c = parseTs(p.created_at)
      if (u !== null && c !== null && u > c && p.updated_at.slice(0, 10) === today) {
        fieldEvents.push({ id: `proj-${p.id}`, site: p.name, text: 'Site updated today' })
      }
    }

    return { activeSites, rows, totalHours, totalSpent, crewOnSite: crewOnSite.size, fieldEvents }
  }, [projects, workers, labor, schedules, today, briefedAtByProject])

  // Open blockers: the real open worker_issues count (the field_event feed),
  // not the old "active site with no crew logged" proxy.
  const openBlockers = openIssues.length
  const stoppedBlockers = openIssues.filter((i) => i.severity === 'stopped' || i.kind === 'safety')
  const projectNameById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])

  // Sites still missing today's brief (design's UNBRIEFED KPI). Only count
  // once the per-site brief lookups have resolved so the tile doesn't flash
  // a false "all unbriefed" on first paint.
  const briefsResolved = briefQueries.every((q) => q.isSuccess || q.isError)
  const unbriefedRows = useMemo(() => rows.filter((r) => r.briefedAt === null), [rows])
  const unbriefedCount = briefsResolved ? unbriefedRows.length : 0

  // The single most-pressing blocker, surfaced as a dedicated red hero card
  // (design dsg__33). Prefer a stopped/safety issue, else the freshest open
  // issue. The hero replaces the generic "from the field" banner when present.
  const heroBlocker = useMemo(() => {
    if (openIssues.length === 0) return null
    return stoppedBlockers[0] ?? openIssues[0] ?? null
  }, [openIssues, stoppedBlockers])

  function cleanIssueText(msg: string): string {
    return msg
      .replace(/^\[[^\]]+\]\s*/, '')
      .replace(/\[severity:[^\]]+\]/g, '')
      .trim()
  }

  function relativeTime(iso: string): string {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return ''
    const mins = Math.round((Date.now() - t) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    const hrs = Math.round(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.round(hrs / 24)}d ago`
  }

  const columns: Array<DColumn<SiteRow>> = [
    { key: 'name', header: 'Site', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'crew', header: 'Crew', numeric: true, render: (r) => String(r.crew) },
    { key: 'scope', header: 'Scope', render: (r) => r.scope },
    { key: 'spent', header: 'Spent today', numeric: true, render: (r) => formatMoney(r.spent) },
    {
      key: 'brief',
      header: 'Brief',
      render: (r) =>
        r.briefedAt ? (
          <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, color: 'var(--m-ink-2)' }}>
            PUSHED {r.briefedAt}
          </span>
        ) : (
          <span style={{ fontFamily: 'var(--m-num)', fontSize: 11, fontWeight: 700, color: 'var(--m-bad, #b3261e)' }}>
            NOT BRIEFED
          </span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={r.briefedAt === null ? 'amber' : r.crew === 0 ? 'amber' : statusTone(r.status)} dot>
          {r.briefedAt === null ? 'UNBRIEFED' : r.crew === 0 ? 'NO CREW' : formatStatusLabel(r.status)}
        </MPill>
      ),
    },
    {
      key: 'briefAction',
      header: '',
      render: (r) => (
        // SiteRow.id is the project id (see activeSites mapping above), so the
        // FM Brief route is keyed off it. Stop the click from bubbling to the
        // row's project-detail navigation.
        <MButton
          size="sm"
          variant={r.briefedAt === null ? 'primary' : 'ghost'}
          onClick={(e) => {
            e.stopPropagation()
            navigate(nav.brief(r.id))
          }}
        >
          {r.briefedAt === null ? 'Brief crew' : 'View brief'}
        </MButton>
      ),
    },
  ]

  const siteWord = activeSites.length === 1 ? 'site' : 'sites'

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>
            Foreman · Today · {activeSites.length} {siteWord}
          </DEyebrow>
          <DH1>
            {(() => {
              const needs = openBlockers + unbriefedCount
              if (needs === 0) return 'Field is clear.'
              return `${needs} thing${needs === 1 ? '' : 's'} need you.`
            })()}
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi label="Sites today" value={String(activeSites.length)} meta={`${siteWord} running`} />
          <DKpi
            label="Crew on clock"
            value={String(crewOnSite)}
            meta={crewOnSite > 0 ? `across ${activeSites.length} ${siteWord}` : 'nobody clocked in'}
          />
          <DKpi
            label="Spent today"
            value={totalSpent > 0 ? formatMoney(totalSpent) : '—'}
            tone="accent"
            meta={totalHours > 0 ? `${formatDecimalHours(totalHours, 1)} logged` : 'no clock-ins'}
            metaTone={totalHours > 0 ? 'good' : undefined}
          />
          <DKpi
            label="Unbriefed"
            value={String(unbriefedCount)}
            tone={unbriefedCount > 0 ? 'accent' : undefined}
            meta={
              unbriefedCount > 0
                ? unbriefedRows.map((r) => r.name).join(', ')
                : activeSites.length > 0
                  ? 'all briefed'
                  : 'no sites'
            }
            metaTone={unbriefedCount > 0 ? 'bad' : 'good'}
          />
        </DKpiStrip>

        {heroBlocker ? (
          (() => {
            const site = heroBlocker.project_id ? (projectNameById.get(heroBlocker.project_id) ?? 'Site') : 'No project'
            const flaggedBy = heroBlocker.worker_id
              ? (workers.find((w) => w.id === heroBlocker.worker_id)?.name ?? 'Crew')
              : 'Crew'
            const text = cleanIssueText(heroBlocker.message)
            const when = relativeTime(heroBlocker.created_at)
            const tag = `${heroBlocker.severity === 'stopped' || heroBlocker.kind === 'safety' ? 'STOPPED' : 'BLOCKER'} · ${flaggedBy.toUpperCase()}`
            return (
              // Full-width red blocker hero (design dsg__33): a status pill, the
              // site + headline, a "who · when · what" sub-line, and a white
              // RESOLVE action. Mirrors the brutalist red blocker card.
              <div
                className="d-card"
                style={{
                  background: 'var(--m-bad, #b3261e)',
                  color: '#fff',
                  border: '2px solid var(--m-ink)',
                  padding: '24px 28px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 24,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      background: 'var(--m-ink)',
                      color: '#fff',
                      padding: '4px 10px',
                      fontFamily: 'var(--m-num)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                    }}
                  >
                    <span className="m-dot" style={{ background: '#fff' }} />
                    {tag}
                  </span>
                  <div
                    style={{
                      fontFamily: 'var(--m-font-tight, var(--m-font))',
                      fontWeight: 800,
                      fontSize: 30,
                      lineHeight: 1.05,
                      marginTop: 12,
                    }}
                  >
                    {site} — {text}
                  </div>
                  <div style={{ marginTop: 10, fontSize: 14, opacity: 0.92 }}>
                    {flaggedBy} flagged{when ? ` ${when}` : ''}
                    {openBlockers > 1 ? ` · ${openBlockers - 1} more open` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => navigate(nav.blocker(heroBlocker.id))}
                  style={{
                    flexShrink: 0,
                    background: '#fff',
                    color: 'var(--m-ink)',
                    border: '2px solid var(--m-ink)',
                    padding: '12px 20px',
                    fontFamily: 'var(--m-num)',
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                  }}
                >
                  Resolve →
                </button>
              </div>
            )
          })()
        ) : fieldEvents.length > 0 ? (
          <MBanner
            tone="attention"
            icon={<MI.AlertTri size={18} />}
            title={`FROM THE FIELD · ${fieldEvents.length} UPDATE${fieldEvents.length === 1 ? '' : 'S'}`}
            body={
              <>
                {fieldEvents.slice(0, 4).map((e) => (
                  <div key={e.id} style={{ marginBottom: 2 }}>
                    <strong>{e.site}</strong> — {e.text}
                  </div>
                ))}
              </>
            }
            action={
              <MButton variant="primary" size="sm" onClick={() => navigate(nav.schedule)}>
                See schedule
              </MButton>
            }
          />
        ) : (
          <MBanner
            tone="ok"
            icon={<MI.Check size={18} />}
            title="FIELD IS CLEAR"
            body="No new pings from the crew today."
            action={
              <MPill tone="green" dot>
                CLEAR
              </MPill>
            }
          />
        )}

        <DataTable<SiteRow>
          title="Sites today"
          action={
            <MButton size="sm" variant="primary" onClick={() => navigate(nav.schedule)}>
              View schedule
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(nav.project(r.id))}
          empty="No active sites. Sites you're assigned to land here once they kick off."
        />
      </div>
    </div>
  )
}

function SiteCard({
  project,
  hours,
  workers,
  briefed,
  openBlockerCount,
  onBrief,
  onView,
}: {
  project: ProjectRow
  hours: number
  workers: BootstrapResponse['workers']
  briefed: boolean
  openBlockerCount: number
  onBrief: () => void
  onView: () => void
}) {
  // Crew-on-site count is a coarse proxy: any worker with hours logged on
  // this project today is "in". The foreman's `fm-crew` screen is the
  // canonical clock-state surface; this card is just a glance.
  const crewSize = workers.length
  const onSiteCount = hours > 0 ? Math.min(crewSize, Math.max(1, Math.round(hours / 4))) : 0
  const expected = Math.max(crewSize, onSiteCount)
  const spentToday = hours * Number(project.labor_rate ?? 0)

  // Status posture drives the full-bleed row tint + pill: blocked when an
  // open issue exists, unbriefed when no brief sent, otherwise on.
  const blocked = openBlockerCount > 0
  const rowTint = blocked ? 'var(--m-sand)' : !briefed ? 'var(--m-card-soft)' : undefined
  const meta = `${onSiteCount} OF ${expected} CREW · ${
    hours > 0 ? `${formatDecimalHours(hours, 1)} HRS` : 'NO HRS YET'
  }`

  return (
    <div
      style={{
        padding: '18px 20px',
        borderBottom: '2px solid var(--m-ink)',
        background: rowTint,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div
          className="m-h-display"
          style={{
            fontSize: 22,
            lineHeight: 1,
            minWidth: 0,
            flex: 1,
            color: !briefed && !blocked ? 'var(--m-ink-3)' : 'var(--m-ink)',
          }}
        >
          {project.name.toUpperCase()}
        </div>
        {blocked ? (
          <MPill tone="red" dot>
            BLOCKED
          </MPill>
        ) : !briefed ? (
          <MPill tone="amber" dot>
            UNBRIEFED
          </MPill>
        ) : (
          <MPill tone="green" dot>
            ON
          </MPill>
        )}
      </div>

      <div
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--m-ink-3)',
          marginTop: 6,
        }}
      >
        {project.customer_name || project.division_code} · {meta}
        {blocked ? <span style={{ color: 'var(--m-red)' }}> · {openBlockerCount} OPEN</span> : null}
      </div>

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'flex-end', gap: 14 }}>
        <MKpi
          label="SPENT TODAY"
          value={formatMoney(spentToday)}
          meta={hours > 0 ? `${formatDecimalHours(hours, 1)} CREW-HRS` : 'NO HOURS YET'}
        />
        <div style={{ paddingBottom: 4 }}>
          <MAvatarGroup
            avatars={workers.slice(0, 3).map((w) => ({ initials: initialsFor(w.name), tone: avatarToneFor(w.id) }))}
            max={3}
            size="sm"
          />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <MButtonRow>
          <MButton variant="primary" onClick={onBrief}>
            BRIEF CREW
          </MButton>
          <MButton variant="ghost" onClick={onView}>
            VIEW SITE
          </MButton>
        </MButtonRow>
      </div>
    </div>
  )
}

function sitePriority(
  a: ProjectRow,
  b: ProjectRow,
  briefedSet: ReadonlySet<string>,
  issuesByProject: Map<string, IssueRow[]>,
): number {
  // Unbriefed first.
  const aBrief = briefedSet.has(a.id) ? 1 : 0
  const bBrief = briefedSet.has(b.id) ? 1 : 0
  if (aBrief !== bBrief) return aBrief - bBrief
  // Then by open-blocker count, descending.
  const ab = issuesByProject.get(a.id)?.length ?? 0
  const bb = issuesByProject.get(b.id)?.length ?? 0
  if (ab !== bb) return bb - ab
  return a.name.localeCompare(b.name)
}

function shortMonthDay(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}
