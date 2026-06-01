/**
 * Foreman desktop "Today" — multi-site command surface (Desktop v2 · FM).
 * Dense desktop composition of the mobile `fm-today` foreman home: the same
 * bootstrap-derived active-site / crew-hours / spend signals, laid out as a
 * KPI strip + a "from the field" attention block + a per-site DataTable.
 *
 * Unlike the mobile screen (which polls /api/worker-issues with companySlug),
 * the desktop signature only carries `bootstrap`, so the field/per-site data
 * comes entirely from bootstrap: active projects, today's labor entries, and
 * recently-touched sites/schedules. See screens/mobile/foreman-today.tsx.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import { apiGet, request, type BootstrapResponse, type ProjectBriefListResponse } from '@/lib/api'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MBanner, MButton, MI, MPill } from '@/components/m'
import {
  formatDecimalHours,
  formatMoney,
  formatStatusLabel,
  statusTone,
  timeOfDay,
  todayIso,
} from '../mobile/format.js'

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

function parseTs(s: string | null | undefined): number | null {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

function isActive(status: string): boolean {
  return /progress|active/i.test(status)
}

export function FmToday({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()

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
  // One cheap round-trip per active site, mirroring screens/mobile/foreman-today.tsx.
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
        // FM Brief route (fm/brief/:projectId) is keyed off it. Stop the click
        // from bubbling to the row's project-detail navigation.
        <MButton
          size="sm"
          variant={r.briefedAt === null ? 'primary' : 'ghost'}
          onClick={(e) => {
            e.stopPropagation()
            navigate(`/desktop/fm/brief/${r.id}`)
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
                  onClick={() => navigate(`/desktop/fm/blocker/${heroBlocker.id}`)}
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
              <MButton variant="primary" size="sm" onClick={() => navigate('/desktop/fm/schedule')}>
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
            <MButton size="sm" variant="primary" onClick={() => navigate('/desktop/fm/schedule')}>
              View schedule
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/desktop/projects/${r.id}`)}
          empty="No active sites. Sites you're assigned to land here once they kick off."
        />
      </div>
    </div>
  )
}
