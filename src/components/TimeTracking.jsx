import { useState } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Select, Input, Btn } from './Atoms'
import { labor } from '../lib/db'

const SERVICE_ITEMS = ['Air Barrier', 'EPS Foam', 'Scratch Coat', 'Finish Coat', 'Trim & Detail']

export function TimeTracking({ projects = [], onLogged }) {
  const [projectId,    setProjectId]    = useState('')
  const [serviceItem,  setServiceItem]  = useState('Air Barrier')
  const [hours,        setHours]        = useState('')
  const [sqftDone,     setSqftDone]     = useState('')
  const [crewSize,     setCrewSize]     = useState('')
  const [notes,        setNotes]        = useState('')
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState(null)
  const [lastEntry,    setLastEntry]    = useState(null)

  const activeProjects = projects.filter(p => p.status === 'active')
  const canSave = projectId && hours && parseFloat(hours) > 0

  async function handleLog() {
    setSaving(true)
    setError(null)
    const { data, error: err } = await labor.create({
      project_id:   projectId,
      service_item: serviceItem,
      hours:        parseFloat(hours),
      sqft_done:    parseFloat(sqftDone) || 0,
      crew_size:    parseInt(crewSize) || null,
      notes:        notes.trim() || null,
      logged_at:    new Date().toISOString(),
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    setLastEntry(data)
    setHours('')
    setSqftDone('')
    setNotes('')
    onLogged?.()
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: 640 }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0, marginBottom: 4 }}>Time Tracking</h1>
      <div style={{ fontSize: 13, color: TH.muted, marginBottom: 28 }}>Log crew hours against a job and service item</div>

      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Select
            label="Job"
            value={projectId}
            onChange={e => setProjectId(e.target.value)}
            options={[
              { value: '', label: 'Select active job…' },
              ...activeProjects.map(p => ({ value: p.id, label: `${p.name}` }))
            ]}
          />
          <Select
            label="Service Item"
            value={serviceItem}
            onChange={e => setServiceItem(e.target.value)}
            options={SERVICE_ITEMS}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <Input
              label="Hours"
              type="number"
              value={hours}
              onChange={e => setHours(e.target.value)}
              placeholder="7.5"
            />
            <Input
              label="Sqft Completed"
              type="number"
              value={sqftDone}
              onChange={e => setSqftDone(e.target.value)}
              placeholder="0"
            />
            <Input
              label="Crew Size"
              type="number"
              value={crewSize}
              onChange={e => setCrewSize(e.target.value)}
              placeholder="6"
            />
          </div>
          <Input
            label="Notes (optional)"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. Weather delay, scaffolding issue..."
          />
        </div>

        {error && (
          <div style={{ background: TH.redLo, border: `1px solid ${TH.red}44`, borderRadius: 5, padding: '10px 12px', marginTop: 14, fontSize: 12, color: TH.red }}>
            {error}
          </div>
        )}

        {lastEntry && (
          <div style={{ background: TH.greenLo, border: `1px solid ${TH.green}44`, borderRadius: 5, padding: '10px 12px', marginTop: 14, fontSize: 12, color: TH.green }}>
            ✓ Entry logged — {lastEntry.hours}h on {lastEntry.service_item}
          </div>
        )}

        <Btn
          onClick={handleLog}
          disabled={!canSave || saving}
          style={{ width: '100%', marginTop: 18 }}
        >
          {saving ? 'Logging…' : 'Log Time Entry'}
        </Btn>
      </Card>

      {activeProjects.length === 0 && (
        <Card style={{ textAlign: 'center', padding: 32 }}>
          <div style={{ fontSize: 14, color: TH.muted }}>No active projects. Create a takeoff first.</div>
        </Card>
      )}
    </div>
  )
}
