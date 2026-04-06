import { useState, useEffect } from 'react'
import { TH } from '../lib/theme'
import { Card, Label, Btn, Badge, Spinner } from './Atoms'
import { integrations } from '../lib/db'

export function QBOIntegration({ companyId }) {
  const [integ, setInteg] = useState(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState(null)

  useEffect(() => {
    loadIntegration()
  }, [companyId])

  async function loadIntegration() {
    setLoading(true)
    const { data } = await integrations.list(companyId)
    const qbo = data?.find(i => i.provider === 'qbo')
    setInteg(qbo || null)
    setLastSync(qbo?.last_sync_at)
    setLoading(false)
  }

  function connectQBO() {
    // OAuth flow - open Intuit auth window
    const clientId = import.meta.env.VITE_QBO_CLIENT_ID
    const redirectUri = `${window.location.origin}/sitelayer/qbo-callback`
    const state = btoa(JSON.stringify({ companyId, nonce: Math.random() }))
    
    const authUrl = `https://appcenter.intuit.com/connect/oauth2?` +
      `client_id=${clientId}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `response_type=code&` +
      `scope=com.intuit.quickbooks.accounting%20com.intuit.quickbooks.payroll.timetracking&` +
      `state=${state}`
    
    window.location.href = authUrl
  }

  async function disconnectQBO() {
    if (!integ) return
    await integrations.delete(integ.id)
    setInteg(null)
  }

  async function syncNow() {
    if (!integ) return
    setSyncing(true)
    
    // Call sync endpoint
    const res = await fetch('/api/qbo/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        companyId,
        integrationId: integ.id,
        syncType: 'time_entries'
      })
    })
    
    if (res.ok) {
      setLastSync(new Date().toISOString())
      await loadIntegration()
    }
    setSyncing(false)
  }

  if (loading) return <div style={{ padding: 40 }}><Spinner /></div>

  return (
    <div style={{ padding: '24px 20px', maxWidth: 600 }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20, color: TH.text }}>
        QuickBooks Online
      </h2>
      <p style={{ margin: '0 0 20px', fontSize: 13, color: TH.muted }}>
        Sync time entries and projects with QBO
      </p>

      {!integ ? (
        <Card style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
          <h3 style={{ margin: '0 0 8px', color: TH.text }}>Connect to QuickBooks</h3>
          <p style={{ margin: '0 0 20px', color: TH.muted, fontSize: 14 }}>
            Sync time entries automatically to QBO for payroll and invoicing
          </p>
          <Btn onClick={connectQBO}>
            Connect QuickBooks
          </Btn>
        </Card>
      ) : (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontWeight: 600, color: TH.text }}>
                ✅ Connected to QuickBooks
              </div>
              <div style={{ fontSize: 12, color: TH.muted, marginTop: 4 }}>
                {integ.account_name || 'Unknown account'}
              </div>
            </div>
            <Btn variant="ghost" onClick={disconnectQBO}>
              Disconnect
            </Btn>
          </div>

          <div style={{ borderTop: `1px solid ${TH.border}`, paddingTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 12, color: TH.muted }}>Last sync</div>
                <div style={{ fontSize: 14, color: TH.text }}>
                  {lastSync ? new Date(lastSync).toLocaleString() : 'Never'}
                </div>
              </div>
              <Btn onClick={syncNow} disabled={syncing}>
                {syncing ? 'Syncing…' : 'Sync Now'}
              </Btn>
            </div>
          </div>

          <div style={{ marginTop: 16, padding: 12, background: TH.surf, borderRadius: 6 }}>
            <div style={{ fontSize: 12, color: TH.muted, marginBottom: 8 }}>
              Sync settings
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" defaultChecked />
                Auto-sync time entries daily
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <input type="checkbox" defaultChecked />
                Create missing service items in QBO
              </label>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
