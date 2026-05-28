/**
 * Mobile schedule. Week view of crew schedules from bootstrap, grouped
 * by day, ordered chronologically. Tapping a day opens its detail.
 *
 * Per estimator/screenshots/sch-week.png — left rail shows day labels,
 * right side shows site cards with crew dot counts.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { apiPost, queryKeys, useCopyScheduleWeek, type BootstrapResponse } from '@/lib/api'
import { startOfWeek } from '@/lib/clock-derive'
import {
  MBanner,
  MBody,
  MButton,
  MButtonRow,
  MChip,
  MChipRow,
  MI,
  MInput,
  MSectionH,
  MSelect,
  MTopBar,
} from '../../components/m/index.js'
import { Sheet } from '../../components/mobile/Sheet.js'
import { MEmptyState } from '../../components/m-states/index.js'
import { shortDate, statusTone } from './format.js'

type Mode = 'day' | 'week'
type ScheduleRow = BootstrapResponse['schedules'][number]
type WorkerRow = BootstrapResponse['workers'][number]
type ProjectRow = BootstrapResponse['projects'][number]

export function MobileSchedule({
  bootstrap,
  companySlug,
}: {
  bootstrap: BootstrapResponse | null
  companySlug: string
}) {
  const [mode, setMode] = useState<Mode>('week')
  const [createOpen, setCreateOpen] = useState(false)
  const [createdSchedules, setCreatedSchedules] = useState<ScheduleRow[]>([])
  const [copyResult, setCopyResult] = useState<{ copied: number; skipped: number } | null>(null)

  const qc = useQueryClient()
  const copyWeek = useCopyScheduleWeek()

  // "Copy last week": clone the prior Monday→Sunday block into the current
  // week. The server returns the new rows as drafts so the foreman
  // re-confirms; days that already have an assignment for the same project
  // are left alone (idempotent at the project/day level).
  const thisMondayMs = startOfWeek(Date.now())
  const thisMondayIso = new Date(thisMondayMs).toISOString().slice(0, 10)
  const lastMondayIso = new Date(thisMondayMs - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)

  const onCopyLastWeek = async () => {
    if (copyWeek.isPending) return
    setCopyResult(null)
    try {
      const res = await copyWeek.mutateAsync({ from_monday: lastMondayIso, to_monday: thisMondayIso })
      // MobileSchedule renders from `bootstrap` (not the useSchedules
      // TanStack query), so refresh the bootstrap query the screen actually
      // consumes — re-fetched data carries the new draft rows. We also fold
      // the returned rows into local state for an immediate render, matching
      // the create-assignment optimistic path above.
      void qc.invalidateQueries({ queryKey: queryKeys.bootstrap(companySlug) })
      setCreatedSchedules((rows) => [
        ...rows,
        ...res.schedules.map((s) => ({
          id: s.id,
          project_id: s.project_id,
          scheduled_for: s.scheduled_for,
          crew: Array.isArray(s.crew) ? s.crew : [],
          status: s.status,
          version: s.version,
          deleted_at: s.deleted_at,
          created_at: s.created_at,
        })),
      ])
      setCopyResult({ copied: res.copied, skipped: res.skipped })
    } catch {
      // copyWeek.isError drives the inline error banner below
    }
  }

  const schedules = useMemo(
    () => [...(bootstrap?.schedules ?? []), ...createdSchedules],
    [bootstrap?.schedules, createdSchedules],
  )
  const projects = useMemo(() => bootstrap?.projects ?? [], [bootstrap?.projects])
  const workers = useMemo(() => bootstrap?.workers ?? [], [bootstrap?.workers])

  const byDay = useMemo(() => {
    const map = new Map<string, { date: string; entries: typeof schedules }>()
    for (const s of schedules) {
      if (s.deleted_at) continue
      const day = s.scheduled_for.slice(0, 10)
      const cur = map.get(day) ?? { date: day, entries: [] }
      cur.entries.push(s)
      map.set(day, cur)
    }
    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date))
  }, [schedules])

  const totalCrew = byDay.reduce(
    (sum, d) => sum + d.entries.reduce((c, e) => c + (Array.isArray(e.crew) ? e.crew.length : 0), 0),
    0,
  )
  const utilizationPct = byDay.length > 0 ? Math.round((totalCrew / Math.max(1, byDay.length * 8)) * 100) : 0
  const openCreate = () => setCreateOpen(true)

  if (byDay.length === 0) {
    return (
      <>
        <MTopBar title="Schedule" actionIcon={<MI.Plus size={20} />} actionLabel="New" onAction={openCreate} />
        {copyResult ? (
          <div style={{ padding: '8px 16px 0' }}>
            <MBanner
              tone="ok"
              title="Last week copied"
              body={`${copyResult.copied} ${copyResult.copied === 1 ? 'assignment' : 'assignments'} added as drafts${
                copyResult.skipped > 0 ? ` · ${copyResult.skipped} already scheduled, left alone` : ''
              }.`}
            />
          </div>
        ) : null}
        {copyWeek.isError ? (
          <div style={{ padding: '8px 16px 0' }}>
            <MBanner
              tone="error"
              title="Couldn't copy last week"
              body={copyWeek.error instanceof Error ? copyWeek.error.message : 'Try again.'}
            />
          </div>
        ) : null}
        <MEmptyState
          title="Nothing scheduled"
          body="Build a week ahead by assigning crews to projects, or copy last week's plan forward."
          primaryLabel="New assignment"
          onPrimary={openCreate}
          secondaryLabel={copyWeek.isPending ? 'Copying…' : 'Copy last week'}
          onSecondary={onCopyLastWeek}
        />
        <CreateAssignmentSheet
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          projects={projects}
          workers={workers}
          companySlug={companySlug}
          defaultDate={nextDate()}
          onCreated={(schedule) => setCreatedSchedules((rows) => [...rows, schedule])}
        />
      </>
    )
  }

  return (
    <>
      <MTopBar title="Schedule" actionIcon={<MI.Plus size={20} />} actionLabel="New" onAction={openCreate} />
      <MBody>
        <div style={{ padding: '12px 16px 4px' }}>
          <div
            style={{
              fontFamily: 'var(--m-font-display)',
              fontSize: 26,
              fontWeight: 800,
              letterSpacing: '-0.01em',
              textTransform: 'uppercase',
            }}
          >
            {byDay.length} {byDay.length === 1 ? 'DAY' : 'DAYS'}
          </div>
          <div
            style={{
              marginTop: 4,
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
            }}
          >
            {totalCrew} CREW ASSIGNMENTS · ~{utilizationPct}% UTILIZATION
          </div>
        </div>
        <MChipRow>
          <MChip active={mode === 'day'} onClick={() => setMode('day')}>
            Day
          </MChip>
          <MChip active={mode === 'week'} onClick={() => setMode('week')}>
            Week
          </MChip>
        </MChipRow>
        {mode === 'week' ? (
          <div style={{ padding: '4px 16px 0', display: 'flex', justifyContent: 'flex-end' }}>
            <MButton variant="ghost" size="sm" onClick={onCopyLastWeek} disabled={copyWeek.isPending}>
              {copyWeek.isPending ? 'Copying…' : 'Copy last week'}
            </MButton>
          </div>
        ) : null}
        {copyResult ? (
          <div style={{ padding: '8px 16px 0' }}>
            <MBanner
              tone="ok"
              title="Last week copied"
              body={`${copyResult.copied} ${copyResult.copied === 1 ? 'assignment' : 'assignments'} added as drafts${
                copyResult.skipped > 0 ? ` · ${copyResult.skipped} already scheduled, left alone` : ''
              }.`}
            />
          </div>
        ) : null}
        {copyWeek.isError ? (
          <div style={{ padding: '8px 16px 0' }}>
            <MBanner
              tone="error"
              title="Couldn't copy last week"
              body={copyWeek.error instanceof Error ? copyWeek.error.message : 'Try again.'}
            />
          </div>
        ) : null}
        <MSectionH>This week</MSectionH>
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ borderTop: '2px solid var(--m-ink)', borderBottom: '2px solid var(--m-ink)' }}>
            {byDay.slice(0, mode === 'day' ? 1 : 7).map((d) => (
              <DayCard
                key={d.date}
                date={d.date}
                entries={d.entries.map((e) => ({
                  id: e.id,
                  project: projects.find((p) => p.id === e.project_id)?.name ?? 'Unknown project',
                  crewCount: Array.isArray(e.crew) ? e.crew.length : 0,
                  status: e.status,
                }))}
              />
            ))}
          </div>
        </div>
      </MBody>
      <CreateAssignmentSheet
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projects={projects}
        workers={workers}
        companySlug={companySlug}
        defaultDate={byDay[0]?.date ?? nextDate()}
        onCreated={(schedule) => setCreatedSchedules((rows) => [...rows, schedule])}
      />
    </>
  )
}

function CreateAssignmentSheet({
  open,
  onClose,
  projects,
  workers,
  companySlug,
  defaultDate,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  projects: readonly ProjectRow[]
  workers: readonly WorkerRow[]
  companySlug: string
  defaultDate: string
  onCreated: (schedule: ScheduleRow) => void
}) {
  const eligibleProjects = useMemo(() => projects.filter((p) => /accepted|progress|active/i.test(p.status)), [projects])
  const [projectId, setProjectId] = useState('')
  const [scheduledFor, setScheduledFor] = useState(defaultDate)
  const [pickedCrew, setPickedCrew] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setScheduledFor(defaultDate)
    setError(null)
  }, [defaultDate, open])

  const toggleCrew = (workerId: string) => {
    setPickedCrew((prev) => {
      const next = new Set(prev)
      if (next.has(workerId)) next.delete(workerId)
      else next.add(workerId)
      return next
    })
  }

  const resetAndClose = () => {
    setProjectId('')
    setPickedCrew(new Set())
    setError(null)
    onClose()
  }

  const save = async () => {
    setError(null)
    if (!projectId) {
      setError('Pick a project')
      return
    }
    if (!scheduledFor) {
      setError('Pick a date')
      return
    }
    setSaving(true)
    try {
      const schedule = await apiPost<ScheduleRow>(
        '/api/schedules',
        {
          project_id: projectId,
          scheduled_for: scheduledFor,
          crew: Array.from(pickedCrew),
          status: 'draft',
        },
        companySlug,
      )
      onCreated(schedule)
      resetAndClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onClose={resetAndClose} title="New assignment" className="max-w-[720px] mx-auto">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Project">
          <MSelect value={projectId} onChange={(e) => setProjectId(e.currentTarget.value)}>
            <option value="">Select project</option>
            {eligibleProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </MSelect>
        </Field>

        <Field label="Date">
          <MInput type="date" value={scheduledFor} onChange={(e) => setScheduledFor(e.currentTarget.value)} />
        </Field>

        <Field label={`Crew${pickedCrew.size > 0 ? ` (${pickedCrew.size})` : ''}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '34dvh', overflowY: 'auto' }}>
            {workers.length === 0 ? (
              <div className="m-quiet-sm">No workers on the roster.</div>
            ) : (
              workers.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  onClick={() => toggleCrew(w.id)}
                  style={{
                    border: '1px solid var(--m-line)',
                    background: pickedCrew.has(w.id) ? 'var(--m-accent-soft)' : 'var(--m-card)',
                    borderRadius: 12,
                    padding: '10px 12px',
                    color: 'inherit',
                    font: 'inherit',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    textAlign: 'left',
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 14, fontWeight: 650 }}>{w.name}</span>
                    <span className="m-quiet-sm">{w.role}</span>
                  </span>
                  {pickedCrew.has(w.id) ? <MI.Check size={18} color="var(--m-accent)" /> : null}
                </button>
              ))
            )}
          </div>
        </Field>

        <Field label="Foreman">
          <div
            style={{
              border: '1px solid var(--m-line)',
              borderRadius: 12,
              padding: '11px 12px',
              color: 'var(--m-ink-2)',
              fontSize: 14,
              background: 'var(--m-card-soft)',
            }}
          >
            Uses the assigned project foreman
          </div>
        </Field>

        {error ? <div style={{ color: 'var(--m-red)', fontSize: 13 }}>{error}</div> : null}

        <MButtonRow>
          <MButton variant="ghost" onClick={resetAndClose} disabled={saving}>
            Cancel
          </MButton>
          <MButton variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </MButton>
        </MButtonRow>
      </div>
    </Sheet>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="m-topbar-eyebrow">{label}</span>
      {children}
    </label>
  )
}

type DayEntry = {
  id: string
  project: string
  crewCount: number
  status: string
}

// Two-letter mono badge code from a project name (e.g. "Hillcrest Ph 4" → "HP").
function projectCode(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '··'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

const STRIPE_COLOR: Record<string, string> = {
  green: 'var(--m-green)',
  red: 'var(--m-red)',
  amber: 'var(--m-amber)',
  blue: 'var(--m-blue)',
}

function DayCard({ date, entries }: { date: string; entries: readonly DayEntry[] }) {
  return (
    <div style={{ padding: '14px 0', borderTop: '1px solid var(--m-line-2)' }}>
      <div
        style={{
          fontFamily: 'var(--m-num)',
          fontSize: 12,
          fontWeight: 800,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--m-ink)',
        }}
      >
        {shortDate(date)}
      </div>
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.map((e) => (
          <div
            key={e.id}
            style={{
              padding: '10px 12px',
              background: 'var(--m-card-soft)',
              border: '2px solid var(--m-ink)',
              borderLeft: `6px solid ${STRIPE_COLOR[statusTone(e.status) ?? ''] ?? 'var(--m-accent)'}`,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 800,
                width: 24,
                flexShrink: 0,
              }}
            >
              {projectCode(e.project)}
            </div>
            <div
              style={{
                fontFamily: 'var(--m-num)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {e.project} · {e.crewCount} CREW
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function nextDate(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}
