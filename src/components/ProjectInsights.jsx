import { useMemo } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Bar } from './Atoms'
import { fmt, toDateStr } from '../lib/calc'
import { SCOPE_ITEMS } from './BlueprintCanvas'

export function ProjectInsights({ project, entries }) {
  const laborRate = project.labor_rate || 38

  // ── Compute all views from entries ──────────────────────────────────────
  const { thisWeek, weekDays, byWorker, byItem, recentWeeks, maxDayHours, weekTotal } = useMemo(() => {
    const now = new Date()
    const day = now.getDay()
    const mon = new Date(now)
    mon.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
    mon.setHours(0, 0, 0, 0)
    const sun = new Date(mon)
    sun.setDate(mon.getDate() + 6)
    const monStr = toDateStr(mon)
    const sunStr = toDateStr(sun)

    // This week's entries
    const thisWeek = entries.filter(e =>
      e.work_date && e.work_date >= monStr && e.work_date <= sunStr
    )

    // Build 7-day grid
    const weekDays = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(mon)
      d.setDate(mon.getDate() + i)
      const dateStr = toDateStr(d)
      const dayEntries = thisWeek.filter(e => e.work_date === dateStr)
      const hours = dayEntries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0)
      return {
        date: dateStr,
        label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i],
        hours,
        workers: new Set(dayEntries.map(e => e.worker_id)).size,
        isToday: dateStr === toDateStr(now),
        confirmed: dayEntries.length > 0,
      }
    })
    const maxDayHours = Math.max(...weekDays.map(d => d.hours), 1)
    const weekTotal = weekDays.reduce((s, d) => s + d.hours, 0)

    // By worker (all time)
    const workerMap = {}
    entries.forEach(e => {
      const name = e.worker?.name || 'Unknown'
      if (!workerMap[name]) workerMap[name] = { hours: 0, entries: 0, lastDate: null }
      workerMap[name].hours += parseFloat(e.hours) || 0
      workerMap[name].entries += 1
      if (!workerMap[name].lastDate || e.work_date > workerMap[name].lastDate) {
        workerMap[name].lastDate = e.work_date
      }
    })
    const byWorker = Object.entries(workerMap)
      .map(([name, d]) => ({ name, ...d }))
      .sort((a, b) => b.hours - a.hours)

    // By service item (all time)
    const itemMap = {}
    entries.forEach(e => {
      const key = e.service_item || 'Unassigned'
      if (!itemMap[key]) itemMap[key] = { hours: 0, entries: 0, color: null }
      itemMap[key].hours += parseFloat(e.hours) || 0
      itemMap[key].entries += 1
      if (!itemMap[key].color) {
        const si = SCOPE_ITEMS.find(s => s.id === key)
        itemMap[key].color = si?.color || TH.muted
      }
    })
    const byItem = Object.entries(itemMap)
      .map(([item, d]) => ({ item, ...d }))
      .sort((a, b) => b.hours - a.hours)

    // Weekly trend — last 6 weeks
    const recentWeeks = []
    for (let w = 0; w < 6; w++) {
      const wMon = new Date(mon)
      wMon.setDate(mon.getDate() - w * 7)
      const wSun = new Date(wMon)
      wSun.setDate(wMon.getDate() + 6)
      const wMonStr = toDateStr(wMon)
      const wSunStr = toDateStr(wSun)
      const wEntries = entries.filter(e =>
        e.work_date && e.work_date >= wMonStr && e.work_date <= wSunStr
      )
      const wHours = wEntries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0)
      if (wHours > 0 || w === 0) {
        recentWeeks.push({
          label: w === 0 ? 'This week' : w === 1 ? 'Last week' : `${w}w ago`,
          start: wMonStr,
          hours: wHours,
          workers: new Set(wEntries.map(e => e.worker_id)).size,
          cost: wHours * laborRate,
        })
      }
    }

    return { thisWeek, weekDays, byWorker, byItem, recentWeeks, maxDayHours, weekTotal }
  }, [entries, laborRate])

  const totalHours = entries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0)
  const totalCost = totalHours * laborRate
  const maxWorkerHours = byWorker.length > 0 ? byWorker[0].hours : 1
  const maxItemHours = byItem.length > 0 ? byItem[0].hours : 1

  if (entries.length === 0) {
    return (
      <Card style={{ textAlign: 'center', padding: 40 }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
        <div style={{ fontSize: 15, fontWeight: 500, color: TH.text, marginBottom: 6 }}>
          No time entries yet
        </div>
        <div style={{ fontSize: 13, color: TH.muted, lineHeight: 1.6 }}>
          Confirm daily work in the Time Tracking tab to see insights here.
        </div>
      </Card>
    )
  }

  const sectionTitle = { fontSize: 11, fontWeight: 600, color: TH.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ── Summary stats ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
        {[
          { label: 'Total Hours', value: fmt.hrs(totalHours), color: TH.text },
          { label: 'Labor Cost', value: fmt.money(totalCost), color: TH.amber },
          { label: 'Workers', value: byWorker.length, color: TH.text },
          { label: 'Entries', value: entries.length, color: TH.muted },
        ].map(s => (
          <Card key={s.label} style={{ padding: '14px 12px', textAlign: 'center' }}>
            <div style={{ fontSize: 20, fontWeight: 600, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.value}</div>
            <div style={{ fontSize: 10, color: TH.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 4 }}>{s.label}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* ── This Week ── */}
        <Card>
          <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between' }}>
            <span>This Week</span>
            <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{weekTotal.toFixed(1)}h</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {weekDays.map(d => (
              <div key={d.date} style={{ textAlign: 'center' }}>
                <div style={{
                  fontSize: 10, fontWeight: 600, marginBottom: 6,
                  color: d.isToday ? TH.amber : TH.muted,
                }}>
                  {d.label}
                </div>
                <div style={{
                  height: 48, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                  padding: '0 2px',
                }}>
                  <div style={{
                    height: `${Math.max(4, (d.hours / maxDayHours) * 48)}px`,
                    background: d.isToday ? TH.amber : d.confirmed ? TH.green : TH.border,
                    borderRadius: 3,
                    transition: 'height 0.3s ease',
                  }} />
                </div>
                <div style={{
                  fontSize: 11, fontWeight: d.isToday ? 600 : 400, marginTop: 4,
                  color: d.hours > 0 ? TH.text : TH.faint,
                }}>
                  {d.hours > 0 ? `${d.hours.toFixed(0)}h` : '—'}
                </div>
                {d.workers > 0 && (
                  <div style={{ fontSize: 9, color: TH.muted }}>{d.workers}w</div>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* ── Weekly Trend ── */}
        <Card>
          <div style={sectionTitle}>Weekly Trend</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentWeeks.map((w, i) => {
              const maxWeekHours = Math.max(...recentWeeks.map(w => w.hours), 1)
              return (
                <div key={w.start}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                    <span style={{ color: i === 0 ? TH.text : TH.muted, fontWeight: i === 0 ? 500 : 400 }}>{w.label}</span>
                    <span style={{ color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                      {w.hours.toFixed(1)}h · {w.workers}w · {fmt.money(w.cost)}
                    </span>
                  </div>
                  <Bar value={w.hours / maxWeekHours} color={i === 0 ? TH.amber : TH.green} h={6} />
                </div>
              )
            })}
          </div>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>

        {/* ── By Worker ── */}
        <Card>
          <div style={sectionTitle}>Hours by Worker</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {byWorker.slice(0, 10).map(w => (
              <div key={w.name}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                  <span style={{ fontWeight: 500, color: TH.text }}>{w.name}</span>
                  <span style={{ color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {w.hours.toFixed(1)}h · {fmt.money(w.hours * laborRate)}
                  </span>
                </div>
                <Bar value={w.hours / maxWorkerHours} color={TH.amber} h={5} />
              </div>
            ))}
          </div>
        </Card>

        {/* ── By Service Item ── */}
        <Card>
          <div style={sectionTitle}>Hours by Service Item</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {byItem.map(it => (
              <div key={it.item}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                  <span style={{ fontWeight: 500, color: TH.text, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: it.color, display: 'inline-block', flexShrink: 0 }} />
                    {it.item}
                  </span>
                  <span style={{ color: TH.muted, fontVariantNumeric: 'tabular-nums' }}>
                    {it.hours.toFixed(1)}h · {fmt.money(it.hours * laborRate)}
                  </span>
                </div>
                <Bar value={it.hours / maxItemHours} color={it.color} h={5} />
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* ── Recent Entries ── */}
      <Card>
        <div style={sectionTitle}>Recent Entries</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${TH.border}` }}>
              <th style={thStyle}>Date</th>
              <th style={thStyle}>Worker</th>
              <th style={thStyle}>Task</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Hours</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, 15).map((e, i) => (
              <tr key={e.id || i} style={{ borderBottom: `1px solid ${TH.border}22` }}>
                <td style={tdStyle}>
                  {e.work_date ? new Date(e.work_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                </td>
                <td style={tdStyle}>{e.worker?.name || '—'}</td>
                <td style={{ ...tdStyle, color: TH.muted }}>{e.service_item || '—'}</td>
                <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {(parseFloat(e.hours) || 0).toFixed(1)}
                </td>
                <td style={{ ...tdStyle, textAlign: 'right', color: TH.amber, fontVariantNumeric: 'tabular-nums' }}>
                  {fmt.money((parseFloat(e.hours) || 0) * laborRate)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}

const thStyle = { textAlign: 'left', padding: '5px 0', color: TH.muted, fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }
const tdStyle = { padding: '7px 0', color: TH.text }
