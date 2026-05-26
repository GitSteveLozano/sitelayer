import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  countFailedOutbox,
  fetchQboAuthUrl,
  useActiveCompanyId,
  useCompanySettings,
  usePatchCompanySettings,
  useQboConnection,
  useQboSyncOutbox,
  useQboSyncStatus,
  useServiceItems,
  useTriggerQboSync,
  type QboLatestSyncEvent,
} from '@/lib/api'

export function QboConnectionScreen() {
  const qbo = useQboConnection()
  const sync = useTriggerQboSync()
  const [error, setError] = useState<string | null>(null)
  const [authPending, setAuthPending] = useState(false)

  // Poll the sync queue while a sync is in-flight (button pressed or the
  // connection cache still says 'syncing') so the monitor reflects the
  // syncing → succeeded|failed transition without a manual refresh.
  const conn = qbo.data?.connection
  const status = conn?.status ?? 'disconnected'
  const inFlight = sync.isPending || status === 'syncing'
  const syncStatus = useQboSyncStatus({ refetchInterval: inFlight ? 3_000 : false })
  const outbox = useQboSyncOutbox(50, { refetchInterval: inFlight ? 3_000 : false })

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
      // Pull fresh queue + event state right after the trigger returns.
      await Promise.all([syncStatus.refetch(), outbox.refetch()])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    }
  }

  if (qbo.isPending) {
    return <div className="px-5 pt-8 text-[13px] text-ink-3">Loading QBO state…</div>
  }

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

        <QboSyncMonitorCard
          connectionStatus={status}
          hasConnection={Boolean(conn)}
          pendingOutbox={syncStatus.data?.pendingOutboxCount ?? 0}
          pendingEvents={syncStatus.data?.pendingSyncEventCount ?? 0}
          failedCount={countFailedOutbox(outbox.data)}
          lastEvent={syncStatus.data?.latestSyncEvent ?? null}
          loading={syncStatus.isPending || outbox.isPending}
          inFlight={inFlight}
          triggering={sync.isPending}
          onSync={onSync}
        />

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

        <Link to="/more/integrations/qbo/custom-fields" className="block">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[14px] font-semibold">Custom fields</div>
                <div className="text-[12px] text-ink-3 mt-0.5">
                  Map QBO custom-field definitions per entity (Estimate / Invoice / Bill / PO).
                </div>
              </div>
              <span className="text-ink-4" aria-hidden="true">
                ›
              </span>
            </div>
          </Card>
        </Link>

        <QboOvertimeMappingCard />

        {error ? <div className="text-[12px] text-warn">{error}</div> : null}
        <Attribution source="GET /api/integrations/qbo · GET /api/sync/status · GET /api/sync/outbox · POST /api/integrations/qbo/sync" />
      </div>
    </div>
  )
}

/**
 * Map a sync row status + the connection's cached status flag into the
 * monitor's last-run state. The qbo_sync_runs workflow
 * (pending → syncing → succeeded | failed) has no GET surface yet, so
 * we derive the run state from the in-flight signal, the connection's
 * own cached `status` flag (the route flips it to syncing / connected /
 * error), and the latest sync_events row.
 */
function deriveRunState(args: { inFlight: boolean; connectionStatus: string; lastEvent: QboLatestSyncEvent | null }): {
  label: string
  tone: 'good' | 'warn' | 'default'
  detail: string
} {
  if (args.inFlight || args.connectionStatus === 'syncing') {
    return { label: 'Syncing', tone: 'default', detail: 'Sync in progress…' }
  }
  if (args.connectionStatus === 'error') {
    return {
      label: 'Failed',
      tone: 'warn',
      detail: args.lastEvent?.error ?? 'Last sync attempt failed. Run again to retry.',
    }
  }
  const ev = args.lastEvent
  if (!ev) {
    return { label: 'Idle', tone: 'default', detail: 'No sync has run yet.' }
  }
  if (ev.status === 'failed') {
    return { label: 'Failed', tone: 'warn', detail: ev.error ?? 'Last event failed.' }
  }
  if (ev.status === 'pending' || ev.status === 'processing') {
    return { label: 'Queued', tone: 'default', detail: 'Work queued, not yet applied.' }
  }
  return {
    label: 'Succeeded',
    tone: 'good',
    detail: `Last event applied ${ev.applied_at ? new Date(ev.applied_at).toLocaleString() : new Date(ev.created_at).toLocaleString()}.`,
  }
}

/**
 * Sync monitor + manual trigger. Reads the live queue depths from
 * GET /api/sync/status and the failed count from GET /api/sync/outbox,
 * shows the derived last-run state, and exposes a "Run sync now" button
 * that POSTs /api/integrations/qbo/sync. The button disables and the
 * KPIs poll while a sync is in-flight.
 */
