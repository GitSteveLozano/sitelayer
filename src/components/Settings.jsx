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
  const [qboInteg, setQboInteg]   = useState(null)
  const [syncResult, setSyncResult] = useState(null)

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
    const qbo = data?.find(i => i.provider === 'qbo')
    setQboInteg(qbo || null)
    setQboStatus(qbo ? 'connected' : 'disconnected')
  }

  const [useQboSandbox, setUseQboSandbox] = useState(company?.metadata?.qbo_sandbox ?? true)

  async function handleConnectQBO() {
    try {
      // Store sandbox preference first
      await companies.update(company.id, { 
        metadata: { ...(company.metadata || {}), qbo_sandbox: useQboSandbox } 
      })
      
      // Public function - no auth header needed
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/qbo-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: company.id, sandbox: useQboSandbox })
      })
      
      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: 'Unknown error' }))
        console.error('QBO auth error:', response.status, errData)
        setError(`Failed to start QuickBooks connection: ${errData.error || response.status}`)
        return
      }
      
      const data = await response.json()
      
      if (!data?.url) {
        setError('No OAuth URL returned from server')
        return
      }
      
      window.location.href = data.url
    } catch (e) {
      console.error('QBO connect exception:', e)
      setError(`Connection error: ${e.message}`)
    }
  }

  async function handleToggleSandbox() {
    const newVal = !useQboSandbox
    setUseQboSandbox(newVal)
    await companies.update(company.id, { 
      metadata: { ...(company.metadata || {}), qbo_sandbox: newVal } 
    })
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
    const { data: syncData } = await supabase.functions.invoke('qbo-sync', {
      body: { company_id: company.id, realm_id: qbo.metadata.realm_id }
    })
    setSyncResult(syncData?.results || null)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
    await checkQboStatus()
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
        
        {/* Sandbox toggle */}
        {qboStatus === 'disconnected' && (
          <div style={{ marginTop: 16, padding: 12, background: TH.surf, borderRadius: 6, border: `1px solid ${TH.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: TH.text }}>Sandbox Mode</div>
                <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>
                  {useQboSandbox ? 'Connect to QuickBooks Sandbox (test data)' : 'Connect to Live QuickBooks (real data)'}
                </div>
              </div>
              <button
                onClick={handleToggleSandbox}
                style={{
                  width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
                  background: useQboSandbox ? TH.amber : TH.surf,
                  position: 'relative', transition: 'background 0.2s',
                  boxShadow: `inset 0 0 0 1px ${TH.border}`,
                }}
              >
                <div style={{
                  width: 20, height: 20, borderRadius: 10, background: '#fff',
                  position: 'absolute', top: 2,
                  left: useQboSandbox ? 22 : 2,
                  transition: 'left 0.2s',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>
            {useQboSandbox && (
              <div style={{ marginTop: 10, fontSize: 11, color: TH.muted }}>
                💡 <a href="https://developer.intuit.com" target="_blank" style={{ color: TH.amber }}>Create free sandbox</a> at Intuit Developer
              </div>
            )}
          </div>
        )}
      </Card>

      {/* QBO Connected Details */}
      {qboStatus === 'connected' && qboInteg && (
        <Card style={{ marginTop: 14 }}>
          <Label>Sync Details</Label>
          <div style={{ fontSize: 12, color: TH.muted, marginBottom: 12 }}>
            Last sync: {qboInteg.last_sync_at ? new Date(qboInteg.last_sync_at).toLocaleString() : 'Never'}
          </div>

          {(syncResult || qboInteg.metadata?.last_sync_results) && (() => {
            const r = syncResult || qboInteg.metadata?.last_sync_results
            return (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div style={{ background: '#2CA01C18', border: '1px solid #2CA01C44', borderRadius: 6, padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#2CA01C' }}>{r.bills ?? 0}</div>
                    <div style={{ fontSize: 11, color: TH.muted }}>Bills</div>
                  </div>
                  <div style={{ background: '#3b82f618', border: '1px solid #3b82f644', borderRadius: 6, padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#3b82f6' }}>{r.timeEntries ?? 0}</div>
                    <div style={{ fontSize: 11, color: TH.muted }}>Time entries</div>
                  </div>
                  <div style={{ background: '#f59e0b18', border: '1px solid #f59e0b44', borderRadius: 6, padding: '10px 12px', textAlign: 'center' }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: '#f59e0b' }}>{r.projects ?? 0}</div>
                    <div style={{ fontSize: 11, color: TH.muted }}>Projects</div>
                  </div>
                </div>
                {r.errors?.length > 0 && (
                  <div style={{ padding: '8px 12px', background: TH.redLo || '#fee2e2', borderRadius: 6, border: `1px solid ${TH.red}44`, marginBottom: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: TH.red, marginBottom: 4 }}>Sync errors</div>
                    {r.errors.map((err, i) => (
                      <div key={i} style={{ fontSize: 11, color: TH.red }}>{err}</div>
                    ))}
                  </div>
                )}
              </>
            )
          })()}

          {qboInteg.metadata?.sandbox && (
            <div style={{ padding: '8px 12px', background: TH.amberLo || '#fef3c7', borderRadius: 6, border: `1px solid ${TH.amber}44`, fontSize: 12, color: TH.amber }}>
              Sandbox mode — connected to QuickBooks test environment
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
