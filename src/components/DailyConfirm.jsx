import { useState, useEffect } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Select, Btn, Badge } from './Atoms'
import { schedules, labor, workers } from '../lib/db'
import { SCOPE_ITEMS } from './BlueprintCanvas'

export function DailyConfirm({ companyId, onConfirmed }) {
  const [selectedDate, setSelectedDate] = useState(() => {
    const today = new Date()
    return today.toISOString().split('T')[0]
  })
  const [schedule, setSchedule] = useState([])
  const [workerList, setWorkerList] = useState([])
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadData()
  }, [companyId, selectedDate])

  async function loadData() {
    setLoading(true)
    const [schedRes, workerRes, laborRes] = await Promise.all([
      schedules.getByDate(companyId, selectedDate),
      workers.list(companyId),
      labor.listByDateRange(companyId, selectedDate, selectedDate),
    ])

    if (workerRes.data) setWorkerList(workerRes.data)

    // Build entries from schedule + existing labor entries
    const scheduledWorkers = new Map()
    schedRes.data?.forEach(s => {
      s.scheduled_workers?.forEach(wid => {
        if (!scheduledWorkers.has(wid)) {
          scheduledWorkers.set(wid, {
            worker_id: wid,
            project_id: s.project_id,
            project_name: s.project?.name,
            division: s.project?.division,
          })
        }
      })
    })

    // Check for existing confirmed entries
    const existingEntries = laborRes.data || []
    const existingByWorker = new Map(existingEntries.map(e => [e.worker_id, e]))

    // Build draft entries
    const draftEntries = []
    
    // From schedule
    scheduledWorkers.forEach((info, wid) => {
      const existing = existingByWorker.get(wid)
      draftEntries.push({
        id: existing?.id,
        worker_id: wid,
        worker_name: workerRes.data?.find(w => w.id === wid)?.name || 'Unknown',
        project_id: info.project_id,
        project_name: info.project_name,
        division: info.division,
        hours: existing?.hours ?? 8,
        service_item: existing?.service_item || '',
        status: existing?.status || 'draft',
        confirmed: !!existing,
      })
    })

    // Add extra workers (sub/fill-in) not on schedule
    const scheduledIds = new Set(scheduledWorkers.keys())
    existingEntries.forEach(e => {
      if (!scheduledIds.has(e.worker_id)) {
        draftEntries.push({
          id: e.id,
          worker_id: e.worker_id,
          worker_name: e.worker?.name || workerRes.data?.find(w => w.id === e.worker_id)?.name || 'Unknown',
          project_id: e.project_id,
          project_name: e.project?.name || 'Unknown',
          hours: e.hours,
          service_item: e.service_item,
          status: e.status,
          confirmed: true,
        })
      }
    })

    setSchedule(schedRes.data || [])
    setEntries(draftEntries)
    setLoading(false)
  }

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
      project_id: schedule[0]?.project_id || '',
      project_name: schedule[0]?.project?.name || '',
      hours: 8,
      service_item: '',
      status: 'draft',
      confirmed: false,
      isExtra: true,
    }])
  }

  async function confirmDay() {
    setSaving(true)
    
    const toSave = entries
      .filter(e => e.worker_id && e.hours > 0)
      .map(e => ({
        id: e.id,
        company_id: companyId,
        project_id: e.project_id,
        worker_id: e.worker_id,
        work_date: selectedDate,
        hours: parseFloat(e.hours),
        service_item: e.service_item,
        status: 'confirmed',
      }))

    // Batch upsert
    const { error } = await labor.createBatch(toSave)
    
    if (!error && onConfirmed) onConfirmed()
    setSaving(false)
  }

  const totalHours = entries.reduce((s, e) => s + (parseFloat(e.hours) || 0), 0)
  const allHaveServiceItem = entries.every(e => e.service_item)

  if (loading) return <div style={{ padding: 40, textAlign: 'center' }}>Loading…</div>

  return (
    <div style={{ padding: '24px 20px', maxWidth: 700 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 20, color: TH.text }}>
            Confirm Day's Work
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: TH.muted }}>
            Review hours and assign service items for {formatDate(selectedDate)}
          </p>
        </div>
        <Input
          type="date"
          value={selectedDate}
          onChange={e => setSelectedDate(e.target.value)}
          style={{ width: 'auto' }}
        />
      </div>

      {/* Worker entries */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
        {entries.length === 0 && schedule.length === 0 ? (
          <Card style={{ textAlign: 'center', padding: 40, color: TH.muted }}>
            No crew scheduled for this date.<br />
            Set up the schedule first, or add workers manually below.
          </Card>
        ) : (
          entries.map((entry, i) => (
            <Card key={`${entry.worker_id}-${i}`} style={{ padding: '14px 16px' }}>
              <div style={{ display: 'grid', gap: 12, alignItems: 'center' }}>
                {/* Row 1: Worker + Project */}
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  {entry.isExtra ? (
                    <Select
                      label="Worker"
                      value={entry.worker_id}
                      onChange={e => {
                        const wid = e.target.value
                        const w = workerList.find(x => x.id === wid)
                        updateEntry(i, { worker_id: wid, worker_name: w?.name || '' })
                      }}
                      options={workerList.map(w => ({ value: w.id, label: w.name }))}
                      style={{ minWidth: 150 }}
                    />
                  ) : (
                    <div style={{ fontWeight: 600, color: TH.text, minWidth: 150 }}>
                      {entry.worker_name}
                    </div>
                  )}
                  
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 11, color: TH.muted, marginBottom: 4 }}>Project</div>
                    <Badge 
                      label={entry.project_name || 'Unknown'} 
                      color={TH.divColors?.[entry.division] || TH.amber} 
                    />
                  </div>
                </div>

                {/* Row 2: Hours + Service Item */}
                <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr auto', gap: 12, alignItems: 'end' }}>
                  <Input
                    label="Hours"
                    type="number"
                    step="0.5"
                    value={entry.hours}
                    onChange={e => updateEntry(i, { hours: e.target.value })}
                  />
                  
                  <Select
                    label="Service Item"
                    value={entry.service_item}
                    onChange={e => updateEntry(i, { service_item: e.target.value })}
                    options={SCOPE_ITEMS.map(s => ({ value: s.name, label: `${s.name} (${s.unit})` }))}
                  />

                  {(entry.isExtra || entries.length > 1) && (
                    <Btn variant="ghost" onClick={() => removeEntry(i)} style={{ height: 38 }}>
                      Remove
                    </Btn>
                  )}
                </div>
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <Btn variant="ghost" onClick={addExtraWorker}>
          + Add Worker
        </Btn>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: TH.muted }}>Total Hours</div>
            <div style={{ fontSize: 20, fontWeight: 600, color: TH.text }}>{totalHours.toFixed(1)}</div>
          </div>
          
          <Btn 
            onClick={confirmDay} 
            disabled={saving || entries.length === 0 || !allHaveServiceItem}
          >
            {saving ? 'Saving…' : 'Confirm Day'}
          </Btn>
        </div>
      </div>

      {!allHaveServiceItem && entries.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 12, color: TH.amber }}>
          ⚠ Assign a service item to all workers before confirming
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
