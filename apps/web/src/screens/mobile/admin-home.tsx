/**
 * Admin "Today" calm dashboard. Mobile companion to the desktop home.
 *
 * Per the design (Design Overview/estimator/screenshots/db-calm-default.png),
 * the dashboard is calm by default — when nothing's wrong, it does not
 * manufacture urgency. The hero is a one-liner ("You're caught up.")
 * followed by a today-by-default segmented control and stacked site
 * cards drawn from active projects + today's labor entries.
 */
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse, ProjectRow } from '@/lib/api'
import {
  MAvatar,
  MBody,
  MButton,
  MChip,
  MChipRow,
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
import { Spark } from '../../components/m/ai.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { formatDecimalHours, formatMoney, formatStatusLabel, statusTone, todayIso } from './format.js'

export type AdminHomeProps = {
  bootstrap: BootstrapResponse | null
}

export function AdminHome({ bootstrap }: AdminHomeProps) {
  const navigate = useNavigate()
  const [view, setView] = useState<'today' | 'needs' | 'week' | 'all'>('today')

  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])

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

  const attentionItems = useMemo(() => {
    const today = todayIso()
    const items: AttentionItem[] = []
    for (const p of projects) {
      if (/estim|sent|await|lead/i.test(p.status)) {
        items.push({
          id: `estimate-${p.id}`,
          tone: 'accent',
          eyebrow: 'Estimate',
          title: `${p.name} needs a bid follow-up`,
          body: `${p.customer_name} · ${formatStatusLabel(p.status)}`,
          why: `Flagged because this project is in "${formatStatusLabel(p.status)}" — a sent or in-flight estimate with no acceptance yet. Estimates that sit without a nudge close at a lower rate.`,
          action: 'Open project',
          projectId: p.id,
        })
      }
    }
    for (const p of activeProjects) {
      const hrs = labor
        .filter((l) => l.occurred_on === today && !l.deleted_at && l.project_id === p.id)
        .reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
      const laborBurn = hrs * Number(p.labor_rate ?? 0)
      const bid = Number(p.bid_total ?? 0)
      if (bid > 0 && laborBurn > bid * 0.18) {
        items.push({
          id: `risk-${p.id}`,
          tone: 'red',
          eyebrow: `At risk · ${formatMoney(laborBurn)}`,
          title: `${p.name} labor is trending hot`,
          body: `${formatDecimalHours(hrs, 1)} logged today. Review crew plan before the next dispatch.`,
          why: `Today's labor burn (${formatMoney(laborBurn)}) is more than 18% of the ${formatMoney(bid)} bid in a single day. At this pace the labor budget runs out before the job does.`,
          action: 'Review site',
          projectId: p.id,
        })
      }
    }
    return items.slice(0, 5)
  }, [activeProjects, labor, projects])

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
          onPrimary={() => navigate('/projects/new')}
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
        onAction={() => navigate('/projects/new')}
      />
      <MBody>
        <MLargeHead
          eyebrow={new Date()
            .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
            .toUpperCase()}
          title={
            view === 'needs'
              ? `${attentionItems.length} ${pl(attentionItems.length, 'thing', 'things')} ${attentionItems.length === 1 ? 'needs' : 'need'} you.`
              : heroTitle
          }
          sub={view === 'needs' ? 'Sorted by impact. Tap to handle, then get back to the day.' : heroSub}
          right={<MAvatar initials={initialsFromCompany(bootstrap.company.name)} />}
        />
        <MChipRow>
          <MChip active={view === 'today'} onClick={() => setView('today')}>
            Today
          </MChip>
          <MChip active={view === 'needs'} onClick={() => setView('needs')}>
            What needs me {attentionItems.length > 0 ? attentionItems.length : ''}
          </MChip>
          <MChip active={view === 'week'} onClick={() => setView('week')}>
            This week
          </MChip>
          <MChip active={view === 'all'} onClick={() => setView('all')}>
            All sites
          </MChip>
        </MChipRow>
        {view === 'needs' ? (
          <AttentionList items={attentionItems} onOpen={(projectId) => navigate(`/projects/${projectId}`)} />
        ) : (
          <>
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
            <MSectionH link="See all" onLinkClick={() => navigate('/projects')}>
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
                {activeProjects.slice(0, view === 'all' ? 20 : 5).map((p) => {
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
                      onTap={() => navigate(`/projects/${p.id}`)}
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
          </>
        )}
      </MBody>
    </>
  )
}

type AttentionItem = {
  id: string
  tone: 'accent' | 'red'
  eyebrow: string
  title: string
  body: string
  /** The "Why this card?" reveal — surfaces the data behind the flag. */
  why: string
  action: string
  projectId: string
}

function AttentionList({ items, onOpen }: { items: readonly AttentionItem[]; onOpen: (projectId: string) => void }) {
  // Dismissed cards stay hidden for the session — AI is offered, never
  // imposed (Design Overview/design_system AI rules). Tracked by item id.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set())
  const visible = items.filter((i) => !dismissed.has(i.id))

  if (visible.length === 0) {
    return (
      <div style={{ padding: '0 16px' }}>
        <div className="m-card" style={{ color: 'var(--m-ink-3)', fontSize: 13 }}>
          Nothing needs owner action right now. Estimates, field stops, and budget risks land here.
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '0 16px 16px' }}>
      {visible.map((item) => (
        <AttentionCard
          key={item.id}
          item={item}
          onOpen={() => onOpen(item.projectId)}
          onDismiss={() => setDismissed((prev) => new Set(prev).add(item.id))}
        />
      ))}
    </div>
  )
}

