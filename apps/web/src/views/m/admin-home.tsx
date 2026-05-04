/**
 * Admin "Today" calm dashboard. Mobile companion to the desktop home.
 *
 * Per the design (Design Overview/estimator/screenshots/db-calm-default.png),
 * the dashboard is calm by default — when nothing's wrong, it does not
 * manufacture urgency. The hero is a one-liner ("You're caught up.")
 * followed by a today-by-default segmented control and stacked site
 * cards drawn from active projects + today's labor entries.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse, ProjectRow } from '../../api.js'
import {
  MAvatar,
  MBody,
  MI,
  MKpi,
  MKpiRow,
  MLargeHead,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
} from '../../components/m/index.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { formatDecimalHours, formatMoney, formatStatusLabel, statusTone, todayIso } from './format.js'

export type AdminHomeProps = {
  bootstrap: BootstrapResponse | null
}

export function AdminHome({ bootstrap }: AdminHomeProps) {
  const navigate = useNavigate()

  const projects = bootstrap?.projects ?? []
  const labor = bootstrap?.laborEntries ?? []

  const { activeProjects, todayHoursByProject, todayTotal } = useMemo(() => {
    const today = todayIso()
    const activeProjects = projects.filter((p) => isActiveStatus(p.status))
    const todayLabor = labor.filter((l) => l.occurred_on === today && !l.deleted_at)
    const map = new Map<string, number>()
    let total = 0
    for (const l of todayLabor) {
      const hours = Number(l.hours ?? 0)
      total += hours
      if (l.project_id) {
        map.set(l.project_id, (map.get(l.project_id) ?? 0) + hours)
      }
    }
    return { activeProjects, todayHoursByProject: map, todayTotal: total }
  }, [projects, labor])

  if (!bootstrap) {
    return (
      <>
        <MTopBar title="Today" />
        <MBody />
      </>
    )
  }

  if (projects.length === 0) {
    return (
      <>
        <MTopBar title="Projects" actionIcon={<MI.Plus size={20} />} actionLabel="New project" />
        <MEmptyState
          title="No projects yet"
          body="Start with an address or upload drawings — Sitelayer will help you get to a measurement plan in under a minute."
          primaryLabel="New project"
          secondaryLabel="Import from QuickBooks"
          onPrimary={() => navigate('/m/projects/new')}
        />
      </>
    )
  }

  const heroTitle =
    activeProjects.length === 0
      ? "You're caught up."
      : `${activeProjects.length} ${pl(activeProjects.length, 'site', 'sites')} running`
  const heroSub =
    activeProjects.length === 0
      ? 'Nothing on fire. Plan tomorrow when you have a minute.'
      : `${formatDecimalHours(todayTotal, 1)} crew-hrs logged today across ${activeProjects.length} ${pl(activeProjects.length, 'site', 'sites')}.`

  return (
    <>
      <MTopBar
        title="Today"
        actionIcon={<MI.Plus size={20} />}
        actionLabel="New"
        onAction={() => navigate('/m/projects/new')}
      />
      <MBody>
        <MLargeHead
          eyebrow={new Date()
            .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
            .toUpperCase()}
          title={heroTitle}
          sub={heroSub}
          right={<MAvatar initials={initialsFromCompany(bootstrap.company.name)} />}
        />
        <MKpiRow cols={2}>
          <MKpi
            label="Today on site"
            value={String(activeProjects.length)}
            unit={pl(activeProjects.length, 'site', 'sites')}
          />
          <MKpi
            label="Crew-hrs"
            value={formatDecimalHours(todayTotal, 1).replace('h', '')}
            unit="h"
            meta={todayTotal > 0 ? 'Live' : 'No clock-ins yet'}
            metaTone={todayTotal > 0 ? 'green' : undefined}
          />
        </MKpiRow>
        <MSectionH link="See all" onLinkClick={() => navigate('/m/projects')}>
          Today on site
        </MSectionH>
        {activeProjects.length === 0 ? (
          <div style={{ padding: '0 16px' }}>
            <div className="m-card" style={{ color: 'var(--m-ink-3)', fontSize: 13 }}>
              No active sites. New projects you create land here once they kick off.
            </div>
          </div>
        ) : (
          <MListInset>
            {activeProjects.slice(0, 5).map((p) => {
              const hrs = todayHoursByProject.get(p.id) ?? 0
              return (
                <MListRow
                  key={p.id}
                  leading={<MI.Home size={18} />}
                  leadingTone={statusTone(p.status) === 'green' ? 'accent' : undefined}
                  headline={p.name}
                  supporting={`${p.customer_name} · ${p.division_code}`}
                  trailing={
                    hrs > 0 ? (
                      <span className="num">{formatDecimalHours(hrs, 1)}</span>
                    ) : (
                      <MPill tone={statusTone(p.status)} dot>
                        {formatStatusLabel(p.status)}
                      </MPill>
                    )
                  }
                  chev
                  onTap={() => navigate(`/m/projects/${p.id}`)}
                />
              )
            })}
          </MListInset>
        )}
        <MSectionH>Quick stats</MSectionH>
        <MKpiRow cols={2}>
          <MKpi
            label="Bid pipeline"
            value={String(projects.filter((p) => /estim|sent|await/i.test(p.status)).length)}
            meta="In-flight estimates"
          />
          <MKpi
            label="Active value"
            value={formatMoney(activeProjects.reduce((sum, p) => sum + Number(p.bid_total ?? 0), 0))}
            meta={`${activeProjects.length} ${pl(activeProjects.length, 'project', 'projects')}`}
          />
        </MKpiRow>
      </MBody>
    </>
  )
}

function isActiveStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes('progress') || s.includes('active')
}

function pl<T extends string>(n: number, sing: T, plur: T): T {
  return (n === 1 ? sing : plur) as T
}

function initialsFromCompany(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export type AdminProjectsListProps = {
  projects: readonly ProjectRow[]
  onOpen: (project: ProjectRow) => void
}
