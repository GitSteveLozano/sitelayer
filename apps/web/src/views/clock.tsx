import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost, enqueueOfflineMutation, FIXTURES_ENABLED } from '../api.js'
import type { BootstrapResponse, ClockEventRow, ClockPunchResponse, ClockTimelineResponse } from '../api.js'
import { Button } from '../components/ui/button.js'
import { Textarea } from '../components/ui/textarea.js'
import { toastError, toastInfo, toastSuccess } from '../components/ui/toast.js'

type ClockViewProps = {
  bootstrap: BootstrapResponse | null
  companySlug: string
}

type GeolocationSnapshot = {
  lat: number
  lng: number
  accuracy_m: number | null
  timestamp: number
}

type GeolocationOutcome = { ok: true; snapshot: GeolocationSnapshot } | { ok: false; error: string }

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatClockTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatClockLabel(event: ClockEventRow): string {
  switch (event.event_type) {
    case 'in':
      return 'Clock in'
    case 'out':
      return 'Clock out'
    case 'auto_out_geo':
      return 'Auto clock-out (left site)'
    case 'auto_out_idle':
      return 'Auto clock-out (idle)'
    default:
      return event.event_type
  }
}

async function captureLocation(): Promise<GeolocationOutcome> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return { ok: false, error: 'Geolocation is unavailable on this device.' }
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          ok: true,
          snapshot: {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy_m: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
            timestamp: position.timestamp,
          },
        })
      },
      (error) => {
        resolve({ ok: false, error: error.message || 'Location permission denied.' })
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    )
  })
}

