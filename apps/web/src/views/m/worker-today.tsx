/**
 * Worker home — `wk-today` per the worker README. Dark theme. Big running
 * clock when clocked in, "Heading to site" pre-shift state, "Off-clock"
 * between-shifts state. Crew-on-site avatars + scope summary + flag-issue
 * ghost button.
 *
 * The auto-clock-in flow (`wk-clockin`) lives next to this — when a punch
 * succeeds via the geofence, we navigate to /m/clockin with the event id;
 * otherwise this screen handles manual punches.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost, type BootstrapResponse } from '../../api.js'
import { MAvatar, MBody, MButton, MButtonRow, MI, MLargeHead, MTopBar, initialsFor } from '../../components/m/index.js'
import { formatRunningHours, timeOfDay, todayIso } from './format.js'

type ClockEvent = {
  id: string
  worker_id: string | null
  project_id: string | null
  event_type: 'in' | 'out' | 'auto_out_geo' | 'auto_out_idle'
  occurred_at: string
  lat: string | null
  lng: string | null
}

export function WorkerToday({ bootstrap, companySlug }: { bootstrap: BootstrapResponse | null; companySlug: string }) {
  const navigate = useNavigate()
  const [events, setEvents] = useState<readonly ClockEvent[]>([])
  const [busy, setBusy] = useState<'in' | 'out' | null>(null)
  const [tick, setTick] = useState(() => Date.now())

  // Tick once a second so the running clock updates.
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  // Pull today's clock events.
  useEffect(() => {
    let cancelled = false
    apiGet<{ events: ClockEvent[] }>(`/api/clock/timeline?date=${todayIso()}`, companySlug)
      .then((res) => {
        if (!cancelled) setEvents(res.events ?? [])
      })
      .catch(() => {
        // Non-fatal — render an empty timeline. Workers without an assigned
        // worker row see a 403; we surface that as a no-events state.
        if (!cancelled) setEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [companySlug])

  const latest = useMemo(() => {
    return [...events].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0))[0]
  }, [events])

  const isClockedIn = latest?.event_type === 'in'
  const project = bootstrap?.projects.find((p) => p.id === latest?.project_id)
  const elapsedSec = isClockedIn && latest ? Math.floor((tick - new Date(latest.occurred_at).valueOf()) / 1000) : 0

  const handlePunch = useCallback(
    async (kind: 'in' | 'out') => {
      setBusy(kind)
      try {
        const body: Record<string, unknown> = {}
        const snapshot = await captureLocation()
        if (snapshot) {
          body.lat = snapshot.lat
          body.lng = snapshot.lng
          if (snapshot.accuracy_m !== null) body.accuracy_m = snapshot.accuracy_m
        }
        const res = await apiPost<{ clockEvent?: ClockEvent }>(`/api/clock/${kind}`, body, companySlug)
        if (res.clockEvent) {
          setEvents((cur) => [...cur, res.clockEvent!])
          if (kind === 'in') navigate('/m/clockin')
        }
      } finally {
        setBusy(null)
      }
    },
    [companySlug, navigate],
  )

  const greeting = bootstrap ? `Hey, ${bootstrap.workers[0]?.name?.split(/\s+/)[0] ?? 'crew'}` : 'Hey'
  const userInitials = initialsFor(bootstrap?.workers[0]?.name ?? 'You')

  return (
    <>
      <MTopBar
        title="Today"
        eyebrow={greeting.toUpperCase()}
        actionIcon={<MI.Settings size={20} />}
        actionLabel="Settings"
      />
      <MBody pad>
        <MLargeHead
          title={new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          right={<MAvatar initials={userInitials} tone="2" />}
        />
        {isClockedIn && project ? (
          <ClockedInCard
            project={project.name}
            scope={project.division_code}
            startedAt={latest.occurred_at}
            elapsedSec={elapsedSec}
            onClockOut={() => handlePunch('out')}
            busy={busy === 'out'}
          />
        ) : (
          <OffClockCard onClockIn={() => handlePunch('in')} busy={busy === 'in'} />
        )}
        <FlagIssueButton onClick={() => navigate('/m/issue')} />
      </MBody>
    </>
  )
}

function ClockedInCard({
  project,
  scope,
  startedAt,
  elapsedSec,
  onClockOut,
  busy,
}: {
  project: string
  scope: string
  startedAt: string
  elapsedSec: number
  onClockOut: () => void
  busy: boolean
}) {
  const hrsMin = formatRunningHours(elapsedSec)
  const sec = (elapsedSec % 60).toString().padStart(2, '0')
  return (
    <div className="m-card" style={{ marginTop: 12, marginBottom: 16 }}>
      <div className="m-topbar-eyebrow">TODAY'S JOB</div>
      <div style={{ fontSize: 19, fontWeight: 600 }}>{project}</div>
      <div className="m-quiet-sm">{scope}</div>
      <div style={{ borderTop: '1px solid var(--m-line)', margin: '12px 0' }} />
      <div className="m-topbar-eyebrow" style={{ textAlign: 'center' }}>
        CURRENTLY CLOCKED IN
      </div>
      <div
        className="num"
        style={{
          textAlign: 'center',
          fontSize: 60,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          lineHeight: 1,
          margin: '4px 0 4px',
        }}
      >
        {hrsMin}
        <span style={{ fontSize: 26, color: 'var(--m-ink-3)' }}>:{sec}</span>
      </div>
      <div className="m-quiet-sm" style={{ textAlign: 'center', marginTop: 4 }}>
        Started {timeOfDay(startedAt)}
      </div>
      <div style={{ height: 12 }} />
      <MButtonRow>
        <MButton variant="quiet" disabled>
          Break
        </MButton>
        <MButton variant="primary" onClick={onClockOut} disabled={busy}>
          {busy ? 'Clocking out…' : 'Clock out'}
        </MButton>
      </MButtonRow>
    </div>
  )
}

function OffClockCard({ onClockIn, busy }: { onClockIn: () => void; busy: boolean }) {
  return (
    <div className="m-card" style={{ marginTop: 12, marginBottom: 16, textAlign: 'center' }}>
      <div className="m-topbar-eyebrow" style={{ marginBottom: 8 }}>
        OFF CLOCK
      </div>
      <div style={{ fontSize: 17, fontWeight: 500, marginBottom: 4 }}>You're not clocked in</div>
      <div className="m-quiet-sm" style={{ marginBottom: 16 }}>
        Drive into a site geofence and the app will clock you in automatically.
      </div>
      <MButton variant="primary" onClick={onClockIn} disabled={busy}>
        {busy ? 'Clocking in…' : 'Clock in manually'}
      </MButton>
    </div>
  )
}

function FlagIssueButton({ onClick }: { onClick: () => void }) {
  return (
    <MButton variant="ghost" onClick={onClick}>
      <MI.AlertTri size={18} />
      Flag an issue
    </MButton>
  )
}

async function captureLocation(): Promise<{ lat: number; lng: number; accuracy_m: number | null } | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 30_000 },
    )
  })
}
