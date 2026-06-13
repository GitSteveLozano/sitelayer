import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MButton, MListInset, MListRow, MPill, MSelect, MTopBar, type MTone } from '@/components/m'
import { Attribution } from '@/components/ai'
import { ApiError } from '@/lib/api/client'
import {
  countFailedOutbox,
  fetchQboAuthUrl,
  useActiveCompanyId,
  useCompanySettings,
  useDispatchQboSyncRunEvent,
  usePatchCompanySettings,
  useQboConnection,
  useQboSyncOutbox,
  useQboSyncRun,
  useQboSyncRuns,
  useQboSyncStatus,
  useServiceItems,
  useTriggerQboSync,
  type QboSyncRunSnapshot,
} from '@/lib/api'

/** Pull a qbo_sync_run id out of a POST /sync response or its error body. */
function extractRunId(value: unknown): string | null {
  if (value && typeof value === 'object' && 'qbo_sync_run_id' in value) {
    const id = (value as { qbo_sync_run_id?: unknown }).qbo_sync_run_id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}

/** Connection-status pill tone — same mapping as the designed
 *  IntegrationsStatusList connector rows in settings-home (msg__88). */
const STATUS_TONE: Record<string, MTone> = {
  connected: 'green',
  error: 'red',
}

export function QboConnectionScreen() {
  const navigate = useNavigate()
  const qbo = useQboConnection()
  const sync = useTriggerQboSync()
  const [error, setError] = useState<string | null>(null)
  const [authPending, setAuthPending] = useState(false)

  // The run id is learned from the POST /sync response (success OR the
  // 500 error body both carry `qbo_sync_run_id`). From there the monitor
  // reads the authoritative workflow snapshot — it no longer reconstructs
  // the run state from the connection's cached `status` flag.
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  // Recover the most-recent run on mount so a `failed` run's RETRY action
  // survives a page reload (the run id is otherwise only learned from the
  // POST /sync response within the same session).
  const recentRuns = useQboSyncRuns({ limit: 1 })
  const latestRunId = recentRuns.data?.syncRuns[0]?.context.id ?? null
  useEffect(() => {
    if (!activeRunId && latestRunId) setActiveRunId(latestRunId)
  }, [activeRunId, latestRunId])
  const run = useQboSyncRun(activeRunId)
  const runSnapshot = run.data ?? null

  const conn = qbo.data?.connection
  const status = conn?.status ?? 'disconnected'
  // Still in motion while the trigger request is open OR the workflow
  // snapshot reports a non-terminal run state.
  const runInFlight = runSnapshot
    ? runSnapshot.state === 'pending' || runSnapshot.state === 'syncing' || runSnapshot.state === 'retrying'
    : false
  const inFlight = sync.isPending || run.isFetching || runInFlight
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
      const result = await sync.mutateAsync()
      const runId = extractRunId(result)
      if (runId) setActiveRunId(runId)
      // Pull fresh queue + event state right after the trigger returns.
      await Promise.all([syncStatus.refetch(), outbox.refetch()])
    } catch (e) {
      // The 500 body still carries the run id so the monitor can show the
      // failed run + its RETRY action instead of dead-ending on an error.
      if (e instanceof ApiError) {
        const runId = extractRunId(e.body)
        if (runId) setActiveRunId(runId)
      }
      setError(e instanceof Error ? e.message : 'Sync failed')
    }
  }

  if (qbo.isPending) {
    return (
      <>
        <MTopBar back eyebrow="Integrations" title="QuickBooks Online" onBack={() => navigate('/more/integrations')} />
        <MBody>
          <div className="m-quiet-sm" style={{ padding: '14px 16px' }}>
            Loading QBO state…
          </div>
        </MBody>
      </>
    )
  }

  return (
    <>
      <MTopBar back eyebrow="Integrations" title="QuickBooks Online" onBack={() => navigate('/more/integrations')} />
      <MBody>
        <div className="m-card-stack" style={{ paddingTop: 16, paddingBottom: 12 }}>
          <div className="m-card">
            <div className="flex items-center justify-between gap-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Connection</div>
              <MPill tone={STATUS_TONE[status]} dot>
                {status}
              </MPill>
            </div>
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
              <MButton variant="primary" onClick={onConnect} disabled={authPending}>
                {authPending ? 'Redirecting…' : conn ? 'Reconnect (OAuth)' : 'Connect to QBO'}
              </MButton>
            </div>
          </div>

          <QboSyncMonitorCard
            hasConnection={Boolean(conn)}
            runId={activeRunId}
            runSnapshot={runSnapshot}
            pendingOutbox={syncStatus.data?.pendingOutboxCount ?? 0}
            pendingEvents={syncStatus.data?.pendingSyncEventCount ?? 0}
            failedCount={countFailedOutbox(outbox.data)}
            loading={syncStatus.isPending || outbox.isPending}
            inFlight={inFlight}
            triggering={sync.isPending}
            onSync={onSync}
          />
        </div>

        <MListInset>
          <MListRow
            headline="Entity mappings"
            supporting="Map customers / service items / divisions to their QBO IDs."
            chev
            onTap={() => navigate('/more/integrations/qbo/mappings')}
          />
          <MListRow
            headline="Custom fields"
            supporting="Map QBO custom-field definitions per entity (Estimate / Invoice / Bill / PO)."
            chev
            onTap={() => navigate('/more/integrations/qbo/custom-fields')}
          />
        </MListInset>

        <div className="m-card-stack" style={{ paddingTop: 12, paddingBottom: 24 }}>
          <QboOvertimeMappingCard />

          {error ? <div className="text-[12px] text-warn">{error}</div> : null}
          <Attribution source="GET /api/integrations/qbo · GET /api/sync/status · GET /api/sync/outbox · POST /api/integrations/qbo/sync" />
        </div>
      </MBody>
    </>
  )
}