/**
 * Single AI priority card — mirrors db-pm.png: Spark-marked eyebrow,
 * dismiss (×), title + body, a "Why this card?" reveal (the data moat
 * made visible), and the primary action. Confidence is ordinal (the
 * eyebrow), never a numeric score, per the AI rules.
 */
function AttentionCard({
  item,
  onOpen,
  onDismiss,
}: {
  item: AttentionItem
  onOpen: () => void
  onDismiss: () => void
}) {
  const [showWhy, setShowWhy] = useState(false)
  const accent = item.tone === 'red' ? 'var(--m-red)' : 'var(--m-accent)'
  const accentInk = item.tone === 'red' ? 'var(--m-red)' : 'var(--m-accent-ink)'

  return (
    <div
      className="m-card"
      style={{
        borderLeft: `3px solid ${accent}`,
        boxShadow: 'var(--m-shadow-card)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div
          style={{
            color: accentInk,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
          }}
        >
          <Spark size={11} state="strong" />
          {item.eyebrow}
        </div>
        <button type="button" className="m-ai-dismiss" aria-label="Dismiss" onClick={onDismiss}>
          <MI.X size={12} />
        </button>
      </div>
      <div style={{ marginTop: 10, fontSize: 17, fontWeight: 700, lineHeight: 1.18 }}>{item.title}</div>
      <div style={{ marginTop: 7, color: 'var(--m-ink-2)', fontSize: 13, lineHeight: 1.35 }}>{item.body}</div>
      {showWhy ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--m-ink-3)',
            lineHeight: 1.4,
            borderTop: '1px solid var(--m-line)',
            paddingTop: 8,
          }}
        >
          {item.why}
        </div>
      ) : null}
      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button
          type="button"
          onClick={() => setShowWhy((v) => !v)}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            color: 'var(--m-ink-3)',
            fontSize: 12,
            fontWeight: 500,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            cursor: 'pointer',
          }}
        >
          <Spark size={10} state="muted" />
          {showWhy ? 'Hide' : 'Why this card?'}
        </button>
        <MButton size="sm" variant="primary" onClick={onOpen}>
          {item.action}
        </MButton>
      </div>
    </div>
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
