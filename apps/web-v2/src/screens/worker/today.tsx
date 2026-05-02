import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, MobileButton, PhoneTopBar, Pill } from '@/components/mobile'
import { Spark } from '@/components/ai'
import { useClockIn, useClockOut, useClockTimeline, useVoidClockEvent, type ClockEvent } from '@/lib/api'
import { useGeofence } from '@/lib/geofence'
import {
  findOpenSpan,
  pairClockSpans,
  startOfDay,
  startOfWeek,
  sumHoursInRange,
  formatDecimalHours,
} from '@/lib/clock-derive'
import { ClockInSuccess } from './clockin-success'
import { WorkerClockedInView } from './clocked-in-view'
import { IssueModal, type IssueKind } from './issue-modal'

/**
 * Worker home — `wk-today` from `Sitemap.html` § 01.
 *
 * What's wired:
 *   - Real clock state derived from /api/clock/timeline (today's
 *     events). Open in/out is the source of truth for the running
 *     timer.
 *   - Manual clock-in/out via /api/clock/in and /out.
 *   - Auto-clock attempt: useGeofence keeps watch when the worker is
 *     off-clock; on first reading we attempt POST /api/clock/in with
 *     source='auto_geofence'. The server resolves the project from the
 *     geofence (or rejects 409 'no_geofence_match').
 *
 * What's stubbed (lands later):
 *   - Today's scope ("EPS — East elevation, 76% complete") needs the
 *     bootstrap project + scope endpoints. Phase 1D.4 wires those.
 *   - Up-next assignments need crew_schedules. Existing API has them;
 *     wiring deferred to keep this commit focused on the clock loop.
 *
 * The screen renders against AppShell — no bottom-tab nav of its own.
 */
