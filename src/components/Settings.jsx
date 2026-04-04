import { useState, useEffect } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Btn } from './Atoms'
import { companies, integrations } from '../lib/db'
import { supabase } from '../lib/supabase'
import { SCOPE_ITEMS } from './BlueprintCanvas'

export function Settings({ company, onUpdated }) {
  const [name,      setName]      = useState(company?.name || '')
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [error,     setError]     = useState(null)
  const [qboStatus, setQboStatus] = useState('loading')

  // ── Pricing rates ────────────────────────────────────────────────────────────
  const existingRates = company?.metadata?.rates || {}
  const [rates, setRates] = useState(
    Object.fromEntries(SCOPE_ITEMS.map(s => [s.id, existingRates[s.id] ?? s.defaultRate]))
  )
  const [ratesSaved, setRatesSaved] = useState(false)

  async function handleSaveRates() {
    setSaving(true)
    await companies.update(company.id, {
      metadata: { ...(company.metadata || {}), rates }
    })
    setSaving(false)
    setRatesSaved(true)
    setTimeout(() => setRatesSaved(false), 3000)
    onUpdated?.()
  }

  useEffect(() => {
    if (!company?.id) return
    checkQboStatus()
    const params = new URLSearchParams(window.location.search)
    if (params.get('qbo') === 'connected') {
      setQboStatus('connected')
      window.history.replaceState({}, '', window.location.pathname)
    }
    if (params.get('qbo') === 'error') {
      setError('QuickBooks connection failed. Please try again.')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [company?.id])

  async function checkQboStatus() {
    const { data } = await integrations.list(company.id)
    setQboStatus(data?.find(i => i.provider === 'qbo') ? 'connected' : 'disconnected')
  }

  async function handleConnectQBO() {
    const { data, error: err } = await supabase.functions.invoke('qbo-auth', {
      body: { company_id: company.id }
    })
    if (err || !data?.url) { setError('Failed to start QuickBooks connection.'); return }
    window.location.href = data.url
  }

  async function handleDisconnectQBO() {
    const { data } = await integrations.list(company.id)
    const qbo = data?.find(i => i.provider === 'qbo')
    if (qbo) { await integrations.delete(qbo.id); setQboStatus('disconnected') }
  }

  async function handleSyncQBO() {
    const { data } = await integrations.list(company.id)
    const qbo = data?.find(i => i.provider === 'qbo')
    if (!qbo?.metadata?.realm_id) return
    setSaving(true)
    await supabase.functions.invoke('qbo-sync', {
      body: { company_id: company.id, realm_id: qbo.metadata.realm_id }
    })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true); setError(null); setSaved(false)
    const { data, error: err } = await companies.update(company.id, { name: name.trim() })
    setSaving(false)
    if (err) { setError(err.message); return }
    setSaved(true); onUpdated?.(data)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: 560 }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0, marginBottom: 4 }}>Settings</h1>
      <div style={{ fontSize: 13, color: TH.muted, marginBottom: 28 }}>Company configuration and integrations</div>

      {/* Company details */}
      <Card style={{ marginBottom: 14 }}>
        <Label>Company</Label>
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input label="Company Name" value={name} onChange={e => setName(e.target.value)} placeholder="L&A Exterior Systems" />
          {error && <div style={{ fontSize: 12, color: TH.red }}>{error}</div>}
          {saved && <div style={{ fontSize: 12, color: TH.green }}>✓ Saved</div>}
          <Btn type="submit" disabled={saving || !name.trim()}>{saving ? 'Saving…' : 'Save'}</Btn>
        </form>
      </Card>

      {/* Pricing rates */}
      <Card style={{ marginBottom: 14 }}>
        <Label>Pricing Rates</Label>
        <div style={{ fontSize: 12, color: TH.muted, marginBottom: 14 }}>
          Unit prices used to generate estimates from blueprint measurements.
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${TH.border}` }}>
              <th style={{ textAlign: 'left', color: TH.muted, fontWeight: 600, padding: '6px 0', fontSize: 11 }}>Scope Item</th>
              <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '6px 0', fontSize: 11 }}>Unit</th>
              <th style={{ textAlign: 'right', color: TH.muted, fontWeight: 600, padding: '6px 8px', fontSize: 11 }}>Rate ($/unit)</th>
            </tr>
          </thead>
          <tbody>
            {SCOPE_ITEMS.map(s => (
              <tr key={s.id} style={{ borderBottom: `1px solid ${TH.border}22` }}>
                <td style={{ padding: '8px 0', color: TH.text, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: s.color, flexShrink: 0 }} />
                  {s.id}
                </td>
                <td style={{ textAlign: 'right', padding: '8px 0', color: TH.muted, fontSize: 12 }}>{s.unit}</td>
                <td style={{ textAlign: 'right', padding: '8px 0 8px 8px' }}>
                  <input
                    type="number"
                    min="0"
                    step="0.25"
                    value={rates[s.id]}
                    onChange={e => setRates(r => ({ ...r, [s.id]: parseFloat(e.target.value) || 0 }))}
                    style={{
                      width: 80, textAlign: 'right',
                      background: TH.surf, border: `1px solid ${TH.border}`,
                      borderRadius: 5, padding: '5px 8px',
                      color: TH.text, fontSize: 13, fontFamily: 'inherit',
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
          <Btn onClick={handleSaveRates} disabled={saving} style={{ fontSize: 12 }}>
            {saving ? 'Saving…' : 'Save Rates'}
          </Btn>
          {ratesSaved && <span style={{ fontSize: 12, color: TH.green }}>✓ Rates saved</span>}
        </div>
      </Card>

      {/* QBO integration */}
      <Card>
        <Label>Integrations</Label>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: '#2CA01C',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 700, color: '#fff', flexShrink: 0,
            }}>Q</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>QuickBooks Online</div>
              <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>
                {qboStatus === 'connected' ? 'Syncing bills, estimates, and time entries' : 'Connect to sync job costs automatically'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {qboStatus === 'connected' ? (
              <>
                <Btn variant="ghost" onClick={handleSyncQBO} disabled={saving} style={{ fontSize: 11, padding: '6px 12px' }}>
                  {saving ? 'Syncing…' : saved ? '✓ Synced' : 'Sync Now'}
                </Btn>
                <Btn variant="ghost" onClick={handleDisconnectQBO} style={{ fontSize: 11, padding: '6px 12px', color: TH.red, borderColor: TH.red + '44' }}>
                  Disconnect
                </Btn>
              </>
            ) : qboStatus === 'disconnected' ? (
              <Btn onClick={handleConnectQBO} style={{ fontSize: 11, padding: '6px 14px', background: '#2CA01C', color: '#fff' }}>
                Connect QBO
              </Btn>
            ) : (
              <div style={{ fontSize: 11, color: TH.muted }}>Loading…</div>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}
