import { useState } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Btn } from './Atoms'
import { companies } from '../lib/db'

export function Settings({ company, onUpdated }) {
  const [name,      setName]      = useState(company?.name || '')
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [error,     setError]     = useState(null)

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    const { data, error: err } = await companies.update(company.id, { name: name.trim() })
    setSaving(false)
    if (err) { setError(err.message); return }
    setSaved(true)
    onUpdated?.(data)
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: 560 }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0, marginBottom: 4 }}>Settings</h1>
      <div style={{ fontSize: 13, color: TH.muted, marginBottom: 28 }}>Company configuration and integrations</div>

      <Card style={{ marginBottom: 14 }}>
        <Label>Company Details</Label>
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input
            label="Company Name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="L&A Exterior Systems"
          />
          {error && (
            <div style={{ fontSize: 12, color: TH.red }}>{error}</div>
          )}
          {saved && (
            <div style={{ fontSize: 12, color: TH.green }}>✓ Saved</div>
          )}
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save Changes'}
          </Btn>
        </form>
      </Card>

      <Card>
        <Label>Integrations</Label>
        <div style={{ fontSize: 13, color: TH.muted, marginBottom: 16 }}>
          Connect your tools to start syncing data automatically.
        </div>
        {[
          { name: 'QuickBooks Online', desc: 'Sync bills, estimates, and time sessions', icon: '🟢', status: 'coming_soon' },
          { name: 'PlanSwift', desc: 'Import takeoff measurements via CSV', icon: '📐', status: 'coming_soon' },
          { name: 'ConstructionClock', desc: 'Sync crew time tracking', icon: '⏱', status: 'coming_soon' },
          { name: 'Buildertrend', desc: 'Sync projects and scheduling', icon: '🏗', status: 'coming_soon' },
        ].map(i => (
          <div key={i.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${TH.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: 20 }}>{i.icon}</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{i.name}</div>
                <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>{i.desc}</div>
              </div>
            </div>
            <Btn variant="ghost" disabled style={{ fontSize: 11, padding: '6px 12px' }}>
              Coming Soon
            </Btn>
          </div>
        ))}
      </Card>
    </div>
  )
}