export function WorkerTodayScreen() {
  const todayIso = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const timeline = useClockTimeline({ date: todayIso }, { refetchInterval: 30_000 })
  const events = timeline.data?.events ?? []
  const spans = useMemo(() => pairClockSpans(events), [events])
  const openSpan = findOpenSpan(spans)
  const clockedIn = openSpan !== null

  const clockIn = useClockIn()
  const clockOut = useClockOut()

  // Geofence — only watch when off-clock. When on-clock the wk-clockin
  // surface (and Phase 1D's auto-out grace timer) takes over.
  const geofence = useGeofence({ enabled: !clockedIn })

  // Live timer tick — re-render every second while clocked in so the
  // big H:MM:SS display updates.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!clockedIn) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [clockedIn])

  // Re-derive runtime from open span on every tick.
  const runtimeHours = useMemo(() => {
    if (!openSpan) return 0
    return Math.max(0, (Date.now() - Date.parse(openSpan.in_at)) / (1000 * 60 * 60))
    // tick is read so the dep tracker considers the value live; the
    // value itself is unused.
  }, [openSpan, tick])

  // Try the auto clock-in once per geofence reading. The server is the
  // arbiter of whether a project actually matches; we only sense.
  // On success we capture the resulting clock event so the wk-clockin
  // surface can render the 2-min correction window with the right
  // correctible_until.
  const [autoClockInEvent, setAutoClockInEvent] = useState<ClockEvent | null>(null)
  const [issueOpen, setIssueOpen] = useState(false)
  useEffect(() => {
    if (clockedIn || !geofence.position || clockIn.isPending) return
    void clockIn
      .mutateAsync({
        lat: geofence.position.lat,
        lng: geofence.position.lng,
        accuracy_m: geofence.position.accuracyMeters,
        source: 'auto_geofence',
      })
      .then((response) => {
        // Offline path returns { queued: true }; we just leave the
        // OfflineBanner to show pending count and skip the takeover.
        if ('queued' in response) return
        if (response.clockEvent.source === 'auto_geofence') {
          setAutoClockInEvent(response.clockEvent)
        }
      })
      .catch(() => {
        // 409 'no_geofence_match' is expected most of the time; we don't
        // surface it to the user. The presence of a clock event row
        // (next refetch) is the user-visible signal.
      })
  }, [clockedIn, geofence.position?.capturedAtMs])

  const voidClock = useVoidClockEvent()
  const handleVoid = async () => {
    if (!autoClockInEvent) return
    await voidClock.mutateAsync({ id: autoClockInEvent.id, input: { reason: 'voided from wk-clockin' } }).catch(() => {
      // The 409 paths (window expired / already voided) are surfaced
      // by the server. We swallow here; the next refetch re-renders
      // the canonical state.
    })
    setAutoClockInEvent(null)
  }

  // Today's totals.
  const nowMs = Date.now()
  const todayMs = startOfDay(nowMs)
  const weekMs = startOfWeek(nowMs)
  const todayHours = useMemo(
    () => sumHoursInRange(spans, todayMs, todayMs + 24 * 3600 * 1000, nowMs),
    [spans, todayMs, nowMs],
  )
  const weekHours = useMemo(
    () => sumHoursInRange(spans, weekMs, nowMs + 24 * 3600 * 1000, nowMs),
    [spans, weekMs, nowMs],
  )

  const activeProjectLabel = openSpan?.project_name ?? (openSpan?.project_id ? 'On site' : null)

  const onManualClockIn = async () => {
    if (!geofence.position) return
    await clockIn.mutateAsync({
      lat: geofence.position.lat,
      lng: geofence.position.lng,
      accuracy_m: geofence.position.accuracyMeters,
      source: 'manual',
    })
  }
  const onClockOut = async () => {
    await clockOut.mutateAsync({
      lat: geofence.position?.lat ?? 0,
      lng: geofence.position?.lng ?? 0,
      accuracy_m: geofence.position?.accuracyMeters ?? null,
      source: 'manual',
    })
  }

  // Auto-clock takeover: when an auto_geofence event lands, render the
  // wk-clockin success surface inline (covers the screen) until either
  // the user dismisses it or it auto-fades.
  if (autoClockInEvent) {
    return (
      <ClockInSuccess
        projectName={autoClockInEvent.project_name ?? (autoClockInEvent.project_id ? 'On site' : null)}
        occurredAt={autoClockInEvent.occurred_at}
        correctibleUntil={autoClockInEvent.correctible_until}
        onDismiss={() => setAutoClockInEvent(null)}
        onVoid={handleVoid}
      />
    )
  }

  // Focus mode: while clocked in we render the dark timer-first surface
  // (wk-today · clocked in from Sitemap §11). Off-clock keeps the
  // standard light shell with hours summary + flag-a-problem.
  if (clockedIn && openSpan) {
    // Find the matching clock_in event so we can label the timer with
    // 'auto' vs 'manual' — ClockSpan strips the source field.
    const matchingIn = events.find((e) => e.event_type === 'in' && e.occurred_at === openSpan.in_at)
    const source = matchingIn?.source === 'auto_geofence' ? 'auto_geofence' : 'manual'
    return (
      <WorkerClockedInView
        projectName={openSpan.project_name ?? activeProjectLabel ?? 'On site'}
        startedAtIso={openSpan.in_at}
        runtimeHours={runtimeHours}
        source={source}
        onClockOut={onClockOut}
        isClockingOut={clockOut.isPending}
      />
    )
  }

  return (
    <div className="flex flex-col">
      <PhoneTopBar activeProject={activeProjectLabel} />

      <div className="px-5 pb-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          {formatTodayLabel(nowMs)}
        </div>
        <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Today</h1>
      </div>

      <div className="px-4 space-y-3">
        {/* The clock card — biggest thing on the screen, always visible. */}
        <Card active={clockedIn}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Off-clock</span>
          </div>
          <div className="num font-display text-[40px] font-bold tracking-tight leading-none mt-2">0:00:00</div>
          <div className="flex items-center justify-between mt-3">
            <span className="text-[12px] text-ink-3 inline-flex items-center gap-1.5">
              {clockedIn ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-good" aria-hidden="true" />
                  On site · auto
                </>
              ) : geofence.error ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-warn" aria-hidden="true" />
                  Location {geofence.error.kind === 'permission_denied' ? 'denied' : 'unavailable'}
                </>
              ) : !geofence.ready ? (
                'Waiting for location…'
              ) : (
                'Off-site'
              )}
            </span>
            {clockedIn ? (
              <MobileButton
                variant="ghost"
                size="sm"
                fullWidth={false}
                onClick={onClockOut}
                disabled={clockOut.isPending}
              >
                Clock out
              </MobileButton>
            ) : (
              <MobileButton
                variant="primary"
                size="sm"
                fullWidth={false}
                onClick={onManualClockIn}
                disabled={!geofence.position || clockIn.isPending}
              >
                Clock in
              </MobileButton>
            )}
          </div>
        </Card>

        {/* Today's scope — placeholder copy until bootstrap data lands. */}
        <div className="pt-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">Today</div>
          <Card>
            <div className="flex items-center justify-between mb-1.5">
              <strong className="text-[15px]">Project scope</strong>
              <Pill tone="good">scheduled</Pill>
            </div>
            <p className="text-[12px] text-ink-3 mb-2">
              Project, scope, and progress land when bootstrap is wired (Phase 1D.4).
            </p>
            <div className="flex items-center gap-2 text-[11px] text-ink-3">
              <Spark state="muted" size={12} aria-label="" />
              Based on today's clock-in
            </div>
          </Card>
        </div>

        {/* Hours summary — links to wk-week / wk-hours. */}
        <div className="pt-2">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3 px-1 pb-2">Hours</div>
          <div className="grid grid-cols-2 gap-2.5">
            <Link to="/time" className="block">
              <Card tight>
                <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">Today</div>
                <div className="num text-[22px] font-semibold mt-1">{formatDecimalHours(todayHours)}</div>
                <div className="text-[11px] text-ink-3 mt-1">tap for details</div>
              </Card>
            </Link>
            <Link to="/time" className="block">
              <Card tight>
                <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">This week</div>
                <div className="num text-[22px] font-semibold mt-1">{formatDecimalHours(weekHours)}</div>
                <div className="text-[11px] text-ink-3 mt-1">Mon → today</div>
              </Card>
            </Link>
          </div>
        </div>

        <div className="px-4 pt-2 pb-6">
          <MobileButton variant="ghost" onClick={() => setIssueOpen(true)}>
            Flag a problem
          </MobileButton>
        </div>
      </div>
      <IssueModal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        onSubmit={async (input: { kind: IssueKind; message: string }) => {
          // Backend issue endpoint lands later — for now log so the
          // submit gesture is observable in dev tools / Sentry, then
          // close. The wk-issue UX flow stays testable end to end.
          if (typeof console !== 'undefined') console.info('[wk-issue]', input)
          setIssueOpen(false)
        }}
      />
    </div>
  )
}

function formatTodayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
}
