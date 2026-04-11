import { useState, useEffect, useMemo } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Select, Btn, Badge, Bar } from './Atoms'
import { useCrewSchedule, useLaborEntry, useConfirmedByDate, useWeekEntries } from '../hooks/useTimeTracking'
import { useIsMobile } from '../hooks/useIsMobile'
import { SCOPE_ITEMS } from './BlueprintCanvas'

const LABOR_RATE = 38 // $/hr default — matches project creation default

export function DailyConfirm({ companyId, onConfirmed, onNavigate }) {
  const isMobile = useIsMobile()
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date()
    return today.toISOString().split('T')[0]
  })
  const { schedule: schedData, workers: workerList, loading, error, refetch: loadSchedule } = useCrewSchedule(companyId, selectedDate)
  const { saving, error: saveError, submit } = useLaborEntry()
  const { entries: confirmedEntries, refetch: refetchConfirmed } = useConfirmedByDate(companyId, selectedDate)
  const { entries: weekEntries, weekRange, refetch: refetchWeek } = useWeekEntries(companyId, selectedDate)
  const [confirmed, setConfirmed] = useState(false)

  // Build draft entries from schedule + existing entries
  const draftEntries = useMemo(() => {
    const scheduledMap = new Map(schedData?.scheduled_workers?.map(w => [w, {
      worker_id: w,
      project_id: schedData.project_id,
      project_name: schedData.project?.name,
      division: schedData.project?.division,
    }]) || [])
    const existingMap = new Map(confirmedEntries.map(e => [e.worker_id, e]))

    const result = []

    // Scheduled workers first
    scheduledMap.forEach((info, wid) => {
      const existing = existingMap.get(wid)
      result.push({
        id: existing?.id,
        worker_id: wid,
        worker_name: workerList.find(w => w.id === wid)?.name || 'Unknown',
        project_id: info.project_id,
        project_name: info.project_name,
        division: info.division,
        hours: existing?.hours ?? 8,
        service_item: existing?.service_item || '',
        status: existing?.status || 'draft',
        confirmed: !!existing,
      })
    })

    // Add unscheduled but confirmed
    confirmedEntries.forEach(e => {
      if (!scheduledMap.has(e.worker_id)) {
        result.push({
          ...e,
          worker_name: workerList.find(w => w.id === e.worker_id)?.name || 'Unknown',
          confirmed: true,
        })
      }
    })

    return result
  }, [schedData, confirmedEntries, workerList])

  const [entries, setEntries] = useState([])

  useEffect(() => {
    setEntries(draftEntries)
    setConfirmed(false)
  }, [draftEntries])

  function updateEntry(index, updates) {
    setEntries(prev => {
      const next = [...prev]
      next[index] = { ...next[index], ...updates }
      return next
    })
  }

  function removeEntry(index) {
    setEntries(prev => prev.filter((_, i) => i !== index))
  }

  function addExtraWorker() {
    setEntries(prev => [...prev, {
      worker_id: '',
      worker_name: '',
      project_id: schedData?.project_id || '',
      project_name: schedData?.project?.name || '',
      hours: 8,
      service_item: '',
      status: 'draft',
      confirmed: false,
      isExtra: true,
    }])
  }

  async function confirmDay() {
    const toSave = entries
      .filter(e => e.worker_id && e.project_id && e.hours > 0)
      .map(e => ({
        ...(e.id ? { id: e.id } : {}),
        company_id: companyId,
        project_id: e.project_id,
        worker_id: e.worker_id,
        work_date: selectedDate,
        hours: parseFloat(e.hours),
        service_item: e.service_item,
        status: 'confirmed',
      }))

    const { error: submitError } = await submit(toSave)

    if (!submitError) {
      setConfirmed(true)
      refetchConfirmed()
      refetchWeek()
      onConfirmed?.()
    }
  }

  const totalHours = entries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0)
  const allHaveServiceItem = entries.every(e => e.service_item)
  const hasNoSchedule = !schedData && confirmedEntries.length === 0
  const hasNoCrew = workerList.length === 0

  if (loading || saving) return <div style={{ padding: 40, textAlign: 'center' }}>{loading ? 'Loading…' : 'Saving…'}</div>

  return (
    <div style={{ padding: isMobile ? '16px 14px' : '24px 20px', maxWidth: 700 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isMobile ? 12 : 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: isMobile ? 18 : 20, color: TH.text }}>
            Confirm Day's Work
          </h2>
          <p style={{ margin: 0, fontSize: isMobile ? 12 : 13, color: TH.muted }}>
            Review hours and assign service items for {formatDate(selectedDate)}
          </p>
        </div>
        <Input
          type="date"
          value={selectedDate}
          onChange={e => { setSelectedDate(e.target.value); setConfirmed(false) }}
          style={{ width: 'auto' }}
        />
      </div>

      {/* Save error */}
      {saveError && (
        <div style={{
          background: '#fef2f2', border: `1px solid ${TH.red}44`,
          borderRadius: 6, padding: '12px 16px', marginBottom: 16,
          fontSize: 13, color: TH.red,
        }}>
          Failed to save: {saveError}
        </div>
      )}

      {/* ─── Post-confirmation summary ─────────────────────────────────── */}
      {confirmed && entries.length > 0 && (
        <ConfirmationSummary
          entries={entries}
          schedData={schedData}
          workerList={workerList}
          weekEntries={weekEntries}
          weekRange={weekRange}
          selectedDate={selectedDate}
          totalHours={totalHours}
          isMobile={isMobile}
        />
      )}

      {/* Worker entries */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        {entries.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: isMobile ? 28 : 40 }}>
            {hasNoCrew ? (
              <div>
                <div style={{ fontSize: 32, marginBottom: 12 }}>👷</div>
                <div style={{ fontSize: 15, fontWeight: 500, color: TH.text, marginBottom: 6 }}>
                  No crew members yet
                </div>
                <div style={{ fontSize: 13, color: TH.muted, marginBottom: 16, lineHeight: 1.6 }}>
                  Add your workers first, then create a schedule to auto-populate this page.
                </div>
                {onNavigate && (
                  <Btn onClick={() => onNavigate('workers')} style={{ fontSize: 13 }}>
                    Go to Crew
                  </Btn>
                )}
              </div>
            ) : hasNoSchedule ? (
              <div>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📅</div>
                <div style={{ fontSize: 15, fontWeight: 500, color: TH.text, marginBottom: 6 }}>
                  No schedule for {formatDate(selectedDate)}
                </div>
                <div style={{ fontSize: 13, color: TH.muted, marginBottom: 16, lineHeight: 1.6 }}>
                  Set up a schedule to auto-fill the crew, or add workers manually below.
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                  {onNavigate && (
                    <Btn variant="ghost" onClick={() => onNavigate('schedule')} style={{ fontSize: 13 }}>
                      Go to Schedule
                    </Btn>
                  )}
                  <Btn onClick={addExtraWorker} style={{ fontSize: 13 }}>
                    + Add Worker Manually
                  </Btn>
                </div>
              </div>
            ) : (
              <div style={{ color: TH.muted }}>
                No entries for this date.
              </div>
            )}
          </Card>
        ) : (
          entries.map((entry, i) => (
            <Card key={`${entry.worker_id}-${i}`} style={{ padding: isMobile ? '12px 14px' : '14px 16px' }}>
              <div style={{ display: 'grid', gap: isMobile ? 10 : 12, alignItems: 'center' }}>
                {/* Row 1: Worker + Project */}
                <div style={{ display: 'flex', gap: isMobile ? 8 : 12, flexWrap: 'wrap' }}>
                  {entry.isExtra ? (
                    <Select
                      label="Worker"
                      value={entry.worker_id}
                      onChange={e => {
                        const wid = e.target.value
                        const w = workerList.find(x => x.id === wid)
                        updateEntry(i, { worker_id: wid, worker_name: w?.name || '' })
                      }}
                      options={[
                        { value: '', label: 'Select worker…' },
                        ...workerList.map(w => ({ value: w.id, label: w.name })),
                      ]}
                      style={{ minWidth: isMobile ? 120 : 150 }}
                    />
                  ) : (
                    <div style={{ fontWeight: 600, color: TH.text, minWidth: isMobile ? 120 : 150 }}>
                      {entry.worker_name}
                    </div>
                  )}

                  <div style={{ flex: 1, minWidth: isMobile ? 140 : 200 }}>
                    <div style={{ fontSize: isMobile ? 10 : 11, color: TH.muted, marginBottom: 4 }}>Project</div>
                    <Badge
                      label={entry.project_name || 'Unknown'}
                      color={TH.divColors?.[entry.division] || TH.amber}
                    />
                  </div>
                </div>

                {/* Row 2: Hours + Service Item */}
                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '100px 1fr auto', gap: isMobile ? 8 : 12, alignItems: 'end' }}>
                  <Input
                    label="Hours"
                    type="number"
                    step="0.5"
                    min="0"
                    value={entry.hours}
                    onChange={e => updateEntry(i, { hours: e.target.value })}
                  />

                  <Select
                    label={<span>Service Item <span style={{ color: TH.red, fontWeight: 400 }}>*</span></span>}
                    value={entry.service_item}
                    onChange={e => updateEntry(i, { service_item: e.target.value })}
                    options={[
                      { value: '', label: 'Select…' },
                      ...SCOPE_ITEMS.map(s => ({ value: s.id, label: isMobile ? s.id : `${s.id} (${s.unit})` })),
                    ]}
                  />

                  {(entry.isExtra || entries.length > 1) && (
                    <Btn variant="ghost" onClick={() => removeEntry(i)} style={{ height: isMobile ? 36 : 38 }}>
                      {isMobile ? '×' : 'Remove'}
                    </Btn>
                  )}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Actions — only show when there are entries */}
      {(entries.length > 0 || !hasNoCrew) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: isMobile ? 12 : 16 }}>
          <Btn variant="ghost" onClick={addExtraWorker}>
            + Add Worker
          </Btn>

          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {entries.length > 0 && (
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: isMobile ? 11 : 12, color: TH.muted }}>Total Hours</div>
                <div style={{ fontSize: isMobile ? 18 : 20, fontWeight: 600, color: TH.text }}>{totalHours.toFixed(1)}</div>
              </div>
            )}

            <Btn
              onClick={confirmDay}
              disabled={saving || entries.length === 0 || !allHaveServiceItem}
            >
              {saving ? 'Saving…' : confirmed ? 'Re-confirm' : 'Confirm Day'}
            </Btn>
          </div>
        </div>
      )}

      {!allHaveServiceItem && entries.length > 0 && (
        <div style={{ marginTop: isMobile ? 10 : 12, fontSize: isMobile ? 11 : 12, color: TH.amber }}>
          Select a service item for each worker to enable confirmation
        </div>
      )}
    </div>
  )
}

