import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import { fetchQboAuthUrl, useQboConnection, useTriggerQboSync } from '@/lib/api'

export function QboConnectionScreen() {
  const qbo = useQboConnection()
  const sync = useTriggerQboSync()
  const [error, setError] = useState<string | null>(null)
  const [authPending, setAuthPending] = useState(false)

  const onConnect = async () => {
    setError(null)
    setAuthPending(true)
    try {
      const { authUrl } = await fetchQboAuthUrl()
      if (typeof window !== 'undefined') window.location.href = authUrl
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start OAuth')
      setAuthPending(false)
    }
  }

  const onSync = async () => {
    setError(null)
    try {
      await sync.mutateAsync()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    }
  }

  if (qbo.isPending) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading QBO state…</div>
  }

  const conn = qbo.data?.connection
  const status = conn?.status ?? 'disconnected'
  const syncStatus = qbo.data?.status

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <Link to="/more/integrations" className="text-[12px] text-ink-3">
        ← Integrations
      </Link>
      <div className="mt-2 flex items-center justify-between gap-3">
        <h1 className="font-display text-[24px] font-bold tracking-tight leading-tight">QuickBooks Online</h1>
        <Pill tone={status === 'connected' ? 'good' : status === 'error' ? 'warn' : 'default'}>{status}</Pill>
      </div>

      <div className="mt-6 space-y-3">
        <Card>
          <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Connection</div>
          {conn ? (
            <div className="text-[12px] text-ink-2 mt-1 space-y-1">
              <div>
                Realm: <span className="font-mono">{conn.provider_account_id ?? '—'}</span>
              </div>
              <div>Last synced: {conn.last_synced_at ? new Date(conn.last_synced_at).toLocaleString() : '—'}</div>
              <div>
                Cursor: <span className="font-mono">{conn.sync_cursor ?? '—'}</span>
              </div>
              <div>v{conn.version}</div>
            </div>
          ) : (
            <div className="text-[12px] text-ink-3 mt-1">No connection yet.</div>
          )}
          <div className="mt-3">
            <MobileButton variant="primary" onClick={onConnect} disabled={authPending}>
              {authPending ? 'Redirecting…' : conn ? 'Reconnect (OAuth)' : 'Connect to QBO'}
            </MobileButton>
          </div>
        </Card>

        {syncStatus ? (
          <Card>
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Sync queue</div>
            <div className="grid grid-cols-2 gap-2 mt-2 text-[12px] text-ink-2">
              <div>
                <div className="text-[11px] text-ink-3">Pending outbox</div>
                <div className="num text-[18px] font-semibold">{syncStatus.pending_outbox}</div>
              </div>
              <div>
                <div className="text-[11px] text-ink-3">Pending events</div>
                <div className="num text-[18px] font-semibold">{syncStatus.pending_sync_events}</div>
              </div>
              <div>
                <div className="text-[11px] text-ink-3">Applied 24h</div>
                <div className="num text-[18px] font-semibold">{syncStatus.applied_last_24h}</div>
              </div>
              <div>
                <div className="text-[11px] text-ink-3">Failed 24h</div>
                <div className="num text-[18px] font-semibold">{syncStatus.failed_last_24h}</div>
              </div>
            </div>
            <div className="text-[11px] text-ink-3 mt-2">
              Last applied: {syncStatus.last_applied_at ? new Date(syncStatus.last_applied_at).toLocaleString() : '—'}
            </div>
            <div className="mt-3">
              <MobileButton variant="ghost" onClick={onSync} disabled={sync.isPending}>
                {sync.isPending ? 'Triggering…' : 'Trigger sync'}
              </MobileButton>
            </div>
          </Card>
        ) : null}

        <Link to="/more/integrations/qbo/mappings" className="block">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[14px] font-semibold">Entity mappings</div>
                <div className="text-[12px] text-ink-3 mt-0.5">
                  Map customers / service items / divisions to their QBO IDs.
                </div>
              </div>
              <span className="text-ink-4" aria-hidden="true">
                ›
              </span>
            </div>
          </Card>
        </Link>

        {error ? <div className="text-[12px] text-status-warn">{error}</div> : null}
        <Attribution source="GET /api/integrations/qbo · POST /api/integrations/qbo/sync" />
      </div>
    </div>
  )
}
