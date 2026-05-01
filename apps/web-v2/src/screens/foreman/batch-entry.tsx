import { useMemo, useState } from 'react'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { Attribution } from '@/components/ai'
import {
  ApiError,
  useClockIn,
  useClockOut,
  useClockTimeline,
  useWorkers,
  type Worker,
} from '@/lib/api'
import { findOpenSpan, formatHms, pairClockSpans } from '@/lib/clock-derive'
import { useGeofence } from '@/lib/geofence'

/**
 * `t-foreman` — Foreman batch time entry.
 *
 * Lists the company roster + each worker's current clock state today
 * (open vs closed spans). Per-row Clock In / Clock Out buttons fire
 * /api/clock/in (or /out) with source='foreman_override' + worker_id —
 * the API enforces the role check (admin / foreman / office) and
 * stamps the actor's clerk_user_id on the row so the audit trail
 * attributes the trigger correctly.
 *
 * Geofence position is borrowed when available so the override events
 * carry the foreman's coordinates (matches the design's "geofence
 * override" intent — the foreman's lat/lng is the closest source of
 * truth on site).
 */
export function ForemanBatchEntryScreen() {
  const workersQuery = useWorkers()
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso }, { refetchInterval: 30_000 })

  const events = timeline.data?.events ?? []
  const allSpans = useMemo(() => pairClockSpans(events), [events])

  // Group spans by worker_id; pick the most-recent open if any.
  const stateByWorker = useMemo(() => {
    const map = new Map<string, { openIn: ReturnType<typeof findOpenSpan>; totalHours: number }>()
    for (const span of allSpans) {
      // The span carries project_id (not worker_id directly). For accurate
      // per-worker rollups we'd need worker_id on the span — for now
      // the API timeline returns event rows with worker_id, so we walk
      // events directly for grouping.
    }
    // Re-derive per worker by walking the raw event rows instead.
    const eventsByWorker = new Map<string, typeof events>()
    for (const e of events) {
      if (!e.worker_id) continue
      const list = eventsByWorker.get(e.worker_id) ?? []
      list.push(e)
      eventsByWorker.set(e.worker_id, list)
    }
    for (const [wid, wEvents] of eventsByWorker) {
      const spans = pairClockSpans(wEvents)
      const open = findOpenSpan(spans)
      const total = spans.reduce((sum, s) => sum + s.hours, 0)
      map.set(wid, { openIn: open, totalHours: total })
    }
    return map
  }, [allSpans, events])

  // Borrow the foreman's GPS for the override events.
  const geofence = useGeofence({ enabled: true })

  const clockIn = useClockIn()
  const clockOut = useClockOut()
  const [error, setError] = useState<string | null>(null)
  const [busyWorkerId, setBusyWorkerId] = useState<string | null>(null)

  const onClockIn = async (worker: Worker) => {
    setError(null)
    setBusyWorkerId(worker.id)
    try {
      await clockIn.mutateAsync({
        worker_id: worker.id,
        lat: geofence.position?.lat ?? 0,
        lng: geofence.position?.lng ?? 0,
        accuracy_m: geofence.position?.accuracyMeters ?? null,
        source: 'foreman_override',
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : `Could not clock ${worker.name} in`)
    } finally {
      setBusyWorkerId(null)
    }
  }

  const onClockOut = async (worker: Worker) => {
    setError(null)
    setBusyWorkerId(worker.id)
    try {
      await clockOut.mutateAsync({
        worker_id: worker.id,
        lat: geofence.position?.lat ?? 0,
        lng: geofence.position?.lng ?? 0,
        accuracy_m: geofence.position?.accuracyMeters ?? null,
        source: 'foreman_override',
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.message_for_user() : `Could not clock ${worker.name} out`)
    } finally {
      setBusyWorkerId(null)
    }
  }

  const workers = workersQuery.data?.workers ?? []
  const onSiteCount = Array.from(stateByWorker.values()).filter((s) => s.openIn !== null).length

  return (
    <div className="flex flex-col">
      <div className="px-5 pt-6 pb-3">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Foreman · Time</div>
        <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Crew entry</h1>
        <div className="text-[12px] text-ink-3 mt-1">
          {onSiteCount} of {workers.length} on site
        </div>
      </div>

      {geofence.error ? (
        <div className="px-4 pb-3">
          <Card tight>
            <div className="text-[12px] text-warn">
              Location {geofence.error.kind === 'permission_denied' ? 'denied' : 'unavailable'}. Override events
              will be recorded without coordinates.
            </div>
          </Card>
        </div>
      ) : null}

      {error ? (
        <div className="px-4 pb-3">
          <div className="text-[13px] text-bad px-1">{error}</div>
        </div>
      ) : null}

      <div className="px-4 pb-8">
        {workersQuery.isPending ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">Loading roster…</div>
          </Card>
        ) : workers.length === 0 ? (
          <Card tight>
            <div className="text-[12px] text-ink-3">No workers on the roster.</div>
            <div className="text-[11px] text-ink-3 mt-1">
              Add workers under Settings → Team in Phase 2.
            </div>
          </Card>
        ) : (
          <div className="space-y-2">
            <Attribution source="Live from /api/workers + /api/clock/timeline" />
            {workers.map((worker) => {
              const state = stateByWorker.get(worker.id)
              const isOpen = state?.openIn !== null && state?.openIn !== undefined
              const isBusy = busyWorkerId === worker.id
              return (
                <Card key={worker.id} tight>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <Avatar name={worker.name} />
                      <div className="min-w-0">
                        <div className="text-[14px] font-semibold truncate">{worker.name}</div>
                        <div className="text-[11px] text-ink-3">{worker.role}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      {isOpen ? (
                        <div className="num text-[14px] font-semibold">{formatHms(state!.openIn!.hours)}</div>
                      ) : state && state.totalHours > 0 ? (
                        <div className="num text-[14px] font-medium text-ink-2">
                          {state.totalHours.toFixed(1)}h
                        </div>
                      ) : (
                        <div className="text-[11px] text-ink-3">no activity</div>
                      )}
                      {isOpen ? <Pill tone="good" withDot>on</Pill> : null}
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2">
                    {isOpen ? (
                      <MobileButton
                        variant="ghost"
                        size="sm"
                        onClick={() => onClockOut(worker)}
                        disabled={isBusy}
                      >
                        {isBusy ? '…' : 'Clock out'}
                      </MobileButton>
                    ) : (
                      <MobileButton
                        variant="primary"
                        size="sm"
                        onClick={() => onClockIn(worker)}
                        disabled={isBusy}
                      >
                        {isBusy ? '…' : 'Clock in'}
                      </MobileButton>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <div className="w-9 h-9 rounded-full bg-accent-soft text-accent-ink text-[12px] font-semibold inline-flex items-center justify-center shrink-0">
      {initials}
    </div>
  )
}
