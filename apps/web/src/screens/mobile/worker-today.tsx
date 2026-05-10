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
import { apiGet, apiPost, type BootstrapResponse } from '../../api-v1-compat.js'
import {
  MAvatar,
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MI,
  MLargeHead,
  MPill,
  MTopBar,
  initialsFor,
} from '../../components/m/index.js'
import { Sheet } from '../../components/mobile/Sheet.js'
import { formatRunningHours, timeOfDay, todayIso } from './format.js'
import { useCrewSchedule } from '../../machines/crew-schedule.js'
import { useAutoGeofenceClock, usePrimaryProjectFence } from '../../lib/geofence.js'
import { useMarkNotificationRead, useUnreadNotifications, type NotificationRow } from '../../lib/api/notifications.js'

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
          if (kind === 'in') navigate('/clockin')
        }
      } finally {
        setBusy(null)
      }
    },
    [companySlug, navigate],
  )

  const greeting = bootstrap ? `Hey, ${bootstrap.workers[0]?.name?.split(/\s+/)[0] ?? 'crew'}` : 'Hey'
  const userInitials = initialsFor(bootstrap?.workers[0]?.name ?? 'You')

  // Geofence auto-clock — wires the watcher when the worker has a fence
  // configured and hasn't disabled it. Refreshes the clock timeline when
  // either auto-in or auto-out lands so the running clock UI catches up.
  const [geofenceEnabled, setGeofenceEnabled] = useState(true)
  const { fence, projectId: fenceProjectId, projectName: fenceProjectName } = usePrimaryProjectFence(bootstrap)
  const refreshClockEvents = useCallback(() => {
    apiGet<{ events: ClockEvent[] }>(`/api/clock/timeline?date=${todayIso()}`, companySlug)
      .then((res) => setEvents(res.events ?? []))
      .catch(() => undefined)
  }, [companySlug])
  const geofence = useAutoGeofenceClock({
    enabled: geofenceEnabled,
    alreadyClockedIn: isClockedIn,
    fence,
    projectId: fenceProjectId,
    onAutoIn: () => {
      refreshClockEvents()
      navigate('/clockin')
    },
  })
  // Refresh the timeline once an exit fires (the mutation hook
  // invalidates clock query keys but our local state needs a re-fetch).
  useEffect(() => {
    if (geofence.sample && !geofence.sample.inside && isClockedIn) {
      const t = window.setTimeout(refreshClockEvents, 1500)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [geofence.sample, isClockedIn, refreshClockEvents])

  // Today's unconfirmed assignments for this worker. The bootstrap
  // ships per-company schedules, so we filter by (today, crew contains
  // me, status=draft). The first worker row is the active worker per
  // existing convention; when a real current-worker selector lands
  // this picks it up automatically.
  const today = todayIso()
  const meWorkerId = bootstrap?.workers[0]?.id ?? null
  const unconfirmedAssignments = useMemo(() => {
    if (!bootstrap || !meWorkerId) return [] as Array<BootstrapResponse['schedules'][number]>
    return bootstrap.schedules.filter((s) => {
      if (s.scheduled_for.slice(0, 10) !== today) return false
      if (s.status === 'confirmed') return false
      if (s.deleted_at) return false
      const ids = Array.isArray(s.crew) ? (s.crew as unknown[]).filter((x): x is string => typeof x === 'string') : []
      return ids.includes(meWorkerId)
    })
  }, [bootstrap, meWorkerId, today])

  const [confirmTarget, setConfirmTarget] = useState<string | null>(null)

  // Loop 2 (Field Event Escalation) worker-side: foreman replies arrive
  // here. The drain (apps/worker/src/field-event-notifier.ts) writes a
  // notifications row with kind='worker_issue_resolved' targeted at
  // recipient_clerk_user_id = the reporter, so the API query — scoped to
  // currentUserId — naturally limits this to the active worker.
  const unreadResolutions = useUnreadNotifications('worker_issue_resolved')
  const markRead = useMarkNotificationRead()
  const resolutions = unreadResolutions.data?.notifications ?? []

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
        <ForemanRepliedStack
          notifications={resolutions}
          onAck={(id) => markRead.mutate(id)}
          ackingId={markRead.isPending ? (markRead.variables ?? null) : null}
        />
        {geofence.error?.kind === 'permission_denied' ? (
          <div style={{ marginTop: 8 }}>
            <MBanner
              tone="warn"
              title="Location permission needed"
              body="Allow location access to clock in automatically when you arrive on site."
              action={
                <MButton variant="quiet" size="sm" onClick={() => navigate('/permissions/location')}>
                  Enable
                </MButton>
              }
            />
          </div>
        ) : null}
        <GeofenceChip
          enabled={geofenceEnabled}
          onToggle={() => setGeofenceEnabled((v) => !v)}
          fenceConfigured={Boolean(fence)}
          projectName={fenceProjectName}
          inside={geofence.sample?.inside ?? null}
        />
        {unconfirmedAssignments.length > 0 ? (
          <div style={{ marginTop: 8 }}>
            <MBanner
              tone="info"
              title="You have a new assignment"
              body={
                unconfirmedAssignments.length === 1
                  ? 'Tap to confirm or decline.'
                  : `${unconfirmedAssignments.length} assignments waiting for confirmation.`
              }
              action={
                <MButton variant="primary" size="sm" onClick={() => setConfirmTarget(unconfirmedAssignments[0]!.id)}>
                  Review
                </MButton>
              }
            />
          </div>
        ) : null}
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
        <FlagIssueButton onClick={() => navigate('/issue')} />
      </MBody>
      {confirmTarget ? (
        <ConfirmAssignmentSheet
          scheduleId={confirmTarget}
          companySlug={companySlug}
          projectName={
            bootstrap?.projects.find(
              (p) => p.id === unconfirmedAssignments.find((s) => s.id === confirmTarget)?.project_id,
            )?.name ?? 'Assignment'
          }
          onClose={() => setConfirmTarget(null)}
        />
      ) : null}
    </>
  )
}

