import { useState, useEffect, useMemo } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Select, Btn, Badge } from './Atoms'
import { useCrewSchedule, useLaborEntry, useConfirmedByDate, useWeekOverview } from '../hooks/useTimeTracking'
import { useIsMobile } from '../hooks/useIsMobile'
import { SCOPE_ITEMS } from './BlueprintCanvas'
import { toDateStr } from '../lib/calc'

export function DailyConfirm({ companyId, onConfirmed, onNavigate }) {
  const isMobile = useIsMobile()
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const { schedules, workers: workerList, loading, error, refetch: loadSchedule } = useCrewSchedule(companyId, selectedDate)
  const { saving, error: saveError, submit } = useLaborEntry()
  const { entries: confirmedEntries, refetch: refetchConfirmed } = useConfirmedByDate(companyId, selectedDate)
  const { days: weekDays, refetch: refetchWeek } = useWeekOverview(companyId, selectedDate)
  const [confirmedProjects, setConfirmedProjects] = useState(new Set())

  // Build draft entries from schedules + confirmed, deduplicated per worker+project
  const draftEntries = useMemo(() => {
    const result = []
    const seen = new Set()

    confirmedEntries.forEach(e => {
      const key = `${e.worker_id}:${e.project_id}`
      if (seen.has(key)) return
      seen.add(key)
      result.push({
        id: e.id,
        worker_id: e.worker_id,
        worker_name: workerList.find(w => w.id === e.worker_id)?.name || 'Unknown',
        project_id: e.project_id,
        project_name: e.project?.name || null,
        division: e.project?.division || null,
        hours: e.hours,
        service_item: e.service_item || '',
        status: e.status,
        confirmed: true,
      })
    })

    for (const sched of schedules) {
      for (const wid of sched.scheduled_workers || []) {
        const key = `${wid}:${sched.project_id}`
        if (seen.has(key)) continue
        seen.add(key)
        result.push({
          worker_id: wid,
          worker_name: workerList.find(w => w.id === wid)?.name || 'Unknown',
          project_id: sched.project_id,
          project_name: sched.project?.name,
          division: sched.project?.division,
          hours: 8,
          service_item: '',
          status: 'draft',
          confirmed: false,
        })
      }
    }

    return result
  }, [schedules, confirmedEntries, workerList])

  const [entries, setEntries] = useState([])

  useEffect(() => {
    setEntries(draftEntries)
    setConfirmedProjects(new Set())
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

  function addExtraWorkerToProject(projectId, projectName, division) {
    setEntries(prev => [...prev, {
      worker_id: '',
      worker_name: '',
      project_id: projectId || '',
      project_name: projectName || '',
      division: division || null,
      hours: 8,
      service_item: '',
      status: 'draft',
      confirmed: false,
      isExtra: true,
    }])
  }

  async function confirmProject(projectId) {
    const projectEntries = entries
      .filter(e => e.project_id === projectId && e.worker_id && e.hours > 0)
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

    if (projectEntries.length === 0) return

    const { error: submitError } = await submit(projectEntries)

    if (!submitError) {
      setConfirmedProjects(prev => new Set([...prev, projectId]))
      refetchConfirmed()
      refetchWeek()
      onConfirmed?.()
    }
  }

  const hasNoSchedule = schedules.length === 0 && confirmedEntries.length === 0
  const hasNoCrew = workerList.length === 0

  // Group entries by project
  const projectGroups = useMemo(() => {
    const groups = new Map()
    entries.forEach((e, i) => {
      const pid = e.project_id || '_none'
      if (!groups.has(pid)) {
        groups.set(pid, { project_id: e.project_id, project_name: e.project_name, division: e.division, entries: [] })
      }
      groups.get(pid).entries.push({ ...e, _index: i })
    })
    return [...groups.values()]
  }, [entries])

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}>Loading…</div>

  return (
    <div style={{ padding: isMobile ? '16px 14px' : '24px 20px', maxWidth: 700 }}>
      {/* Header */}
      <h2 style={{ margin: '0 0 4px', fontSize: isMobile ? 18 : 20, color: TH.text }}>
        Confirm Day's Work
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: isMobile ? 12 : 13, color: TH.muted }}>
        Select a day to review and confirm hours
      </p>

      {/* ── Week overview bar ── */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6,
        marginBottom: 20,
      }}>
        {weekDays.map(d => {
          const isSelected = d.date === selectedDate
          const statusColor = d.isConfirmed ? TH.green : d.hasSchedule ? TH.amber : 'transparent'
          return (
            <button
              key={d.date}
              onClick={() => { setSelectedDate(d.date); setConfirmedProjects(new Set()) }}
              style={{
                padding: isMobile ? '8px 4px' : '10px 6px',
                borderRadius: 8,
                border: isSelected ? `2px solid ${TH.amber}` : `1px solid ${d.hasSchedule ? TH.border : 'transparent'}`,
                background: isSelected ? TH.amber + '15' : d.hasSchedule ? TH.card : 'transparent',
                cursor: d.hasSchedule ? 'pointer' : 'default',
                textAlign: 'center',
                opacity: d.hasSchedule || d.isToday ? 1 : 0.4,
              }}
            >
              <div style={{ fontSize: 10, fontWeight: 600, color: d.isToday ? TH.amber : isSelected ? TH.text : TH.muted, marginBottom: 4 }}>
                {d.label}
              </div>
              <div style={{ fontSize: isMobile ? 12 : 13, fontWeight: isSelected ? 700 : 500, color: isSelected ? TH.text : TH.muted }}>
                {d.shortDate.split('-')[1]}
              </div>
              {d.hasSchedule && (
                <div style={{ marginTop: 6, fontSize: 9, color: d.isConfirmed ? TH.green : TH.muted, lineHeight: 1.3 }}>
                  {d.scheduledWorkers}w · {d.projects.length}j
                </div>
              )}
              <div style={{ width: 6, height: 6, borderRadius: 3, background: statusColor, margin: '4px auto 0' }} />
            </button>
          )
        })}
      </div>

      {/* Selected day label */}
      <div style={{ fontSize: 14, fontWeight: 600, color: TH.text, marginBottom: 14 }}>
        {formatDate(selectedDate)}
      </div>

      {/* Save error */}
      {saveError && (
        <div style={{
          background: '#fef2f2', border: `1px solid ${TH.red}44`,
          borderRadius: 6, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: TH.red,
        }}>
          Failed to save: {saveError}
        </div>
      )}

      {/* ── Project groups ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {entries.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: isMobile ? 28 : 40 }}>
            {hasNoCrew ? (
              <div>
                <div style={{ fontSize: 32, marginBottom: 12 }}>👷</div>
                <div style={{ fontSize: 15, fontWeight: 500, color: TH.text, marginBottom: 6 }}>No crew members yet</div>
                <div style={{ fontSize: 13, color: TH.muted, marginBottom: 16, lineHeight: 1.6 }}>
                  Add your workers first, then create a schedule to auto-populate this page.
                </div>
                {onNavigate && <Btn onClick={() => onNavigate('workers')} style={{ fontSize: 13 }}>Go to Crew</Btn>}
              </div>
            ) : hasNoSchedule ? (
              <div>
                <div style={{ fontSize: 13, color: TH.muted, marginBottom: 12, lineHeight: 1.6 }}>
                  No work scheduled for this day. Pick a highlighted day above, or add workers manually.
                </div>
                <Btn variant="ghost" onClick={() => addExtraWorkerToProject('', '', null)} style={{ fontSize: 13 }}>+ Add Worker Manually</Btn>
              </div>
            ) : (
              <div style={{ color: TH.muted }}>No entries for this date.</div>
            )}
          </Card>
        ) : (
          projectGroups.map(group => {
            const groupEntries = group.entries
            const groupHours = groupEntries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0)
            const groupAllServiceItems = groupEntries.every(e => e.service_item)
            const groupAllConfirmed = groupEntries.every(e => e.confirmed)
            const groupJustConfirmed = confirmedProjects.has(group.project_id)
            const divColor = TH.divColors?.[group.division] || TH.amber

            return (
              <div key={group.project_id || '_none'} style={{
                border: `1px solid ${TH.border}`,
                borderRadius: 10,
                overflow: 'hidden',
              }}>
                {/* Project header */}
                <div style={{
                  padding: '12px 16px',
                  background: divColor + '12',
                  borderBottom: `1px solid ${TH.border}`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Badge label={group.project_name || 'Unknown Project'} color={divColor} />
                    <span style={{ fontSize: 12, color: TH.muted }}>
                      {groupEntries.length} {groupEntries.length === 1 ? 'worker' : 'workers'}
                    </span>
                  </div>
                  {(groupAllConfirmed || groupJustConfirmed) && (
                    <span style={{ fontSize: 11, color: TH.green, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                      ✓ Confirmed
                    </span>
                  )}
                </div>

                {/* Worker entries */}
                <div style={{ padding: isMobile ? '10px 12px' : '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {groupEntries.map(entry => {
                    const i = entry._index
                    return (
                      <div key={`${entry.worker_id}-${i}`} style={{
                        padding: '10px 12px',
                        background: TH.surf,
                        borderRadius: 6,
                        border: `1px solid ${TH.border}`,
                      }}>
                        <div style={{ display: 'grid', gap: 10, alignItems: 'center' }}>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                            {entry.isExtra ? (
                              <Select
                                label="Worker"
                                value={entry.worker_id}
                                onChange={e => {
                                  const wid = e.target.value
                                  const w = workerList.find(x => x.id === wid)
                                  updateEntry(i, { worker_id: wid, worker_name: w?.name || '' })
                                }}
                                options={[{ value: '', label: 'Select worker…' }, ...workerList.map(w => ({ value: w.id, label: w.name }))]}
                                style={{ minWidth: isMobile ? 120 : 150 }}
                              />
                            ) : (
                              <div style={{ fontWeight: 600, color: TH.text, flex: 1 }}>{entry.worker_name}</div>
                            )}
                            {groupEntries.length > 1 && (
                              <button
                                onClick={() => removeEntry(i)}
                                style={{ fontSize: 14, color: TH.faint, background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px' }}
                              >×</button>
                            )}
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '90px 1fr', gap: 10 }}>
                            <Input label="Hours" type="number" step="0.5" min="0" value={entry.hours} onChange={e => updateEntry(i, { hours: e.target.value })} />
                            <Select
                              label={<span>Service Item <span style={{ color: TH.red, fontWeight: 400 }}>*</span></span>}
                              value={entry.service_item}
                              onChange={e => updateEntry(i, { service_item: e.target.value })}
                              options={[{ value: '', label: 'Select…' }, ...SCOPE_ITEMS.map(s => ({ value: s.id, label: isMobile ? s.id : `${s.id} (${s.unit})` }))]}
                            />
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>

                {/* Project footer: add worker + totals + confirm */}
                <div style={{
                  padding: '10px 16px',
                  borderTop: `1px solid ${TH.border}`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  flexWrap: 'wrap', gap: 10,
                }}>
                  <button
                    onClick={() => addExtraWorkerToProject(group.project_id, group.project_name, group.division)}
                    style={{ fontSize: 12, color: TH.muted, background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    + Add Worker
                  </button>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: TH.muted }}>Total</div>
                      <div style={{ fontSize: 16, fontWeight: 600, color: TH.text }}>{groupHours.toFixed(1)}h</div>
                    </div>
                    <Btn
                      onClick={() => confirmProject(group.project_id)}
                      disabled={saving || !groupAllServiceItems || groupEntries.length === 0}
                      style={{ fontSize: 12, padding: '8px 16px' }}
                    >
                      {saving ? 'Saving…' : groupJustConfirmed ? '✓ Saved' : groupAllConfirmed ? 'Update' : 'Confirm'}
                    </Btn>
                  </div>
                </div>

                {!groupAllServiceItems && (
                  <div style={{ padding: '0 16px 10px', fontSize: 11, color: TH.amber }}>
                    Assign service items to all workers to confirm
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d, 12)
  const today = new Date()
  const isToday = dt.toDateString() === today.toDateString()
  return isToday ? 'Today' : dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}
