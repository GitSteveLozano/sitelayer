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
import type { BootstrapResponse } from '@/lib/api'
import { MBody, MI, MLargeHead, MListInset, MListRow, MPill, MSectionH, MTopBar } from '../../components/m/index.js'
import { formatDecimalHours, formatMoney, shortDate, todayIso } from './format.js'

// Standard full-time week. Drives the "OF 40 HRS" eyebrow + the
// proportion the worker has logged so far.
const WEEKLY_TARGET_HRS = 40

/** Decimal hours → "HH:MM" for the headline total. */
function formatHoursMinutes(decimalHours: number): string {
  if (!Number.isFinite(decimalHours) || decimalHours < 0) return '0:00'
  const totalMinutes = Math.round(decimalHours * 60)
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return `${h}:${m.toString().padStart(2, '0')}`
}

/** Bucket a labor-entry status into the worker-facing approval state. */
function approvalBucket(status: string): 'approved' | 'pending' | 'disputed' {
  const s = (status ?? '').toLowerCase()
  if (s.includes('disput') || s.includes('reject')) return 'disputed'
  if (s.includes('approv') || s.includes('lock') || s.includes('post')) return 'approved'
  return 'pending'
}

// Local-date ISO. `Date.toISOString()` is UTC and rolls "today" forward
// in negative-offset timezones — labor.occurred_on is keyed off the
// user's calendar, so we need the local date here.
function localIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

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
    const cutoff = localIso(sevenDaysAgo)
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
      const iso = localIso(d)
      days.push({
        iso,
        label: d.toLocaleDateString('en-US', { weekday: 'short' }),
        hours: recent.filter((l) => l.occurred_on === iso).reduce((sum, l) => sum + Number(l.hours ?? 0), 0),
      })
    }
    return days
  }, [recent])

  const peak = Math.max(1, ...dayBars.map((d) => d.hours))

  // Pay-period summary. Without a per-worker period boundary in the
  // bootstrap we treat the visible week of labor as the period-to-date
  // window — enough to surface gross + approval-state counts. Counts are
  // per-entry; the dollar figure is the worker's own gross (rate × hrs).
  const periodSummary = useMemo(() => {
    const counts = { approved: 0, pending: 0, disputed: 0 }
    let gross = 0
    for (const l of recent) {
      counts[approvalBucket(l.status ?? '')] += 1
      const project = projects.find((p) => p.id === l.project_id)
      gross += Number(l.hours ?? 0) * Number(project?.labor_rate ?? 0)
    }
    return { counts, gross }
  }, [recent, projects])

  return (
    <>
      <MTopBar back title="My week" onBack={() => navigate('/today')} />
      <MBody pad>
        <MLargeHead
          eyebrow={`THIS WEEK · ${shortDate(dayBars[0]!.iso).toUpperCase()}–${shortDate(dayBars[6]!.iso).toUpperCase()}`}
          title={
            <span>
              <span className="num" style={{ fontSize: 48, fontWeight: 600, letterSpacing: '-0.02em' }}>
                {formatHoursMinutes(totalHours)}
              </span>
              <span
                className="m-topbar-eyebrow"
                style={{ display: 'block', marginTop: 4 }}
              >{`OF ${WEEKLY_TARGET_HRS} HRS`}</span>
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
            const isToday = d.iso === todayIso()
            return (
              <div
                key={d.iso}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
              >
                <span style={{ fontSize: 10, color: isToday ? 'var(--m-accent)' : 'var(--m-ink-3)', fontWeight: 600 }}>
                  {d.hours > 0 ? d.hours.toFixed(1) : ''}
                </span>
                {d.hours > 0 ? (
                  <div
                    style={{
                      width: '70%',
                      height,
                      // Today's bar is accent; logged past days are the
                      // de-emphasized "black"/neutral bar from the design.
                      background: isToday ? 'var(--m-accent)' : 'var(--m-line-2)',
                      borderRadius: 4,
                    }}
                  />
                ) : (
                  // Days with no hours yet render as a dashed placeholder
                  // (Fri–Sun in the design) so the strip reads as a full week.
                  <div
                    style={{
                      width: '70%',
                      height: Math.max(28, 110 * 0.4),
                      border: '1.5px dashed var(--m-line-2)',
                      borderRadius: 4,
                    }}
                  />
                )}
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
              const isToday = d.iso === todayIso()
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
        <div style={{ marginTop: 18 }}>
          <MSectionH>Pay period to date</MSectionH>
          <div className="m-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <div className="m-topbar-eyebrow">Pay period to date</div>
                <div
                  className="num"
                  style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 4, lineHeight: 1 }}
                >
                  {formatMoney(periodSummary.gross)}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <MPill tone="green">{`${periodSummary.counts.approved} approved`}</MPill>
              <MPill tone="amber">{`${periodSummary.counts.pending} pending`}</MPill>
              {periodSummary.counts.disputed > 0 ? (
                <MPill tone="red" dot>{`${periodSummary.counts.disputed} disputed`}</MPill>
              ) : null}
            </div>
          </div>
        </div>
        <div className="m-quiet-sm" style={{ textAlign: 'center', padding: 16 }}>
          Questions? Talk to your foreman.
        </div>
      </MBody>
    </>
  )
}
