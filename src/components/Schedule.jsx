import { useState, useEffect } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Select, Btn, Badge } from './Atoms'
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

  // Get Monday of current week view
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

    // Index schedule by date
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
    const next = (assign.scheduled_workers || []).filter(id => id !== workerId)
    updateWorkers(assign.id, next)
  }

  function addWorkerBack(assign, workerId) {
    const next = [...(assign.scheduled_workers || []), workerId]
    updateWorkers(assign.id, next)
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
    await schedules.copyWeek(
      companyId,
      toDateStr(prevWeek),
      toDateStr(weekStart)
    )
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

  return (
    <div style={{ padding: '24px 20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 20, color: TH.text }}>Weekly Schedule</h2>
          <div style={{ fontSize: 13, color: TH.muted }}>
            {formatDate(weekDates[0])} — {formatDate(weekDates[6])}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn variant="ghost" onClick={() => setWeekOffset(o => o - 1)} disabled={saving}>← Prev</Btn>
          <Btn variant="ghost" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0 || saving}>This Week</Btn>
          <Btn variant="ghost" onClick={() => setWeekOffset(o => o + 1)} disabled={saving}>Next →</Btn>
          <Btn onClick={copyPreviousWeek} disabled={saving}>
            {saving ? 'Copying…' : 'Copy Last Week'}
          </Btn>
        </div>
      </div>

      {/* Schedule grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8 }}>
        {DAYS.map((dayLabel, i) => {
          const date = weekDates[i]
          const dayAssignments = scheduleData[date] || []
          const isToday = date === todayStr

          return (
            <Card
              key={date}
              style={{
                padding: 12,
                minHeight: 200,
                borderColor: isToday ? TH.amber : TH.border,
                background: isToday ? TH.amber + '08' : TH.card,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 600, color: isToday ? TH.amber : TH.muted, textTransform: 'uppercase', marginBottom: 8 }}>
                {dayLabel} {date.slice(5)}
              </div>

              {/* Existing assignments */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                {dayAssignments.map(assign => (
                  <div
                    key={assign.id}
                    style={{
                      padding: 8,
                      background: TH.surf,
                      borderRadius: 6,
                      border: `1px solid ${TH.border}`,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <Badge label={assign.project?.name || 'Project'} color={TH.divColors?.[assign.project?.division] || TH.amber} />
                      <button
                        onClick={() => removeAssignment(assign.id)}
                        style={{ fontSize: 16, color: TH.faint, background: 'none', border: 'none', cursor: 'pointer' }}
                      >
                        ×
                      </button>
                    </div>

                    {/* Assigned workers as chips */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {(assign.scheduled_workers || []).map(wid => {
                        const w = workerList.find(x => x.id === wid)
                        if (!w) return null
                        return (
                          <span key={wid} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            fontSize: 10, padding: '3px 8px', borderRadius: 10,
                            background: TH.amber + '22', color: TH.amber, fontWeight: 500,
                          }}>
                            {w.name.split(' ')[0]}
                            <button
                              onClick={() => removeWorker(assign, wid)}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: TH.amber, fontSize: 12, padding: 0, lineHeight: 1,
                              }}
                            >×</button>
                          </span>
                        )
                      })}
                      {/* Show add-back button if any workers are unassigned */}
                      {workerList.filter(w => !(assign.scheduled_workers || []).includes(w.id)).length > 0 && (
                        <span style={{ position: 'relative', display: 'inline-block' }}>
                          <WorkerAddMenu
                            workers={workerList.filter(w => !(assign.scheduled_workers || []).includes(w.id))}
                            onAdd={wid => addWorkerBack(assign, wid)}
                          />
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Add new assignment */}
              <Select
                value=""
                onChange={e => {
                  addAssignment(date, e.target.value)
                  e.target.value = ''
                }}
                options={[
                  { value: '', label: '+ Add project…' },
                  ...projectList
                    .filter(p => p.status === 'active')
                    .map(p => ({ value: p.id, label: p.name })),
                ]}
                style={{ fontSize: 12 }}
              />
            </Card>
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
          fontSize: 10, padding: '3px 8px', borderRadius: 10,
          background: 'transparent', border: `1px dashed ${TH.border}`,
          color: TH.muted, cursor: 'pointer',
        }}
      >+</button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 10,
          background: TH.card, border: `1px solid ${TH.border}`, borderRadius: 6,
          padding: 4, minWidth: 120, boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {workers.map(w => (
            <button
              key={w.id}
              onClick={() => { onAdd(w.id); setOpen(false) }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 8px', fontSize: 11, color: TH.text,
                background: 'none', border: 'none', cursor: 'pointer',
                borderRadius: 4,
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
