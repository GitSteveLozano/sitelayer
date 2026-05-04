/**
 * Foreman home — `fm-today`. Multi-site stacked view: header summary,
 * "FROM THE FIELD" block (worker_issues that need triage), then a card
 * per active site with crew + budget + briefed-by line.
 *
 * Polls /api/worker-issues for the open issues so the foreman gets a
 * realistic triage queue without the SSE channel that Phase 8's roadmap
 * note describes (that's a follow-up).
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet, type BootstrapResponse } from '../../api-v1-compat.js'
import {
  MAvatarGroup,
  MBody,
  MButton,
  MI,
  MLargeHead,
  MListInset,
  MListRow,
  MSectionH,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MAiStripe } from '../../components/m/ai.js'
import { formatDecimalHours, formatMoney, todayIso } from './format.js'

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

export function ForemanToday({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const [issues, setIssues] = useState<readonly IssueRow[] | null>(null)

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

  const todayHoursByProject = useMemo(() => {
    const map = new Map<string, number>()
    for (const l of labor) {
      if (l.occurred_on === today && !l.deleted_at && l.project_id) {
        map.set(l.project_id, (map.get(l.project_id) ?? 0) + Number(l.hours ?? 0))
      }
    }
    return map
  }, [labor, today])

  const todayLaborCost = Array.from(todayHoursByProject.entries()).reduce((sum, [pid, hrs]) => {
    const p = projects.find((x) => x.id === pid)
    return sum + hrs * Number(p?.labor_rate ?? 0)
  }, 0)
  const totalHours = Array.from(todayHoursByProject.values()).reduce((s, h) => s + h, 0)

  const openIssues = issues?.filter((i) => !i.resolved_at) ?? []
  const needYou = openIssues.length

  return (
    <>
      <MTopBar title="Today" />
      <MBody>
        <MLargeHead
          eyebrow={`FOREMAN · ${shortMonthDay()}`}
          title={`${activeSites.length} ${activeSites.length === 1 ? 'site' : 'sites'} · ${workers.length} crew`}
          sub={`${formatDecimalHours(totalHours, 1)} crew-hrs · ${formatMoney(todayLaborCost)} live`}
        />
        {needYou > 0 ? (
          <div style={{ padding: '0 16px' }}>
            <MAiStripe
              eyebrow={`FROM THE FIELD · ${needYou} need ${needYou === 1 ? 'you' : 'you'}`}
              tone="warn"
              action={
                <MButton variant="quiet" size="sm" onClick={() => navigate('/m/field')}>
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
        <MSectionH>My sites</MSectionH>
        <MListInset>
          {activeSites.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--m-ink-3)', fontSize: 13 }}>
              No active sites. Sites you're assigned to land here.
            </div>
          ) : (
            activeSites.slice(0, 6).map((p) => {
              const hrs = todayHoursByProject.get(p.id) ?? 0
              const crew = workers.slice(0, 3)
              return (
                <MListRow
                  key={p.id}
                  leading={<MI.Home size={18} />}
                  leadingTone={hrs > 0 ? 'accent' : undefined}
                  headline={p.name}
                  supporting={
                    <span>
                      {p.division_code} ·{' '}
                      {hrs > 0 ? (
                        <span style={{ color: 'var(--m-accent)' }}>You're here</span>
                      ) : (
                        <span>{crew.length} crew</span>
                      )}
                    </span>
                  }
                  trailing={
                    hrs > 0 ? (
                      <span className="num">{formatDecimalHours(hrs, 1)}</span>
                    ) : (
                      <MAvatarGroup
                        avatars={crew.map((w) => ({ initials: initialsFor(w.name), tone: avatarToneFor(w.id) }))}
                        max={3}
                        size="sm"
                      />
                    )
                  }
                  chev
                  onTap={() => navigate(`/m/projects/${p.id}`)}
                />
              )
            })
          )}
        </MListInset>
        <div style={{ padding: 16 }}>
          <MButton variant="primary" onClick={() => navigate('/m/brief')}>
            Brief the crew
          </MButton>
        </div>
      </MBody>
    </>
  )
}

function shortMonthDay(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}
