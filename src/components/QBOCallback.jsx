import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { TH } from '../lib/theme'
import { Card, Btn, Spinner } from './Atoms'
import { integrations } from '../lib/db'

export function QBOCallback() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [status, setStatus] = useState('processing')
  const [error, setError] = useState(null)

  useEffect(() => {
    const code = searchParams.get('code')
    const state = searchParams.get('state')
    const realmId = searchParams.get('realmId')

    if (!code || !state) {
      setStatus('error')
      setError('Missing authorization code')
      return
    }

    // Exchange code for tokens
    exchangeCodeForTokens(code, state, realmId)
  }, [searchParams])

  async function exchangeCodeForTokens(code, state, realmId) {
    try {
      const stateData = JSON.parse(atob(state))
      const { companyId } = stateData

      // Call backend to exchange code
      const res = await fetch('/api/qbo/oauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, state, realmId })
      })

      if (!res.ok) throw new Error('Token exchange failed')

      const { access_token, refresh_token, expires_in } = await res.json()

      // Save integration
      await integrations.upsert({
        company_id: companyId,
        provider: 'qbo',
        access_token,
        refresh_token,
        expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
        account_name: realmId,
        metadata: { realmId }
      })

      setStatus('success')
      
      // Redirect back to settings after 2 seconds
      setTimeout(() => navigate('/sitelayer/settings'), 2000)
    } catch (err) {
      setStatus('error')
      setError(err.message)
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <Card style={{ padding: 40, textAlign: 'center', maxWidth: 400 }}>
        {status === 'processing' && (
          <>
            <Spinner />
            <div style={{ marginTop: 16, color: TH.text }}>Connecting to QuickBooks…</div>
          </>
        )}

        {status === 'success' && (
          <>
            <div style={{ fontSize: 48 }}>✅</div>
            <div style={{ marginTop: 16, fontWeight: 600, color: TH.text }}>Connected!</div>
            <div style={{ marginTop: 8, fontSize: 13, color: TH.muted }}>Redirecting to settings…</div>
          </>
        )}

        {status === 'error' && (
          <>
            <div style={{ fontSize: 48 }}>❌</div>
            <div style={{ marginTop: 16, fontWeight: 600, color: TH.red }}>Connection failed</div>
            <div style={{ marginTop: 8, fontSize: 13, color: TH.muted }}>{error}</div>
            <Btn onClick={() => navigate('/sitelayer/settings')} style={{ marginTop: 20 }}>
              Back to Settings
            </Btn>
          </>
        )}
      </Card>
    </div>
  )
}