export function ClockView({ bootstrap, companySlug }: ClockViewProps) {
  const [events, setEvents] = useState<ClockEventRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'in' | 'out' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState('')

  const projectsById = useMemo(() => {
    const map = new Map<string, string>()
    for (const project of bootstrap?.projects ?? []) {
      map.set(project.id, project.name)
    }
    return map
  }, [bootstrap?.projects])

  const loadTimeline = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiGet<ClockTimelineResponse>(`/api/clock/timeline?date=${today()}`, companySlug)
      setEvents(response.events ?? [])
      setError(null)
    } catch (caught) {
      // Non-foreman roles get 403; keep the view usable anyway.
      setEvents([])
      const message = caught instanceof Error ? caught.message : 'unknown error'
      setError(message.includes('403') ? null : message)
    } finally {
      setLoading(false)
    }
  }, [companySlug])

  useEffect(() => {
    void loadTimeline()
  }, [loadTimeline])

  const openIn = useMemo(() => {
    // Latest event: if it's an 'in', the worker is currently clocked in.
    const latest = [...events].sort((a, b) =>
      a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0,
    )[0]
    return latest && latest.event_type === 'in' ? latest : null
  }, [events])

  const handlePunch = useCallback(
    async (kind: 'in' | 'out') => {
      setBusy(kind)
      setError(null)
      try {
        const snapshot = await captureLocation()
        if (kind === 'in' && !snapshot.ok) {
          setError(snapshot.error)
          toastError('Clock in failed', snapshot.error)
          return
        }

        const body: Record<string, unknown> = {}
        if (snapshot.ok) {
          body.lat = snapshot.snapshot.lat
          body.lng = snapshot.snapshot.lng
          if (snapshot.snapshot.accuracy_m !== null) {
            body.accuracy_m = snapshot.snapshot.accuracy_m
          }
        }
        if (kind === 'out' && notes.trim()) {
          body.notes = notes.trim()
        }

        const path = `/api/clock/${kind}`
        try {
          const response = await apiPost<ClockPunchResponse>(path, body, companySlug)
          if (response?.clockEvent) {
            setEvents((current) => [...current, response.clockEvent])
          }
          if (kind === 'in') {
            toastSuccess('Clocked in')
          } else {
            if (response?.laborEntry) {
              toastSuccess('Clocked out', 'Draft labor entry created — foreman will confirm.')
            } else {
              toastSuccess('Clocked out')
            }
          }
          setNotes('')
          await loadTimeline()
        } catch (networkError) {
          // Service-worker-free fallback: the api module already queues 5xx
          // mutations. For 0/offline we catch the fetch failure here and
          // explicitly enqueue so crews can keep punching on bad LTE.
          if (
            networkError instanceof TypeError ||
            (networkError instanceof Error && /network|failed to fetch/i.test(networkError.message))
          ) {
            await enqueueOfflineMutation({
              method: 'POST',
              path,
              body,
              companySlug,
              userId: 'clock-user',
            })
            toastInfo('Saved offline', 'Punch will sync when the phone is online.')
          } else {
            throw networkError
          }
        }
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : 'unknown error'
        setError(message)
        toastError(`Clock ${kind} failed`, message)
      } finally {
        setBusy(null)
      }
    },
    [companySlug, loadTimeline, notes],
  )

  const projectLabel = openIn?.project_id ? projectsById.get(openIn.project_id) : null

  return (
    <section className="panel">
      <h2>Clock</h2>
      <p className="muted">
        Passive geofenced time tracking. Your phone location is used only to match your punch against the nearest active
        site.
      </p>

      <div className="stacked" style={{ gap: 16, marginTop: 16 }}>
        <article className="panel" data-testid="clock-status" aria-live="polite" style={{ padding: '12px 16px' }}>
          {openIn ? (
            <>
              <strong>You&rsquo;re clocked in{projectLabel ? ` at ${projectLabel}` : ''}.</strong>
              <p className="muted compact">
                Started at {formatClockTime(openIn.occurred_at)}
                {openIn.inside_geofence === false ? ' · outside geofence (needs foreman review)' : ''}
              </p>
            </>
          ) : (
            <>
              <strong>You&rsquo;re not clocked in.</strong>
              <p className="muted compact">Tap &ldquo;Clock in&rdquo; when you start on-site.</p>
            </>
          )}
        </article>

        <div className="actions" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button
            type="button"
            size="lg"
            data-testid="clock-in-button"
            disabled={busy !== null || openIn !== null}
            onClick={() => void handlePunch('in')}
          >
            {busy === 'in' ? 'Clocking in…' : 'Clock in'}
          </Button>
          <Button
            type="button"
            size="lg"
            variant="secondary"
            data-testid="clock-out-button"
            disabled={busy !== null || openIn === null}
            onClick={() => void handlePunch('out')}
          >
            {busy === 'out' ? 'Clocking out…' : 'Clock out'}
          </Button>
        </div>

        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Notes (optional) — e.g. materials stuck, left early."
          rows={2}
          aria-label="Clock-out notes"
        />

        {error ? (
          <p className="muted" role="alert">
            {error}
          </p>
        ) : null}
      </div>

      <section style={{ marginTop: 24 }}>
        <h3>Today</h3>
        {loading && events.length === 0 ? (
          <p className="muted">Loading timeline…</p>
        ) : events.length === 0 ? (
          <p className="muted">No clock events yet today.</p>
        ) : (
          <ul className="list compact" data-testid="clock-timeline">
            {[...events]
              .sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1))
              .map((event) => (
                <li key={event.id}>
                  <div className="stacked">
                    <strong>
                      {formatClockLabel(event)} · {formatClockTime(event.occurred_at)}
                    </strong>
                    <span className="muted compact">
                      {event.project_id ? (projectsById.get(event.project_id) ?? event.project_id) : 'no project'}
                      {event.inside_geofence === false ? ' · outside geofence' : ''}
                      {event.notes ? ` · ${event.notes}` : ''}
                    </span>
                  </div>
                </li>
              ))}
          </ul>
        )}
        {FIXTURES_ENABLED ? <p className="muted compact">Fixtures mode: punches are simulated.</p> : null}
      </section>
    </section>
  )
}
