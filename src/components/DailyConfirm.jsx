import { useState, useEffect, useMemo } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Select, Btn, Badge } from './Atoms'
import { useCrewSchedule, useLaborEntry, useConfirmedByDate } from '../hooks/useTimeTracking'
import { useIsMobile } from '../hooks/useIsMobile'
import { SCOPE_ITEMS } from './BlueprintCanvas'

export function DailyConfirm({ companyId, onConfirmed, onNavigate }) {
  const isMobile = useIsMobile()
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const { schedules, workers: workerList, loading, error, refetch: loadSchedule } = useCrewSchedule(companyId, selectedDate)
  const { saving, error: saveError, submit } = useLaborEntry()
  const { entries: confirmedEntries, refetch: refetchConfirmed } = useConfirmedByDate(companyId, selectedDate)
  const [confirmed, setConfirmed] = useState(false)

  // Build draft entries from schedules + confirmed, deduplicated per worker+project
  const draftEntries = useMemo(() => {
    const result = []
    const seen = new Set() // track worker_id+project_id combos

    // Confirmed entries first (from DB) — deduplicate by worker+project
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

    // Then add scheduled workers not yet confirmed
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
    const firstSched = schedules[0]
    setEntries(prev => [...prev, {
      worker_id: '',
      worker_name: '',
      project_id: firstSched?.project_id || '',
      project_name: firstSched?.project?.name || '',
      division: firstSched?.project?.division || null,
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
      onConfirmed?.()
    }
  }

  const totalHours = entries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0)
  const allHaveServiceItem = entries.every(e => e.service_item)
  const allAlreadyConfirmed = entries.length > 0 && entries.every(e => e.confirmed)
  const hasNoSchedule = schedules.length === 0 && confirmedEntries.length === 0
  const hasNoCrew = workerList.length === 0

  // Group entries by project for display
  const projectGroups = useMemo(() => {
    const groups = new Map()
    entries.forEach((e, i) => {
      const pid = e.project_id || '_none'
      if (!groups.has(pid)) {
        groups.set(pid, {
          project_id: e.project_id,
          project_name: e.project_name,
          division: e.division,
          entries: [],
        })
      }
      groups.get(pid).entries.push({ ...e, _index: i })
    })
    return [...groups.values()]
  }, [entries])

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

      {/* Confirmed banner */}
      {(confirmed || allAlreadyConfirmed) && (
        <div style={{
          background: TH.greenLo || '#dcfce7', border: `1px solid ${TH.green}44`,
          borderRadius: 6, padding: '14px 18px', marginBottom: 20,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 20 }}>✓</div>
          <div>
            <div style={{ fontSize: 14, color: TH.green, fontWeight: 600 }}>
              {confirmed ? 'Day confirmed' : 'Already confirmed'}
            </div>
            <div style={{ fontSize: 12, color: TH.green, opacity: 0.8 }}>
              {entries.filter(e => e.worker_id).length} entries · {totalHours.toFixed(1)} total hours
              {allAlreadyConfirmed && !confirmed ? ' · Edit below and re-confirm if needed' : ''}
            </div>
          </div>
        </div>
      )}

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

      {/* Worker entries grouped by project */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 20 }}>
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
              <div style={{ color: TH.muted }}>No entries for this date.</div>
            )}
          </Card>
        ) : (
          projectGroups.map(group => (
            <div key={group.project_id || '_none'}>
              {/* Project header */}
              {projectGroups.length > 1 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  marginBottom: 8, paddingLeft: 4,
                }}>
                  <Badge
                    label={group.project_name || 'Unknown Project'}
                    color={TH.divColors?.[group.division] || TH.amber}
                  />
                  <span style={{ fontSize: 11, color: TH.muted }}>
                    {group.entries.length} {group.entries.length === 1 ? 'worker' : 'workers'}
                  </span>
                </div>
              )}

              {/* Single project — show project in each card normally */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {group.entries.map(entry => {
                  const i = entry._index
                  return (
                    <Card key={`${entry.worker_id}-${i}`} style={{
                      padding: isMobile ? '12px 14px' : '14px 16px',
                      borderLeft: projectGroups.length > 1
                        ? `3px solid ${TH.divColors?.[group.division] || TH.amber}`
                        : undefined,
                    }}>
                      <div style={{ display: 'grid', gap: isMobile ? 10 : 12, alignItems: 'center' }}>
                        {/* Row 1: Worker + Project */}
                        <div style={{ display: 'flex', gap: isMobile ? 8 : 12, flexWrap: 'wrap', alignItems: 'center' }}>
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

                          {/* Show project badge when there's only 1 project (no group header) */}
                          {projectGroups.length <= 1 && (
                            <div style={{ flex: 1, minWidth: isMobile ? 140 : 200 }}>
                              <div style={{ fontSize: isMobile ? 10 : 11, color: TH.muted, marginBottom: 4 }}>Project</div>
                              <Badge
                                label={entry.project_name || 'Unknown'}
                                color={TH.divColors?.[entry.division] || TH.amber}
                              />
                            </div>
                          )}

                          {entry.confirmed && (
                            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, background: TH.green + '22', color: TH.green, fontWeight: 600 }}>
                              Confirmed
                            </span>
                          )}
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
                  )
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Actions */}
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
              {saving ? 'Saving…' : allAlreadyConfirmed ? 'Update' : 'Confirm Day'}
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

function formatDate(dateStr) {
  const d = new Date(dateStr)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  return isToday ? 'Today' : d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}