/**
 * Map the authoritative qbo_sync_run workflow snapshot
 * (pending → syncing → succeeded | failed → retrying → syncing) into the
 * monitor's last-run presentation. The state and the available actions
 * both come straight from the reducer snapshot — the UI never invents a
 * transition the machine doesn't allow. Falls back to a connection-flag
 * hint only when no run has been observed this session.
 */
function presentRun(args: { snapshot: QboSyncRunSnapshot | null; triggering: boolean }): {
  label: string
  tone: MTone | undefined
  detail: string
} {
  if (args.triggering && !args.snapshot) {
    return { label: 'Syncing', tone: undefined, detail: 'Starting sync…' }
  }
  const snap = args.snapshot
  if (!snap) {
    return { label: 'Idle', tone: undefined, detail: 'No sync has run yet — run one to backfill from QBO.' }
  }
  const ctx = snap.context
  switch (snap.state) {
    case 'pending':
    case 'syncing':
      return { label: 'Syncing', tone: undefined, detail: 'Sync in progress…' }
    case 'retrying':
      return { label: 'Retrying', tone: undefined, detail: 'Retry queued — starting again…' }
    case 'failed':
      return {
        label: 'Failed',
        tone: 'amber',
        detail: ctx.error ?? 'Last sync attempt failed. Retry to run it again.',
      }
    case 'succeeded':
      return {
        label: 'Succeeded',
        tone: 'green',
        detail: ctx.succeeded_at
          ? `Last synced ${new Date(ctx.succeeded_at).toLocaleString()}.`
          : 'Last sync succeeded.',
      }
  }
}

/**
 * Sync monitor + manual trigger. Renders the qbo_sync_run workflow
 * snapshot (`state` + `next_events`) returned by
 * GET /api/integrations/qbo/sync-runs/:id, the live queue depths from
 * GET /api/sync/status, and the failed count from GET /api/sync/outbox.
 *
 * The primary action is "Run sync now" (POST /sync, mints a new run).
 * When the latest run is `failed`, the reducer's RETRY next_event
 * surfaces as a Retry button that dispatches
 * POST /sync-runs/:id/events {event:'RETRY'} — moving the SAME run
 * failed → retrying and re-emitting its `run_qbo_sync` outbox anchor.
 */
function QboSyncMonitorCard({
  hasConnection,
  runId,
  runSnapshot,
  pendingOutbox,
  pendingEvents,
  failedCount,
  loading,
  inFlight,
  triggering,
  onSync,
}: {
  hasConnection: boolean
  runId: string | null
  runSnapshot: QboSyncRunSnapshot | null
  pendingOutbox: number
  pendingEvents: number
  failedCount: number
  loading: boolean
  inFlight: boolean
  triggering: boolean
  onSync: () => void
}) {
  const run = presentRun({ snapshot: runSnapshot, triggering })
  const hasFailures = failedCount > 0
  const retryEvent = runSnapshot?.next_events.find((e) => e.type === 'RETRY') ?? null

  const dispatchEvent = useDispatchQboSyncRunEvent(runId ?? '')
  const onRetry = () => {
    if (!runId || !runSnapshot) return
    dispatchEvent.mutate({ event: 'RETRY', state_version: runSnapshot.state_version })
  }
  const dispatchError =
    dispatchEvent.error instanceof Error ? dispatchEvent.error.message : dispatchEvent.error ? 'Retry failed' : null

  return (
    <div className="m-card">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Sync</div>
        <MPill tone={run.tone}>{run.label}</MPill>
      </div>

      <div className="text-[12px] text-ink-2 mt-1">{loading && !runSnapshot ? 'Loading sync state…' : run.detail}</div>

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

      <div className="mt-3 flex gap-2.5">
        <MButton variant="primary" onClick={onSync} disabled={triggering || inFlight}>
          {triggering ? 'Starting…' : inFlight ? 'Syncing…' : 'Run sync now'}
        </MButton>
        {retryEvent ? (
          <MButton variant="ghost" onClick={onRetry} disabled={dispatchEvent.isPending || inFlight}>
            {dispatchEvent.isPending ? 'Retrying…' : retryEvent.label}
          </MButton>
        ) : null}
      </div>
      {dispatchError ? <div className="text-[12px] text-warn mt-2">{dispatchError}</div> : null}
      {!hasConnection ? (
        <div className="text-[11px] text-ink-3 mt-2">
          No QBO credentials yet — sync runs in simulated mode and backfills mappings from local data.
        </div>
      ) : null}
    </div>
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
    <div className="m-card">
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
            <span className="m-field-l">Overtime service item</span>
            <MSelect value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">— None (single TimeActivity, no OT split) —</option>
              {labels.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} · {item.name}
                </option>
              ))}
            </MSelect>
          </label>
          {saveError ? <div className="text-[12px] text-warn mt-2">{saveError}</div> : null}
          {saved && !dirty ? <div className="text-[12px] text-good mt-2">Saved.</div> : null}
          <div className="mt-3">
            <MButton variant="primary" onClick={save} disabled={!dirty || patch.isPending || !companyId}>
              {patch.isPending ? 'Saving…' : 'Save'}
            </MButton>
          </div>
        </>
      )}
    </div>
  )
}
