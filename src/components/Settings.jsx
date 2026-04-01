import { useState, useEffect } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Input, Btn } from './Atoms'
import { companies, integrations } from '../lib/db'
import { supabase } from '../lib/supabase'

export function Settings({ company, onUpdated }) {
  const [name,      setName]      = useState(company?.name || '')
  const [saving,    setSaving]    = useState(false)
  const [saved,     setSaved]     = useState(false)
  const [error,     setError]     = useState(null)
  const [qboStatus, setQboStatus] = useState('loading') // loading | connected | disconnected

  useEffect(() => {
    if (!company?.id) return
    checkQboStatus()

    // Handle redirect back from QBO OAuth
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
    setQboStatus(qbo ? 'connected' : 'disconnected')
  }

  async function handleConnectQBO() {
    // Call the qbo-auth edge function to get the OAuth URL
    const { data, error: err } = await supabase.functions.invoke('qbo-auth', {
      body: { company_id: company.id }
    })
    if (err || !data?.url) {
      setError('Failed to start QuickBooks connection. Make sure the integration is configured.')
      return
    }
    window.location.href = data.url
  }

  async function handleDisconnectQBO() {
    const { data } = await integrations.list(company.id)
    const qbo = data?.find(i => i.provider === 'qbo')
    if (qbo) {
      await integrations.delete(qbo.id)
      setQboStatus('disconnected')
    }
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
    setSaving(true)
    setError(null)
    setSaved(false)
    const { data, error: err } = await companies.update(company.id, { name: name.trim() })
    setSaving(false)
    if (err) { setError(err.message); return }
    setSaved(true)
    onUpdated?.(data)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <div style={{ padding: '32px 36px', maxWidth: 600 }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, color: TH.text, margin: 0, marginBottom: 4 }}>Settings</h1>
      <div style={{ fontSize: 13, color: TH.muted, marginBottom: 28 }}>Company configuration and integrations</div>

      {/* Company details */}
      <Card style={{ marginBottom: 14 }}>
        <Label>Company Details</Label>
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Input
            label="Company Name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="L&A Exterior Systems"
          />
          {error && <div style={{ fontSize: 12, color: TH.red }}>{error}</div>}
          {saved && <div style={{ fontSize: 12, color: TH.green }}>✓ Saved</div>}
          <Btn type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Save Changes'}
          </Btn>
        </form>
      </Card>

      {/* Integrations */}
      <Card>
        <Label>Integrations</Label>
        <div style={{ fontSize: 13, color: TH.muted, marginBottom: 16 }}>
          Connect your tools to sync data automatically.
        </div>

        {/* QuickBooks Online */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 0', borderBottom: `1px solid ${TH.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: '#2CA01C',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 700, color: '#fff', flexShrink: 0,
            }}>Q</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>QuickBooks Online</div>
              <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>
                {qboStatus === 'connected'
                  ? 'Syncing bills, estimates, and time entries'
                  : 'Connect to sync job costs automatically'}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {qboStatus === 'connected' ? (
              <>
                <Btn
                  variant="ghost"
                  onClick={handleSyncQBO}
                  disabled={saving}
                  style={{ fontSize: 11, padding: '6px 12px' }}
                >
                  {saving ? 'Syncing…' : saved ? '✓ Synced' : 'Sync Now'}
                </Btn>
                <Btn
                  variant="ghost"
                  onClick={handleDisconnectQBO}
                  style={{ fontSize: 11, padding: '6px 12px', color: TH.red, borderColor: TH.red + '44' }}
                >
                  Disconnect
                </Btn>
              </>
            ) : qboStatus === 'disconnected' ? (
              <Btn
                onClick={handleConnectQBO}
                style={{ fontSize: 11, padding: '6px 14px', background: '#2CA01C', color: '#fff' }}
              >
                Connect QBO
              </Btn>
            ) : (
              <div style={{ fontSize: 11, color: TH.muted }}>Loading…</div>
            )}
          </div>
        </div>

        {/* PlanSwift */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 0', borderBottom: `1px solid ${TH.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: TH.surf,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0,
            }}>📐</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>PlanSwift</div>
              <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>Import sqft measurements via CSV export</div>
            </div>
          </div>
          <Btn variant="ghost" disabled style={{ fontSize: 11, padding: '6px 12px' }}>Coming Soon</Btn>
        </div>

        {/* ConstructionClock */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 0', borderBottom: `1px solid ${TH.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: TH.surf,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0,
            }}>⏱</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>ConstructionClock</div>
              <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>Sync crew time tracking automatically</div>
            </div>
          </div>
          <Btn variant="ghost" disabled style={{ fontSize: 11, padding: '6px 12px' }}>Coming Soon</Btn>
        </div>

        {/* Buildertrend */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '14px 0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8, background: TH.surf,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0,
            }}>🏗</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Buildertrend</div>
              <div style={{ fontSize: 11, color: TH.muted, marginTop: 2 }}>Sync projects and scheduling</div>
            </div>
          </div>
          <Btn variant="ghost" disabled style={{ fontSize: 11, padding: '6px 12px' }}>Coming Soon</Btn>
        </div>
      </Card>
    </div>
  )
}
