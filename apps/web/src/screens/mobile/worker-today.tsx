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
import { apiGet, apiPost, type BootstrapResponse } from '@/lib/api'
import {
  MAvatar,
  MAvatarGroup,
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MI,
  MLargeHead,
  MListInset,
  MListRow,
  MPill,
  MSectionH,
  MTopBar,
  avatarToneFor,
  initialsFor,
} from '../../components/m/index.js'
import { MPermissionState } from '../../components/m-states/index.js'
import { Sheet } from '../../components/mobile/Sheet.js'
import { formatRunningHours, timeOfDay, todayIso } from './format.js'
import { useCrewSchedule } from '../../machines/crew-schedule.js'
import { useAutoGeofenceClock, useIdleAutoClockOut, usePrimaryProjectFence } from '../../lib/geofence.js'
import { useMarkNotificationRead, useUnreadNotifications, type NotificationRow } from '../../lib/api/notifications.js'
import { useProjectBriefs } from '../../lib/api/projects.js'
import type { ProjectBriefStep } from '../../lib/api/project-briefs.js'
import { stepStatus } from './worker-scope-steps.js'

// The worker is "approaching daily overtime" once the running shift
// passes this many seconds. 7h30m per the wk-today edge-case spec.
const APPROACHING_OT_SEC = 7 * 3600 + 30 * 60

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
  const approachingOt = isClockedIn && elapsedSec >= APPROACHING_OT_SEC

  // Crew on site — derive from the company-wide clock timeline. The
  // timeline returns every worker's events for the date when no
  // worker_id filter is applied; we reduce to "currently in" by keeping
  // the most-recent event per worker and selecting those still clocked
  // in. Names + tones come from the bootstrap worker roster.
  const crewOnSite = useMemo(() => {
    const latestByWorker = new Map<string, ClockEvent>()
    for (const e of events) {
      if (!e.worker_id) continue
      const prev = latestByWorker.get(e.worker_id)
      if (!prev || prev.occurred_at < e.occurred_at) latestByWorker.set(e.worker_id, e)
    }
    const meWorkerId = bootstrap?.workers[0]?.id ?? null
    return [...latestByWorker.values()]
      .filter((e) => e.event_type === 'in')
      .map((e) => {
        const worker = bootstrap?.workers.find((w) => w.id === e.worker_id)
        const name = worker?.name ?? 'Crew'
        return {
          id: e.worker_id as string,
          name,
          initials: initialsFor(name),
          isMe: e.worker_id === meWorkerId,
        }
      })
      .sort((a, b) => (a.isMe === b.isMe ? 0 : a.isMe ? -1 : 1))
  }, [events, bootstrap?.workers])

  // Today's brief for the clocked-in project — gives us the foreman
  // attribution ("scoped by …") and the scope-summary card. The brief
  // is the same record `wk-scope` reads; we only need the headline bits.
  const briefQuery = useProjectBriefs(project?.id ?? null, todayIso())
  const brief = briefQuery.data?.briefs?.[0] ?? null
  const briefSteps = useMemo<ProjectBriefStep[]>(
    () => (brief && Array.isArray(brief.steps) ? (brief.steps as ProjectBriefStep[]) : []),
    [brief],
  )
  const foremanName = useMemo(
    () => bootstrap?.workers.find((w) => /lead|foreman/i.test(w.role ?? ''))?.name ?? null,
    [bootstrap?.workers],
  )

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
          // The manual clock-IN entry now lives on the pre-punch
          // `/clockin/manual` form (site picker + reason), so a punch that
          // reaches here is an out — route it to the end-of-shift wrap-up.
          // (The auto-geofence path uses `/clockin` directly via onAutoIn.)
          if (kind === 'out') navigate('/clockout')
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

  // Idle auto clock-OUT — arms an inactivity timer while clocked in under
  // the same auto policy. Any tap/key/touch or an in-fence GPS reading
  // resets it; after the threshold elapses it fires
  // POST /api/clock/out with auto_out_reason='idle'
  // (→ event_type='auto_out_idle'). Refresh the timeline so the running
  // clock UI flips to off-clock and the auto_out_idle row shows.
  const idle = useIdleAutoClockOut({
    enabled: geofenceEnabled,
    alreadyClockedIn: isClockedIn,
    presence: geofence.sample,
    lastSample: geofence.sample,
    onAutoOut: refreshClockEvents,
  })

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

  // Today's scheduled assignment for this worker (any status) — drives the
  // pre-shift "SCHEDULED · 7:00 AM" framing on the off-clock card (msg43).
  // We surface the scheduled time + the project's scope so the off-clock
  // state reads as "you have a shift here today", not a generic prompt.
  const todaysShift = useMemo(() => {
    if (!bootstrap || !meWorkerId) return null
    const match = bootstrap.schedules
      .filter((s) => {
        if (s.scheduled_for.slice(0, 10) !== today) return false
        if (s.deleted_at) return false
        const ids = Array.isArray(s.crew) ? (s.crew as unknown[]).filter((x): x is string => typeof x === 'string') : []
        return ids.includes(meWorkerId)
      })
      .sort((a, b) => (a.scheduled_for < b.scheduled_for ? -1 : 1))[0]
    if (!match) return null
    const proj = bootstrap.projects.find((p) => p.id === match.project_id)
    return {
      scheduledFor: match.scheduled_for,
      projectName: proj?.name ?? null,
      scope: proj?.division_code ?? null,
    }
  }, [bootstrap, meWorkerId, today])

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
      {/* Header bell → crew inbox (msg__80 "CREW · INBOX"), audit M11. */}
      <MTopBar
        title="Today"
        eyebrow={greeting.toUpperCase()}
        actionIcon={<MI.Settings size={20} />}
        actionLabel="Settings"
        onBell={() => navigate('/notifications')}
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
          <div style={{ margin: '8px -16px 0' }}>
            <MPermissionState
              title="Location is off."
              body="We can’t auto clock-in or show the crew map without it. You can still log time manually."
              benefits={['Auto clock-in on arrival', 'Live crew map', 'Out-of-fence alerts']}
              icon={<MI.MapPin size={30} />}
              primaryLabel="Open settings"
              onPrimary={() => navigate('/permissions/location')}
              secondaryLabel="Clock in manually"
              onSecondary={() => navigate('/clockin/manual')}
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
          <>
            <ClockedInCard
              project={project.name}
              scope={project.division_code}
              startedAt={latest.occurred_at}
              elapsedSec={elapsedSec}
              approachingOt={approachingOt}
              foremanName={foremanName}
              onClockOut={() => handlePunch('out')}
              busy={busy === 'out'}
            />
            <CrewOnSite crew={crewOnSite} />
            <ScopeSummaryCard
              scope={project.division_code}
              steps={briefSteps}
              hasBrief={Boolean(brief)}
              onTap={() => navigate('/scope')}
            />
          </>
        ) : (
          <>
            {latest?.event_type === 'auto_out_idle' || idle.firedIdleOut ? (
              <div style={{ marginTop: 8 }}>
                <MBanner
                  tone="info"
                  title="Clocked out for inactivity"
                  body="You were clocked out automatically after a stretch of no activity on site. Clock back in if you're still working."
                />
              </div>
            ) : latest?.event_type === 'auto_out_geo' ? (
              <div style={{ marginTop: 8 }}>
                <MBanner
                  tone="info"
                  title="Clocked out — left the site"
                  body="You were clocked out automatically when you left the project geofence."
                />
              </div>
            ) : null}
            <OffClockCard
              onClockIn={() => navigate('/clockin/manual')}
              shift={todaysShift}
              distanceMeters={geofence.sample && !geofence.sample.inside ? geofence.sample.distance_m : null}
              autoClockInEnabled={geofenceEnabled}
              onToggleAutoClockIn={fence ? () => setGeofenceEnabled((v) => !v) : undefined}
            />
          </>
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
 * `CONFIRM` flips the row to `confirmed` and DISPATCHing `DECLINE`
 * (carrying the reason) flips it to `declined` server-side. The decline
 * now emits a `notify_foreman_decline` outbox side effect (drained by
 * the worker, surfaced in-band to the foreman) — replacing the old
 * out-of-band /api/worker-issues note.
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

  // Watch the snapshot — once we transition to a terminal/handled state, close.
  useEffect(() => {
    const settled = machine.snapshot?.state === 'confirmed' || machine.snapshot?.state === 'declined'
    if (settled && submitting) {
      setSubmitting(null)
      onClose()
    }
    if (!machine.isSubmitting && submitting && !settled) {
      setSubmitting(null)
    }
  }, [machine.snapshot, machine.isSubmitting, submitting, onClose])

  const onDecline = useCallback(() => {
    if (submitting) return
    setSubmitting('decline')
    // DECLINE is now a real workflow transition (draft → declined). The
    // reason rides on the event; the server enqueues notify_foreman_decline
    // so the foreman is told in-band. The close-watcher effect above
    // dismisses the sheet once the snapshot reports `declined`.
    machine.dispatch('DECLINE', declineReason.trim() || 'no reason given')
  }, [declineReason, machine, submitting])

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
  approachingOt,
  foremanName,
  onClockOut,
  busy,
}: {
  project: string
  scope: string
  startedAt: string
  elapsedSec: number
  approachingOt: boolean
  foremanName: string | null
  onClockOut: () => void
  busy: boolean
}) {
  const hrsMin = formatRunningHours(elapsedSec)
  const sec = (elapsedSec % 60).toString().padStart(2, '0')
  return (
    <div style={{ marginTop: 12, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ON SITE · <project> eyebrow + scope headline */}
      <div>
        <div
          className="m-topbar-eyebrow"
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
        >
          <span style={{ color: 'var(--m-accent)' }}>ON SITE · {project.toUpperCase()}</span>
          {foremanName ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, textTransform: 'none' }}>
              <MAvatar initials={initialsFor(foremanName)} size="sm" />
              <span style={{ color: 'var(--m-ink-4)', fontSize: 11 }}>scoped by {foremanName.split(/\s+/)[0]}</span>
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 700,
            fontSize: 22,
            letterSpacing: '-0.015em',
            lineHeight: 1.1,
            marginTop: 10,
          }}
        >
          {scope}
        </div>
      </div>

      {/* TODAY'S JOB status block — 2px-bordered, giant tabular timer */}
      <div
        style={{
          border: '2px solid var(--m-line)',
          padding: '24px 20px',
          textAlign: 'center',
        }}
      >
        <div className="m-topbar-eyebrow" style={{ color: 'var(--m-ink-4)' }}>
          CLOCKED IN
        </div>
        <div
          className="num"
          style={{
            fontFamily: 'var(--m-font-display)',
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            fontSize: 80,
            letterSpacing: '-0.03em',
            lineHeight: 1,
            margin: '12px 0 0',
          }}
        >
          {hrsMin}
          <span style={{ fontSize: 32, color: 'var(--m-ink-4)' }}>:{sec}</span>
        </div>
        <div
          className="m-topbar-eyebrow"
          style={{ color: 'var(--m-ink-4)', marginTop: 12, textTransform: 'none', fontSize: 11 }}
        >
          Started {timeOfDay(startedAt)}
        </div>
        {approachingOt ? (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
            <MPill tone="amber" dot>
              Approaching daily OT
            </MPill>
          </div>
        ) : null}
      </div>

      {/* BREAK (ghost) + CLOCK OUT (danger) split — 64px gloved buttons, shared 2px border */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: '2px solid var(--m-line)' }}>
        <MButton
          variant="ghost"
          data-size="worker"
          disabled
          style={{ border: 'none', borderRight: '2px solid var(--m-line)' }}
        >
          Break
        </MButton>
        <MButton
          variant={'danger' as 'primary'}
          data-size="worker"
          onClick={onClockOut}
          disabled={busy}
          style={{ border: 'none' }}
        >
          {busy ? 'Clocking out…' : 'Clock out'}
        </MButton>
      </div>
    </div>
  )
}

