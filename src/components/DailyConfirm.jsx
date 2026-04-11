import { useState, useEffect, useMemo } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Select, Btn, Badge } from './Atoms'
import { useCrewSchedule, useLaborEntry, useConfirmedByDate } from '../hooks/useTimeTracking'
import { useIsMobile } from '../hooks/useIsMobile'
import { SCOPE_ITEMS } from './BlueprintCanvas'

export function DailyConfirm({ companyId, onConfirmed, onNavigate }) {
  const isMobile = useIsMobile()
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date()
    return today.toISOString().split('T')[0]
  })
  const { schedule: schedData, workers: workerList, loading, error, refetch: loadSchedule } = useCrewSchedule(companyId, selectedDate)
  const { saving, error: saveError, submit } = useLaborEntry()
  const { entries: confirmedEntries, refetch: refetchConfirmed } = useConfirmedByDate(companyId, selectedDate)
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

      {/* Success banner */}
      {confirmed && (
        <div style={{
          background: TH.greenLo || '#dcfce7', border: `1px solid ${TH.green}44`,
          borderRadius: 6, padding: '12px 16px', marginBottom: 16,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div style={{ fontSize: 13, color: TH.green, fontWeight: 500 }}>
            Day confirmed — {entries.filter(e => e.worker_id).length} entries, {totalHours.toFixed(1)} total hours
          </div>
          <button
            onClick={() => setConfirmed(false)}
            style={{ background: 'none', border: 'none', color: TH.green, cursor: 'pointer', fontSize: 16, padding: 0 }}
          >
            ×
          </button>
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
              {saving ? 'Saving…' : 'Confirm Day'}
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