function QboSyncMonitorCard({
  connectionStatus,
  hasConnection,
  pendingOutbox,
  pendingEvents,
  failedCount,
  lastEvent,
  loading,
  inFlight,
  triggering,
  onSync,
}: {
  connectionStatus: string
  hasConnection: boolean
  pendingOutbox: number
  pendingEvents: number
  failedCount: number
  lastEvent: QboLatestSyncEvent | null
  loading: boolean
  inFlight: boolean
  triggering: boolean
  onSync: () => void
}) {
  const run = deriveRunState({ inFlight, connectionStatus, lastEvent })
  const hasFailures = failedCount > 0

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Sync</div>
        <Pill tone={run.tone}>{run.label}</Pill>
      </div>

      <div className="text-[12px] text-ink-2 mt-1">{loading ? 'Loading sync state…' : run.detail}</div>

      <div className="grid grid-cols-3 gap-2 mt-3 text-[12px] text-ink-2">
        <div>
          <div className="text-[11px] text-ink-3">Pending outbox</div>
          <div className="num text-[18px] font-semibold">{pendingOutbox}</div>
        </div>
        <div>
          <div className="text-[11px] text-ink-3">Pending events</div>
          <div className="num text-[18px] font-semibold">{pendingEvents}</div>
        </div>
        <div>
          <div className="text-[11px] text-ink-3">Failed</div>
          <div className={`num text-[18px] font-semibold${hasFailures ? ' text-warn' : ''}`}>{failedCount}</div>
        </div>
      </div>

      {hasFailures ? (
        <div className="text-[12px] text-warn mt-2">
          {failedCount} item{failedCount === 1 ? '' : 's'} failed to push. Re-run the sync to retry them.
        </div>
      ) : null}

      <div className="mt-3">
        <MobileButton variant="primary" onClick={onSync} disabled={triggering || inFlight}>
          {triggering ? 'Starting…' : inFlight ? 'Syncing…' : 'Run sync now'}
        </MobileButton>
      </div>
      {!hasConnection ? (
        <div className="text-[11px] text-ink-3 mt-2">
          No QBO credentials yet — sync runs in simulated mode and backfills mappings from local data.
        </div>
      ) : null}
    </Card>
  )
}

/**
 * QBO Overtime mapping — admin-only card for the per-company
 * `ot_service_item_code` setting that drives the worker's split-vs-
 * merged TimeActivity push.
 *
 * Empty state: "Configure to enable OT-typed payroll pushes." When
 * unset, the worker posts ONE TimeActivity per labor_entry against
 * the entry's existing service_item_code (today's pre-OT behavior).
 *
 * When set, each entry whose hours exceed splitStraightAndOt's 8h
 * threshold produces TWO TimeActivities — one straight against the
 * entry's code, one OT against the company's OT code.
 *
 * Backed by GET/PATCH /api/companies/:id/settings. The PATCH
 * validates the code exists in service_items before accepting; the
 * dropdown filters to labor-category items as a UX hint.
 */
function QboOvertimeMappingCard() {
  const companyId = useActiveCompanyId()
  const settings = useCompanySettings(companyId)
  const patch = usePatchCompanySettings(companyId ?? '')
  const items = useServiceItems()
  const [selected, setSelected] = useState<string>('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Sync the dropdown to the server value when the query resolves.
  useEffect(() => {
    if (settings.data) setSelected(settings.data.ot_service_item_code ?? '')
  }, [settings.data])

  const currentCode = settings.data?.ot_service_item_code ?? null
  const labels = items.data?.serviceItems ?? []
  const dirty = selected !== (currentCode ?? '')

  const save = async () => {
    if (!companyId) return
    setSaveError(null)
    setSaved(false)
    try {
      await patch.mutateAsync({ ot_service_item_code: selected === '' ? null : selected })
      setSaved(true)
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Save failed')
    }
  }

  return (
    <Card>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">QBO Overtime mapping</div>
      {settings.isPending || items.isPending ? (
        <div className="text-[12px] text-ink-3 mt-2">Loading…</div>
      ) : (
        <>
          <div className="text-[12px] text-ink-2 mt-1">
            {currentCode ? (
              <>
                Hours above 8/day post against <span className="font-mono">{currentCode}</span> as a second
                TimeActivity.
              </>
            ) : (
              <>Configure to enable OT-typed payroll pushes.</>
            )}
          </div>
          <label className="block mt-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">
              Overtime service item
            </div>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-1 w-full text-[15px] py-2 bg-transparent border-b border-line focus:outline-none focus:border-accent"
            >
              <option value="">— None (single TimeActivity, no OT split) —</option>
              {labels.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} · {item.name}
                </option>
              ))}
            </select>
          </label>
          {saveError ? <div className="text-[12px] text-warn mt-2">{saveError}</div> : null}
          {saved && !dirty ? <div className="text-[12px] text-good mt-2">Saved.</div> : null}
          <div className="mt-3">
            <MobileButton variant="primary" onClick={save} disabled={!dirty || patch.isPending || !companyId}>
              {patch.isPending ? 'Saving…' : 'Save'}
            </MobileButton>
          </div>
        </>
      )}
    </Card>
  )
}