interface ConfirmAssignmentSheetProps {
  scheduleId: string
  companySlug: string
  projectName: string
  onClose: () => void
}

/**
 * Worker-facing confirm/decline sheet for a single crew schedule. Wired
 * through the headless `useCrewSchedule` xstate machine — DISPATCHing
 * `CONFIRM` flips the row to `confirmed` server-side. Decline is a
 * no-op against the workflow today (the v1 reducer only models
 * draft → confirmed); the user-supplied reason is surfaced as a
 * worker-issue note so the foreman sees it in the schedule view.
 */
function ConfirmAssignmentSheet({ scheduleId, companySlug, projectName, onClose }: ConfirmAssignmentSheetProps) {
  const machine = useCrewSchedule(scheduleId, companySlug)
  const [declineReason, setDeclineReason] = useState('')
  const [submitting, setSubmitting] = useState<'confirm' | 'decline' | null>(null)

  const onConfirm = useCallback(() => {
    if (submitting) return
    setSubmitting('confirm')
    machine.dispatch('CONFIRM')
  }, [machine, submitting])

  // Watch the snapshot — once we transition to confirmed, close.
  useEffect(() => {
    if (machine.snapshot?.state === 'confirmed' && submitting === 'confirm') {
      setSubmitting(null)
      onClose()
    }
    if (!machine.isSubmitting && submitting === 'confirm' && machine.snapshot?.state !== 'confirmed') {
      setSubmitting(null)
    }
  }, [machine.snapshot, machine.isSubmitting, submitting, onClose])

  const onDecline = useCallback(() => {
    if (submitting) return
    setSubmitting('decline')
    // The crew_schedule workflow has no DECLINE event in v1 (see
    // packages/workflows/src/crew-schedule.ts). Persist the reason via
    // a worker-issue note so foreman sees it on the schedule view; the
    // v2 reducer should accept DECLINE directly. We use the existing
    // `other` kind because the worker-issues route allowlist is
    // `materials_out | crew_short | safety | other`.
    void apiPost(
      '/api/worker-issues',
      {
        kind: 'other',
        message: `Declined schedule ${scheduleId}: ${declineReason.trim() || 'no reason given'}`,
      },
      companySlug,
    ).catch(() => undefined)
    setSubmitting(null)
    onClose()
  }, [companySlug, declineReason, onClose, scheduleId, submitting])

  return (
    <Sheet open onClose={onClose} title={projectName}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {machine.error ? <MBanner tone="error" title="Couldn't confirm" body={machine.error} /> : null}
        {machine.outOfSync ? (
          <MBanner
            tone="warn"
            title="Schedule changed"
            body="The foreman moved this assignment. Re-check before confirming."
          />
        ) : null}
        <div className="m-quiet-sm">Are you good to take this on?</div>
        <MButtonRow>
          <MButton variant="primary" onClick={onConfirm} disabled={submitting !== null || machine.isLoading}>
            {submitting === 'confirm' ? 'Confirming…' : 'Confirm'}
          </MButton>
        </MButtonRow>
        <div style={{ borderTop: '1px solid var(--m-line)' }} />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="m-topbar-eyebrow">If you can't make it</span>
          <textarea
            value={declineReason}
            onChange={(e) => setDeclineReason(e.target.value)}
            placeholder="Reason (e.g. doctor's appointment)"
            rows={3}
            style={{
              border: '1px solid var(--m-line)',
              borderRadius: 12,
              padding: '10px 12px',
              fontSize: 14,
              resize: 'vertical',
              background: 'var(--m-card)',
              color: 'inherit',
            }}
          />
        </label>
        <MButtonRow>
          <MButton variant="ghost" onClick={onClose} disabled={submitting !== null}>
            Cancel
          </MButton>
          <MButton variant="quiet" onClick={onDecline} disabled={submitting !== null}>
            {submitting === 'decline' ? 'Declining…' : 'Decline'}
          </MButton>
        </MButtonRow>
      </div>
    </Sheet>
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

/**
 * Renders one MBanner per unread foreman-resolution notification, capped
 * at three rows + an "N more" line so the queue can't overrun the
 * screen. Body text is the worker drain's preformatted string —
 * "Foreman action: <action>\n\n<message>" — surfaced raw so the worker
 * sees exactly what the foreman wrote without our reformatting.
 */
function ForemanRepliedStack({
  notifications,
  onAck,
  ackingId,
}: {
  notifications: readonly NotificationRow[]
  onAck: (id: string) => void
  ackingId: string | null
}) {
  if (notifications.length === 0) return null
  const visible = notifications.slice(0, 3)
  const overflow = notifications.length - visible.length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {visible.map((n) => (
        <MBanner
          key={n.id}
          tone="info"
          title="Foreman replied"
          body={<span style={{ whiteSpace: 'pre-line' }}>{n.body_text}</span>}
          action={
            <MButton variant="quiet" size="sm" onClick={() => onAck(n.id)} disabled={ackingId === n.id}>
              {ackingId === n.id ? 'Acking…' : 'Got it'}
            </MButton>
          }
        />
      ))}
      {overflow > 0 ? (
        <div className="m-quiet-sm" style={{ paddingLeft: 4 }}>
          {overflow} more reply{overflow === 1 ? '' : 's'} waiting.
        </div>
      ) : null}
    </div>
  )
}

function GeofenceChip({
  enabled,
  onToggle,
  fenceConfigured,
  projectName,
  inside,
}: {
  enabled: boolean
  onToggle: () => void
  fenceConfigured: boolean
  projectName: string | null
  inside: boolean | null
}) {
  if (!fenceConfigured) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <MPill>Manual</MPill>
        <span className="m-quiet-sm">Geofence not set on this site.</span>
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 10,
        background: 'transparent',
        border: 'none',
        padding: 0,
        cursor: 'pointer',
      }}
    >
      <MPill tone={enabled ? (inside ? 'green' : 'accent') : undefined} dot={enabled}>
        {enabled ? (inside ? 'On site' : 'Geofence on') : 'Manual'}
      </MPill>
      <span className="m-quiet-sm">
        {enabled ? `Watching ${projectName ?? 'this site'} · tap to switch to manual` : 'Tap to enable auto clock-in'}
      </span>
    </button>
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
