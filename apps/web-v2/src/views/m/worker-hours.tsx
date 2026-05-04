/**
 * My week — `wk-hours`. Self-service hours check, no editing.
 *
 * Pulled from bootstrap.laborEntries filtered to the current user's
 * worker_id (when known) and grouped by day. Decimal hours per the
 * design's time format convention; the running clock on /m/today
 * is the only place colon-form runs.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '../../api-v1-compat.js'
import { MBody, MI, MLargeHead, MListInset, MListRow, MPill, MSectionH, MTopBar } from '../../components/m/index.js'
import { formatDecimalHours, formatMoney, shortDate } from './format.js'

export function WorkerHours({ bootstrap }: { bootstrap: BootstrapResponse | null }) {
  const navigate = useNavigate()
  const labor = useMemo(() => bootstrap?.laborEntries ?? [], [bootstrap?.laborEntries])
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])

  // Without a workers join keyed by clerk_user_id, we can't reliably scope
  // to "the calling user's labor". Until that mapping is wired we render
  // the whole company's labor week — fine for fixtures and dev.
  const recent = useMemo(() => {
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6)
    const cutoff = sevenDaysAgo.toISOString().slice(0, 10)
    return labor
      .filter((l) => !l.deleted_at && (l.occurred_on ?? '') >= cutoff)
      .sort((a, b) => (a.occurred_on < b.occurred_on ? 1 : -1))
  }, [labor])

  const totalHours = recent.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
  const grossPay = recent.reduce((sum, l) => {
    const project = projects.find((p) => p.id === l.project_id)
    const rate = Number(project?.labor_rate ?? 0)
    return sum + Number(l.hours ?? 0) * rate
  }, 0)

  const dayBars = useMemo(() => {
    const days: Array<{ label: string; iso: string; hours: number }> = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const iso = d.toISOString().slice(0, 10)
      days.push({
        iso,
        label: d.toLocaleDateString('en-US', { weekday: 'short' }),
        hours: recent.filter((l) => l.occurred_on === iso).reduce((sum, l) => sum + Number(l.hours ?? 0), 0),
      })
    }
    return days
  }, [recent])

  const peak = Math.max(1, ...dayBars.map((d) => d.hours))

  return (
    <>
      <MTopBar back title="My week" onBack={() => navigate('/m/today')} />
      <MBody pad>
        <MLargeHead
          eyebrow={`THIS WEEK · ${shortDate(dayBars[0]!.iso).toUpperCase()}–${shortDate(dayBars[6]!.iso).toUpperCase()}`}
          title={
            <span>
              <span className="num">{totalHours.toFixed(1)}</span>
              <span style={{ color: 'var(--m-ink-3)', fontSize: 14, fontWeight: 500, marginLeft: 6 }}>
                hours so far
              </span>
            </span>
          }
          sub={
            <span className="num">
              {formatMoney(grossPay)} gross · ~{formatMoney(grossPay * 0.79)} take-home
            </span>
          }
        />
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, padding: '8px 4px 16px', height: 140 }}>
          {dayBars.map((d) => {
            const height = Math.max(4, (d.hours / peak) * 110)
            const isToday = d.iso === new Date().toISOString().slice(0, 10)
            return (
              <div
                key={d.iso}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
              >
                <span style={{ fontSize: 10, color: isToday ? 'var(--m-accent)' : 'var(--m-ink-3)', fontWeight: 600 }}>
                  {d.hours > 0 ? d.hours.toFixed(1) : ''}
                </span>
                <div
                  style={{
                    width: '70%',
                    height,
                    background: isToday ? 'var(--m-accent)' : 'var(--m-ink)',
                    borderRadius: 4,
                  }}
                />
                <span style={{ fontSize: 10, color: isToday ? 'var(--m-accent)' : 'var(--m-ink-3)' }}>{d.label}</span>
              </div>
            )
          })}
        </div>
        <MSectionH>Daily entries</MSectionH>
        <MListInset>
          {dayBars
            .slice()
            .reverse()
            .map((d) => {
              const dayEntries = recent.filter((l) => l.occurred_on === d.iso)
              const totalForDay = dayEntries.reduce((sum, l) => sum + Number(l.hours ?? 0), 0)
              const isToday = d.iso === new Date().toISOString().slice(0, 10)
              return (
                <MListRow
                  key={d.iso}
                  leading={<MI.Clock size={18} />}
                  leadingTone={isToday ? 'accent' : undefined}
                  headline={`${d.label} ${shortDate(d.iso).split(' ').slice(1).join(' ')}${isToday ? ' (today)' : ''}`}
                  supporting={
                    dayEntries.length > 0
                      ? `${projects.find((p) => p.id === dayEntries[0]?.project_id)?.name ?? ''} · ${dayEntries.length} ${dayEntries.length === 1 ? 'entry' : 'entries'}`
                      : 'No entries'
                  }
                  trailing={
                    isToday && totalForDay > 0 ? (
                      <>
                        <span className="num">{formatDecimalHours(totalForDay, 1)}</span>
                        <MPill tone="accent" dot>
                          live
                        </MPill>
                      </>
                    ) : totalForDay > 0 ? (
                      <span className="num">{formatDecimalHours(totalForDay, 1)}</span>
                    ) : (
                      <span className="num" style={{ color: 'var(--m-ink-4)' }}>
                        —
                      </span>
                    )
                  }
                />
              )
            })}
        </MListInset>
        <div className="m-quiet-sm" style={{ textAlign: 'center', padding: 16 }}>
          Questions? Talk to your foreman.
        </div>
      </MBody>
    </>
  )
}