/**
 * CREW ON SITE — `wk-today` section. Avatar group of everyone currently
 * clocked in on the worker's site, "you" first. Renders nothing when
 * only the worker (or no one) is on site so the screen stays calm.
 */
function CrewOnSite({ crew }: { crew: ReadonlyArray<{ id: string; name: string; initials: string; isMe: boolean }> }) {
  if (crew.length === 0) return null
  return (
    <div style={{ marginBottom: 16 }}>
      <MSectionH>{`Crew on site (${crew.length})`}</MSectionH>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 2px' }}>
        <MAvatarGroup
          avatars={crew.map((c) => ({
            initials: c.initials,
            tone: c.isMe ? undefined : avatarToneFor(c.id),
          }))}
          max={5}
          size="lg"
        />
        <span className="m-quiet-sm" style={{ minWidth: 0 }}>
          {crew
            .map((c) => (c.isMe ? `${c.name.split(/\s+/)[0]} (you)` : c.name.split(/\s+/)[0]))
            .slice(0, 3)
            .join(' · ')}
          {crew.length > 3 ? ` +${crew.length - 3}` : ''}
        </span>
      </div>
    </div>
  )
}

/**
 * Collapsed today's-scope summary card on `wk-today`. Shows the scope
 * line + "N of M steps done" and taps through to `wk-scope`. Step
 * completion uses the optional `status` field the foreman UI may set on
 * a brief step; absent that we treat nothing as done so we never
 * over-report progress.
 */
