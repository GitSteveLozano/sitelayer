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
import type { BootstrapResponse } from '@/lib/api'
import { DataTable, DEyebrow, DH1, DKpi, DKpiStrip, type DColumn } from '@/components/d'
import { MBanner, MButton, MI, MPill } from '@/components/m'
import { formatDecimalHours, formatMoney, formatStatusLabel, statusTone, todayIso } from '../mobile/format.js'

type SiteRow = {
  id: string
  name: string
  crew: number
  scope: string
  spent: number
  status: string
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

export function FmToday({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const schedules = useMemo(() => bootstrap?.schedules ?? [], [bootstrap?.schedules])

  const { activeSites, rows, totalHours, totalSpent, crewOnSite, fieldEvents } = useMemo(() => {
    const today = todayIso()
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
      return {
        id: p.id,
        name: p.name,
        crew: crewByProject.get(p.id)?.size ?? 0,
        scope: p.division_code ?? '—',
        spent: hrs * Number(p.labor_rate ?? 0),
        status: p.status,
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
  }, [projects, workers, labor, schedules])

  // Open blockers: active sites with no crew logged + no hours today read as
  // unstaffed — a coarse "needs attention" proxy without the issues feed.
  const openBlockers = rows.filter((r) => r.crew === 0).length

  const columns: Array<DColumn<SiteRow>> = [
    { key: 'name', header: 'Site', render: (r) => <span className="d-table-cell-strong">{r.name}</span> },
    { key: 'crew', header: 'Crew', numeric: true, render: (r) => String(r.crew) },
    { key: 'scope', header: 'Scope', render: (r) => r.scope },
    { key: 'spent', header: 'Spent today', numeric: true, render: (r) => formatMoney(r.spent) },
    {
      key: 'status',
      header: 'Status',
      render: (r) => (
        <MPill tone={r.crew === 0 ? 'amber' : statusTone(r.status)} dot>
          {r.crew === 0 ? 'NO CREW' : formatStatusLabel(r.status)}
        </MPill>
      ),
    },
  ]

  const siteWord = activeSites.length === 1 ? 'site' : 'sites'

  return (
    <div className="d-content">
      <div className="d-stack">
        <div>
          <DEyebrow>Foreman · Today</DEyebrow>
          <DH1>
            {activeSites.length} {siteWord} today.
            {openBlockers > 0 ? ` ${openBlockers} need crew.` : ' All staffed.'}
          </DH1>
        </div>

        <DKpiStrip>
          <DKpi
            label="Crew on site"
            value={String(crewOnSite)}
            meta={`across ${activeSites.length} ${siteWord}`}
          />
          <DKpi label="Sites active" value={String(activeSites.length)} meta={`${siteWord} running`} />
          <DKpi
            label="Open blockers"
            value={String(openBlockers)}
            tone={openBlockers > 0 ? 'accent' : undefined}
            meta={openBlockers > 0 ? 'sites without crew' : 'none open'}
            metaTone={openBlockers > 0 ? 'bad' : 'good'}
          />
          <DKpi
            label="Hours today"
            value={formatDecimalHours(totalHours, 1).replace('h', '')}
            unit="h"
            meta={totalHours > 0 ? formatMoney(totalSpent) : 'no clock-ins'}
            metaTone={totalHours > 0 ? 'good' : undefined}
          />
        </DKpiStrip>

        {fieldEvents.length > 0 ? (
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
              <MButton variant="primary" size="sm" onClick={() => navigate('/schedule')}>
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
            <MButton size="sm" variant="primary" onClick={() => navigate('/schedule')}>
              View schedule
            </MButton>
          }
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/projects/${r.id}`)}
          empty="No active sites. Sites you're assigned to land here once they kick off."
        />
      </div>
    </div>
  )
}
