import { useState, useEffect } from 'react'
import { TH } from '../lib/theme'
import { Select, Btn } from './Atoms'
import { schedules, projects, workers } from '../lib/db'
import { toDateStr, parseDate } from '../lib/calc'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function Schedule({ companyId }) {
  const [weekOffset, setWeekOffset] = useState(0)
  const [scheduleData, setScheduleData] = useState({})
  const [projectList, setProjectList] = useState([])
  const [workerList, setWorkerList] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const weekStart = getSunday(new Date())
  weekStart.setDate(weekStart.getDate() + weekOffset * 7)

  useEffect(() => {
    loadData()
  }, [companyId, weekOffset])

  async function loadData() {
    setLoading(true)
    const [projRes, workerRes, schedRes] = await Promise.all([
      projects.list(companyId),
      workers.list(companyId),
      schedules.getWeek(companyId, toDateStr(weekStart)),
    ])
    if (projRes.data) setProjectList(projRes.data)
    if (workerRes.data) setWorkerList(workerRes.data)
    const byDate = {}
    schedRes.data?.forEach(s => {
      const date = s.work_date
      if (!byDate[date]) byDate[date] = []
      byDate[date].push(s)
    })
    setScheduleData(byDate)
    setLoading(false)
  }

  async function addAssignment(date, projectId) {
    if (!projectId) return
    setSaving(true)
    await schedules.upsert({
      company_id: companyId,
      project_id: projectId,
      work_date: date,
      scheduled_workers: workerList.map(w => w.id),
    })
    await loadData()
    setSaving(false)
  }

  function removeWorker(assign, workerId) {
    updateWorkers(assign.id, (assign.scheduled_workers || []).filter(id => id !== workerId))
  }

  function addWorkerBack(assign, workerId) {
    updateWorkers(assign.id, [...(assign.scheduled_workers || []), workerId])
  }

  async function updateWorkers(scheduleId, workerIds) {
    setSaving(true)
    await schedules.update(scheduleId, { scheduled_workers: workerIds })
    await loadData()
    setSaving(false)
  }

  async function removeAssignment(scheduleId) {
    setSaving(true)
    await schedules.delete(scheduleId)
    await loadData()
    setSaving(false)
  }

  async function copyPreviousWeek() {
    const prevWeek = new Date(weekStart)
    prevWeek.setDate(prevWeek.getDate() - 7)
    setSaving(true)
    await schedules.copyWeek(companyId, toDateStr(prevWeek), toDateStr(weekStart))
    await loadData()
    setSaving(false)
  }

  const todayStr = toDateStr(new Date())
  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    return toDateStr(d)
  })

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}>Loading…</div>

  const totalCrewDays = Object.values(scheduleData).reduce((s, day) =>
    s + day.reduce((s2, a) => s2 + (a.scheduled_workers?.length || 0), 0), 0)

  return (
    <div style={{ padding: '24px 20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 20, color: TH.text }}>Weekly Schedule</h2>
          <div style={{ fontSize: 13, color: TH.muted }}>
            {formatDate(weekDates[0])} — {formatDate(weekDates[6])}
            {totalCrewDays > 0 && <span style={{ marginLeft: 8 }}>· {totalCrewDays} crew-days</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Btn variant="ghost" onClick={() => setWeekOffset(o => o - 1)} disabled={saving} style={{ padding: '8px 12px', fontSize: 12 }}>←</Btn>
          <Btn variant="ghost" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0 || saving} style={{ padding: '8px 12px', fontSize: 12 }}>Today</Btn>
          <Btn variant="ghost" onClick={() => setWeekOffset(o => o + 1)} disabled={saving} style={{ padding: '8px 12px', fontSize: 12 }}>→</Btn>
          <Btn onClick={copyPreviousWeek} disabled={saving} style={{ padding: '8px 14px', fontSize: 12 }}>
            {saving ? '…' : 'Copy Last Week'}
          </Btn>
        </div>
      </div>

      {/* Schedule grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
        {DAYS.map((dayLabel, i) => {
          const date = weekDates[i]
          const dayAssignments = scheduleData[date] || []
          const isToday = date === todayStr
          const isPast = date < todayStr
          const workerCount = dayAssignments.reduce((s, a) => s + (a.scheduled_workers?.length || 0), 0)

          return (
            <div
              key={date}
              style={{
                borderRadius: 10,
                border: isToday ? `2px solid ${TH.amber}` : `1px solid ${TH.border}44`,
                background: isToday ? TH.card : isPast ? TH.bg : TH.card,
                opacity: isPast && !isToday ? 0.6 : 1,
                display: 'flex', flexDirection: 'column',
                minHeight: 160,
              }}
            >
              {/* Day header */}
              <div style={{
                padding: '8px 10px 6px',
                borderBottom: dayAssignments.length > 0 ? `1px solid ${TH.border}33` : 'none',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div>
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
                    color: isToday ? TH.amber : TH.muted,
                    textTransform: 'uppercase',
                  }}>
                    {dayLabel}
                  </span>
                  <span style={{
                    fontSize: 13, fontWeight: isToday ? 700 : 500,
                    color: isToday ? TH.text : TH.muted,
                    marginLeft: 6,
                  }}>
                    {parseInt(date.slice(8))}
                  </span>
                </div>
                {workerCount > 0 && (
                  <span style={{ fontSize: 9, color: TH.muted, background: TH.surf, padding: '2px 6px', borderRadius: 8 }}>
                    {workerCount}w
                  </span>
                )}
              </div>

              {/* Assignments */}
              <div style={{ padding: '6px 8px', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {dayAssignments.map(assign => {
                  const divColor = TH.divColors?.[assign.project?.division] || TH.amber
                  const assignedWorkers = (assign.scheduled_workers || [])
                    .map(wid => workerList.find(x => x.id === wid))
                    .filter(Boolean)
                  const unassigned = workerList.filter(w => !(assign.scheduled_workers || []).includes(w.id))

                  return (
                    <div key={assign.id} style={{
                      padding: '6px 8px',
                      borderRadius: 6,
                      borderLeft: `3px solid ${divColor}`,
                      background: divColor + '08',
                    }}>
                      {/* Project name + remove */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: assignedWorkers.length > 0 ? 5 : 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: TH.text }}>
                          {assign.project?.name || 'Project'}
                        </span>
                        <button
                          onClick={() => removeAssignment(assign.id)}
                          style={{ fontSize: 13, color: TH.faint, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}
                        >×</button>
                      </div>

                      {/* Worker chips */}
                      {assignedWorkers.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                          {assignedWorkers.map(w => (
                            <span key={w.id} style={{
                              display: 'inline-flex', alignItems: 'center', gap: 3,
                              fontSize: 9, padding: '2px 6px', borderRadius: 8,
                              background: TH.card, border: `1px solid ${TH.border}66`,
                              color: TH.text,
                            }}>
                              {w.name.split(' ')[0]}
                              <button
                                onClick={() => removeWorker(assign, w.id)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: TH.faint, fontSize: 10, padding: 0, lineHeight: 1 }}
                              >×</button>
                            </span>
                          ))}
                          {unassigned.length > 0 && (
                            <span style={{ position: 'relative', display: 'inline-block' }}>
                              <WorkerAddMenu workers={unassigned} onAdd={wid => addWorkerBack(assign, wid)} />
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {/* Add project — pushed to bottom */}
                <div style={{ marginTop: 'auto', paddingTop: dayAssignments.length > 0 ? 4 : 0 }}>
                  <select
                    value=""
                    onChange={e => { addAssignment(date, e.target.value); e.target.value = '' }}
                    style={{
                      width: '100%', fontSize: 10, padding: '5px 6px',
                      background: 'transparent', border: `1px dashed ${TH.border}55`,
                      borderRadius: 5, color: TH.muted, cursor: 'pointer',
                      fontFamily: 'inherit', appearance: 'none',
                    }}
                  >
                    <option value="">+ Add project</option>
                    {projectList.filter(p => p.status === 'active').map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function WorkerAddMenu({ workers, onAdd }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          fontSize: 9, padding: '2px 6px', borderRadius: 8,
          background: 'transparent', border: `1px dashed ${TH.border}55`,
          color: TH.muted, cursor: 'pointer', lineHeight: 1.4,
        }}
      >+</button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 10,
          background: TH.card, border: `1px solid ${TH.border}`, borderRadius: 6,
          padding: 3, minWidth: 110, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}>
          {workers.map(w => (
            <button
              key={w.id}
              onClick={() => { onAdd(w.id); setOpen(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '5px 8px', fontSize: 11, color: TH.text,
                background: 'none', border: 'none', cursor: 'pointer', borderRadius: 4,
              }}
              onMouseEnter={e => e.currentTarget.style.background = TH.surf}
              onMouseLeave={e => e.currentTarget.style.background = 'none'}
            >
              {w.name}
            </button>
          ))}
        </div>
      )}
    </>
  )
}

function getSunday(d) {
  const day = d.getDay()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day, 12)
}

function formatDate(dateStr) {
  const d = parseDate(dateStr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
