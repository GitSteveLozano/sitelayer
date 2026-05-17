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
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet, type BootstrapResponse, type ProjectRow } from '@/lib/api'
import {
  MAvatarGroup,
  MBody,
  MButton,
  MButtonRow,
  MI,
  MLargeHead,
  MSectionH,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { request } from '../../lib/api/client.js'
import type { ProjectBriefListResponse } from '../../lib/api/projects.js'
import { formatDecimalHours, formatMoney, todayIso } from './format.js'

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

export function ForemanToday({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
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

  return (
    <>
      <MTopBar title="Today" />
      <MBody>
        <MLargeHead
          eyebrow={`FOREMAN · ${shortMonthDay()}`}
          title={`${activeSites.length} ${activeSites.length === 1 ? 'site' : 'sites'} · ${workers.length} crew`}
          sub={`${formatDecimalHours(totalHours, 1)} crew-hrs · ${formatMoney(todayLaborCost)} live`}
        />
        {showOvernight ? (
          <div style={{ padding: '0 16px' }}>
            <MAiStripe
              eyebrow="OVERNIGHT"
              attribution={
                <>
                  Based on{' '}
                  <strong>
                    {overnight.total} change{overnight.total === 1 ? '' : 's'}
                  </strong>{' '}
                  since 5:00 PM yesterday ({overnight.scheduleCount} schedule · {overnight.issueCount} field ·{' '}
                  {overnight.projectCount} project).
                </>
              }
              action={
                <MButton
                  variant="quiet"
                  size="sm"
                  onClick={() => {
                    // Freshest signal is usually a field issue. Route to
                    // /field when any landed overnight; otherwise scroll
                    // to the My sites list.
                    if (overnight.issueCount > 0) {
                      navigate('/field')
                    } else if (typeof document !== 'undefined') {
                      const el = document.getElementById('fm-today-sites')
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }
                  }}
                >
                  See changes
                </MButton>
              }
              onDismiss={dismissOvernight}
            >
              {overnight.buckets.slice(0, 3).map((label, idx) => (
                <div key={idx} style={{ marginBottom: 4 }}>
                  {label}
                </div>
              ))}
            </MAiStripe>
          </div>
        ) : null}
        {needYou > 0 ? (
          <div style={{ padding: '0 16px' }}>
            <MAiStripe
              eyebrow={`FROM THE FIELD · ${needYou} need ${needYou === 1 ? 'you' : 'you'}`}
              tone="warn"
              attribution={
                <>
                  Based on <strong>{needYou} open</strong> {needYou === 1 ? 'issue' : 'issues'} from the field today.
                </>
              }
              action={
                <MButton variant="quiet" size="sm" onClick={() => navigate('/field')}>
                  See all
                </MButton>
              }
            >
              {openIssues.slice(0, 3).map((i) => {
                const w = workers.find((x) => x.id === i.worker_id)
                return (
                  <div key={i.id} style={{ marginBottom: 4 }}>
                    <strong style={{ color: 'var(--m-ink)' }}>{w?.name ?? 'A worker'}</strong> ·{' '}
                    {projects.find((p) => p.id === i.project_id)?.name ?? 'unknown site'} —{' '}
                    {i.message.replace(/^\[[^\]]+\]\s*/, '').slice(0, 60)}
                  </div>
                )
              })}
            </MAiStripe>
          </div>
        ) : null}
        <div
          style={{
            margin: '14px 16px',
            background: '#1c1816',
            color: '#f3ecdf',
            borderRadius: 12,
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: '#aea69a',
              }}
            >
              All sites · today
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 2 }} className="num">
              {formatMoney(todayLaborCost)}
              <span style={{ color: '#aea69a', fontWeight: 500, fontSize: 14, marginLeft: 8 }}>live</span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#aea69a' }}>
              <span style={{ color: 'var(--m-green)', fontWeight: 600 }}>● </span>
              {formatDecimalHours(totalHours, 1)} crew-hrs
            </div>
          </div>
        </div>
        <div id="fm-today-sites" />
        <MSectionH>My sites</MSectionH>
        {sortedSites.length === 0 ? (
          <div style={{ padding: 16, color: 'var(--m-ink-3)', fontSize: 13 }}>
            No active sites. Sites you're assigned to land here.
          </div>
        ) : (
          <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sortedSites.map((p) => (
              <SiteCard
                key={p.id}
                project={p}
                hours={todayHoursByProject.get(p.id) ?? 0}
                workers={workers}
                briefed={briefedSet.has(p.id)}
                openBlockerCount={(issuesByProject.get(p.id) ?? []).length}
                onBrief={() => navigate(`/brief/${p.id}`)}
                onView={() => navigate(`/projects/${p.id}`)}
              />
            ))}
          </div>
        )}
        <div style={{ padding: 16 }}>
          <MButton variant="primary" onClick={() => navigate('/brief')}>
            Brief the crew
          </MButton>
        </div>
      </MBody>
    </>
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
  const progressPct = project.target_sqft_per_hr ? Math.min(100, Math.round((hours / 8) * 100)) : null
  return (
    <div className="m-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>{project.name}</div>
          <div className="m-quiet-sm" style={{ marginTop: 2 }}>
            {project.customer_name || project.division_code}
          </div>
        </div>
        {!briefed ? (
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '3px 7px',
              borderRadius: 999,
              background: 'var(--m-amber-soft, rgba(217,144,74,0.15))',
              color: 'var(--m-amber, #c2772d)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              whiteSpace: 'nowrap',
            }}
          >
            Needs brief
          </span>
        ) : null}
      </div>
      <div
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 13,
          color: 'var(--m-ink-2)',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <MI.Users size={14} />
          {onSiteCount} of {expected}
        </span>
        {progressPct !== null ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                display: 'inline-block',
                width: 60,
                height: 6,
                borderRadius: 3,
                background: 'var(--m-line)',
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  width: `${progressPct}%`,
                  background: 'var(--m-accent)',
                }}
              />
            </span>
            {progressPct}%
          </span>
        ) : null}
        {openBlockerCount > 0 ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--m-red)' }}>
            <MI.AlertTri size={14} />
            {openBlockerCount} open
          </span>
        ) : null}
      </div>
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <MAvatarGroup
          avatars={workers.slice(0, 3).map((w) => ({ initials: initialsFor(w.name), tone: avatarToneFor(w.id) }))}
          max={3}
          size="sm"
        />
        <span className="num m-quiet-sm">{hours > 0 ? `${formatDecimalHours(hours, 1)} today` : 'no hours yet'}</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <MButtonRow>
          <MButton variant="primary" onClick={onBrief}>
            Brief crew
          </MButton>
          <MButton variant="ghost" onClick={onView}>
            View site
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