function ScopeSummaryCard({
  scope,
  steps,
  hasBrief,
  onTap,
}: {
  scope: string
  steps: ProjectBriefStep[]
  hasBrief: boolean
  onTap: () => void
}) {
  const total = steps.length
  const done = steps.filter((s) => stepStatus(s) === 'done').length
  const supporting = !hasBrief
    ? 'Tap to view — brief loads here when sent'
    : total > 0
      ? `${done} of ${total} step${total === 1 ? '' : 's'} done`
      : 'Tap to view today’s scope'
  return (
    <div style={{ marginBottom: 16 }}>
      <MSectionH>Today's scope</MSectionH>
      <MListInset>
        <MListRow leading={<MI.Layers size={18} />} headline={scope} supporting={supporting} chev onTap={onTap} />
      </MListInset>
    </div>
  )
}

/**
 * Off-clock / pre-shift card — `wk-today` not-clocked-in state (msg43).
 * When the worker has a scheduled shift today this reframes as
 * "SCHEDULED · 7:00 AM" with the site + scope headline, a NOT CLOCKED IN
 * slab, a "WALK TO SITE · 0.4 MI AWAY" distance line (when a live fence
 * reading is available), an AUTO CLOCK-IN ON ARRIVAL toggle row, and the
 * CLOCK IN MANUALLY button. With no scheduled shift it falls back to the
 * generic off-clock prompt.
 */