// ── Post-confirmation summary ─────────────────────────────────────────────

function ConfirmationSummary({ entries, schedData, workerList, weekEntries, weekRange, selectedDate, totalHours, isMobile }) {
  const validEntries = entries.filter(e => e.worker_id && e.hours > 0)
  const laborCost = totalHours * LABOR_RATE

  // ── Day breakdown: by service item ──
  const byItem = {}
  validEntries.forEach(e => {
    const key = e.service_item || 'Unassigned'
    if (!byItem[key]) byItem[key] = { hours: 0, workers: 0, color: null }
    byItem[key].hours += parseFloat(e.hours) || 0
    byItem[key].workers += 1
    if (!byItem[key].color) {
      const si = SCOPE_ITEMS.find(s => s.id === key)
      byItem[key].color = si?.color || TH.muted
    }
  })

  // ── Schedule comparison ──
  const scheduledWorkerIds = schedData?.scheduled_workers || []
  const confirmedWorkerIds = new Set(validEntries.map(e => e.worker_id))
  const missingFromSchedule = scheduledWorkerIds.filter(id => !confirmedWorkerIds.has(id))
  const extraWorkers = validEntries.filter(e => e.isExtra || !scheduledWorkerIds.includes(e.worker_id))
  const scheduledHours = scheduledWorkerIds.length * 8
  const hoursDiff = totalHours - scheduledHours

  // ── Week-at-a-glance ──
  const weekDays = []
  if (weekRange.start) {
    const mon = new Date(weekRange.start)
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon)
      d.setDate(mon.getDate() + i)
      const dateStr = d.toISOString().split('T')[0]
      const dayEntries = weekEntries.filter(e => e.work_date === dateStr)
      const dayHours = dayEntries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0)
      weekDays.push({
        date: dateStr,
        label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i],
        hours: dayHours,
        workers: new Set(dayEntries.map(e => e.worker_id)).size,
        isToday: dateStr === selectedDate,
        confirmed: dayEntries.length > 0,
      })
    }
  }
  const weekTotal = weekDays.reduce((s, d) => s + d.hours, 0)
  const maxDayHours = Math.max(...weekDays.map(d => d.hours), 1)

  // ── 5-day history (last 5 days with data, excluding today) ──
  const recentDays = weekEntries.length > 0
    ? [...new Set(weekEntries.map(e => e.work_date))]
        .filter(d => d !== selectedDate)
        .sort()
        .slice(-5)
        .map(d => {
          const dayE = weekEntries.filter(e => e.work_date === d)
          return {
            date: d,
            hours: dayE.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0),
            workers: new Set(dayE.map(e => e.worker_id)).size,
          }
        })
    : []

  const sectionStyle = { marginBottom: 16 }
  const sectionTitle = { fontSize: 11, fontWeight: 600, color: TH.muted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }

  return (
    <div style={{ marginBottom: 24 }}>
      {/* Success header */}
      <div style={{
        background: TH.greenLo || '#dcfce7', border: `1px solid ${TH.green}44`,
        borderRadius: '8px 8px 0 0', padding: '14px 18px',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div style={{ fontSize: 14, color: TH.green, fontWeight: 600 }}>
          Day Confirmed
        </div>
        <div style={{ fontSize: 13, color: TH.green }}>
          {validEntries.length} {validEntries.length === 1 ? 'worker' : 'workers'} · {totalHours.toFixed(1)}h · ${laborCost.toLocaleString()}
        </div>
      </div>

      <div style={{
        border: `1px solid ${TH.border}`, borderTop: 'none',
        borderRadius: '0 0 8px 8px', padding: isMobile ? 14 : 18,
        display: 'grid', gap: 20,
      }}>

        {/* ── 1. Day breakdown by service item ── */}
        <div style={sectionStyle}>
          <div style={sectionTitle}>Today's Breakdown</div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 8 }}>
            {Object.entries(byItem).map(([item, data]) => (
              <div key={item} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', background: TH.surf, borderRadius: 6,
                borderLeft: `3px solid ${data.color}`,
              }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: TH.text }}>{item}</div>
                  <div style={{ fontSize: 11, color: TH.muted }}>{data.workers} {data.workers === 1 ? 'worker' : 'workers'}</div>
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, color: TH.text }}>{data.hours.toFixed(1)}h</div>
              </div>
            ))}
          </div>
          {/* Per-worker breakdown */}
          <div style={{ marginTop: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${TH.border}` }}>
                  <th style={{ textAlign: 'left', padding: '5px 0', color: TH.muted, fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Worker</th>
                  <th style={{ textAlign: 'left', padding: '5px 0', color: TH.muted, fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Task</th>
                  <th style={{ textAlign: 'right', padding: '5px 0', color: TH.muted, fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Hours</th>
                  <th style={{ textAlign: 'right', padding: '5px 0', color: TH.muted, fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {validEntries.map((e, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${TH.border}22` }}>
                    <td style={{ padding: '6px 0', color: TH.text }}>{e.worker_name}</td>
                    <td style={{ padding: '6px 0', color: TH.muted }}>{e.service_item || '—'}</td>
                    <td style={{ textAlign: 'right', padding: '6px 0', fontVariantNumeric: 'tabular-nums' }}>{parseFloat(e.hours).toFixed(1)}</td>
                    <td style={{ textAlign: 'right', padding: '6px 0', color: TH.amber, fontVariantNumeric: 'tabular-nums' }}>${(parseFloat(e.hours) * LABOR_RATE).toFixed(0)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: `1px solid ${TH.border}` }}>
                  <td colSpan={2} style={{ padding: '8px 0', fontWeight: 600, color: TH.text }}>Total</td>
                  <td style={{ textAlign: 'right', padding: '8px 0', fontWeight: 600 }}>{totalHours.toFixed(1)}</td>
                  <td style={{ textAlign: 'right', padding: '8px 0', fontWeight: 600, color: TH.amber }}>${laborCost.toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 2. Schedule comparison ── */}
        {scheduledWorkerIds.length > 0 && (
          <div style={sectionStyle}>
            <div style={sectionTitle}>Schedule Comparison</div>
            <div style={{ display: 'flex', gap: isMobile ? 8 : 12, flexWrap: 'wrap' }}>
              <StatCard
                label="Scheduled"
                value={scheduledWorkerIds.length}
                sub="workers"
                color={TH.muted}
              />
              <StatCard
                label="Confirmed"
                value={confirmedWorkerIds.size}
                sub="workers"
                color={confirmedWorkerIds.size >= scheduledWorkerIds.length ? TH.green : TH.amber}
              />
              <StatCard
                label="Hours diff"
                value={`${hoursDiff >= 0 ? '+' : ''}${hoursDiff.toFixed(1)}`}
                sub={`vs ${scheduledHours}h planned`}
                color={Math.abs(hoursDiff) <= 2 ? TH.green : TH.amber}
              />
            </div>
            {missingFromSchedule.length > 0 && (
              <div style={{ marginTop: 10, padding: '8px 12px', background: TH.amber + '12', borderRadius: 6, border: `1px solid ${TH.amber}33` }}>
                <div style={{ fontSize: 12, color: TH.amber, fontWeight: 500 }}>
                  {missingFromSchedule.length} scheduled {missingFromSchedule.length === 1 ? 'worker' : 'workers'} not confirmed:
                </div>
                <div style={{ fontSize: 12, color: TH.muted, marginTop: 4 }}>
                  {missingFromSchedule.map(id => workerList.find(w => w.id === id)?.name || 'Unknown').join(', ')}
                </div>
              </div>
            )}
            {extraWorkers.length > 0 && (
              <div style={{ marginTop: 8, padding: '8px 12px', background: '#3b82f612', borderRadius: 6, border: '1px solid #3b82f633' }}>
                <div style={{ fontSize: 12, color: '#3b82f6', fontWeight: 500 }}>
                  {extraWorkers.length} extra {extraWorkers.length === 1 ? 'worker' : 'workers'} added beyond schedule
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 3. Week at a glance ── */}
        {weekDays.length > 0 && (
          <div style={sectionStyle}>
            <div style={{ ...sectionTitle, display: 'flex', justifyContent: 'space-between' }}>
              <span>This Week</span>
              <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{weekTotal.toFixed(1)}h total</span>
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
          </div>
        )}

        {/* ── 4. Recent history ── */}
        {recentDays.length > 0 && (
          <div>
            <div style={sectionTitle}>Recent Days</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {recentDays.map(d => (
                <div key={d.date} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '6px 10px', background: TH.surf, borderRadius: 5, fontSize: 12,
                }}>
                  <div style={{ color: TH.muted }}>
                    {new Date(d.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </div>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                    <span style={{ color: TH.muted }}>{d.workers}w</span>
                    <span style={{ fontWeight: 500, color: TH.text, fontVariantNumeric: 'tabular-nums', minWidth: 36, textAlign: 'right' }}>
                      {d.hours.toFixed(1)}h
                    </span>
                    <span style={{ color: TH.amber, fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'right' }}>
                      ${(d.hours * LABOR_RATE).toFixed(0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value, sub, color }) {
  return (
    <div style={{
      flex: 1, minWidth: 90, padding: '10px 14px',
      background: (color || TH.muted) + '10', borderRadius: 6,
      border: `1px solid ${(color || TH.muted)}33`, textAlign: 'center',
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || TH.text }}>{value}</div>
      <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: TH.faint }}>{sub}</div>}
    </div>
  )
}

function formatDate(dateStr) {
  const d = new Date(dateStr)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  return isToday ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}