function OffClockCard({
  onClockIn,
  shift,
  distanceMeters,
  autoClockInEnabled,
  onToggleAutoClockIn,
}: {
  onClockIn: () => void
  shift: { scheduledFor: string; projectName: string | null; scope: string | null } | null
  distanceMeters: number | null
  autoClockInEnabled: boolean
  onToggleAutoClockIn?: (() => void) | undefined
}) {
  const headline =
    shift && (shift.projectName || shift.scope)
      ? [shift.projectName, shift.scope].filter(Boolean).join(' · ')
      : "You're not clocked in"
  const milesAway = distanceMeters != null ? (distanceMeters / 1609.34).toFixed(1) : null
  return (
    <div style={{ marginTop: 12, marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {shift ? (
        <div>
          <div className="m-topbar-eyebrow" style={{ color: 'var(--m-ink-4)' }}>
            SCHEDULED · {timeOfDay(shift.scheduledFor)}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 700,
              fontSize: 22,
              letterSpacing: '-0.015em',
              lineHeight: 1.1,
              marginTop: 10,
            }}
          >
            {headline}
          </div>
        </div>
      ) : null}
      <div style={{ border: '2px solid var(--m-line)', padding: '24px 20px', textAlign: 'center' }}>
        <div className="m-topbar-eyebrow" style={{ color: 'var(--m-ink-4)' }}>
          NOT CLOCKED IN
        </div>
        {!shift ? (
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontWeight: 700,
              fontSize: 22,
              letterSpacing: '-0.015em',
              lineHeight: 1.1,
              margin: '12px 0 8px',
            }}
          >
            {headline}
          </div>
        ) : null}
        <div
          className="m-topbar-eyebrow"
          style={{ color: 'var(--m-ink-4)', textTransform: 'none', fontSize: 11, lineHeight: 1.4, marginTop: 12 }}
        >
          {milesAway != null ? (
            <span style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Walk to site · {milesAway} mi away
            </span>
          ) : (
            'Drive into a site geofence and the app will clock you in automatically.'
          )}
        </div>
      </div>
      {onToggleAutoClockIn ? (
        <button
          type="button"
          onClick={onToggleAutoClockIn}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            border: '2px dashed var(--m-line)',
            background: 'transparent',
            padding: '12px 16px',
            cursor: 'pointer',
            color: 'inherit',
            textAlign: 'left',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              border: '2px solid var(--m-line)',
              background: autoClockInEnabled ? 'var(--m-accent)' : 'transparent',
            }}
          />
          <span
            className="m-topbar-eyebrow"
            style={{ color: 'var(--m-ink-3)', textTransform: 'uppercase', fontSize: 11 }}
          >
            Auto clock-in on arrival
          </span>
        </button>
      ) : null}
      <MButton variant="primary" data-size="worker" onClick={onClockIn}>
        Clock in manually
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
