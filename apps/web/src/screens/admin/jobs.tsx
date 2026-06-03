/**
 * Background jobs — read-only worker ops view (`/admin/jobs`).
 *
 * A live operations surface over GET /api/admin/jobs (useAdminJobs, 15s
 * poll). Two sections:
 *   - "Periodic jobs": the worker periodic-job fleet (job_runs) — name +
 *     status badge, last-finished relative time, duration, run/success/
 *     failure counts, next-eligible. Error rows surface first and reveal
 *     last_error.
 *   - "Queue health": mutation_outbox + sync_events drain health —
 *     pending/processing/failed/applied KPIs + humanized oldest-pending
 *     age; failed>0 and stale oldest-pending are highlighted.
 *
 * Strictly read-only — no mutations, no write actions. Full-screen
 * surface (manages its own MTopBar/MBody chrome) mounted directly in
 * App.tsx ahead of the /admin/* superadmin console catch-all, so it is
 * not swallowed by the mobile shell or the admin splat. The API enforces
 * its own gate; a non-admin just sees the error state.
 */
import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { MBody, MKpi, MKpiRow, MListInset, MListRow, MPill, MSectionH, MTopBar } from '../../components/m/index.js'
import type { MTone } from '../../components/m/list.js'
import { MEmptyState, MErrorState, MSkeletonList } from '../../components/m-states/index.js'
import { useAdminJobs, type AdminJobRun, type AdminJobStatus, type AdminQueueHealth } from '../../lib/api/index.js'

const MONO = 'var(--m-num)'

/** Threshold past which an oldest-pending queue item is "stale" (5 min). */
const STALE_PENDING_SECONDS = 300

/** Job status → badge tone (ok=green, error=red, running=blue, skipped/unknown=grey). */
function statusTone(status: AdminJobStatus): MTone | undefined {
  switch (status) {
    case 'ok':
      return 'green'
    case 'error':
      return 'red'
    case 'running':
      return 'blue'
    default:
      // skipped + unknown → grey (no tone)
      return undefined
  }
}

const STATUS_LABEL: Record<AdminJobStatus, string> = {
  ok: 'OK',
  error: 'ERROR',
  running: 'RUNNING',
  skipped: 'SKIPPED',
  unknown: 'UNKNOWN',
}

/** Sort order so error rows surface first, then running, then everything else. */
const STATUS_RANK: Record<AdminJobStatus, number> = {
  error: 0,
  running: 1,
  unknown: 2,
  skipped: 3,
  ok: 4,
}

/** "3m ago" / "2h ago" / "just now". Null → em dash. */
function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const deltaSec = Math.round((Date.now() - t) / 1000)
  if (deltaSec < 0) return formatFuture(-deltaSec)
  if (deltaSec < 45) return 'just now'
  return `${humanizeDuration(deltaSec)} ago`
}

/** "in 3m" / "in 2h" for future timestamps (next_eligible_at). */
function relativeFuture(iso: string | null): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const deltaSec = Math.round((t - Date.now()) / 1000)
  if (deltaSec <= 0) return 'now'
  return formatFuture(deltaSec)
}

function formatFuture(seconds: number): string {
  return `in ${humanizeDuration(seconds)}`
}

/** Coarse "3s" / "4m" / "2h" / "3d" magnitude for a non-negative second count. */
function humanizeDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const min = Math.round(seconds / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(seconds / 3600)
  if (hr < 48) return `${hr}h`
  const days = Math.round(seconds / 86400)
  return `${days}d`
}

/** Job duration in ms → "820ms" / "3.2s" / "1m 04s". Null → em dash. */
function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export function AdminJobsScreen() {
  const navigate = useNavigate()
  const { data, isLoading, isError, error, refetch } = useAdminJobs()

  const sortedRuns = useMemo(() => {
    const runs = data?.job_runs ?? []
    return [...runs].sort((a, b) => {
      const rank = STATUS_RANK[a.last_status] - STATUS_RANK[b.last_status]
      if (rank !== 0) return rank
      return a.job_name.localeCompare(b.job_name)
    })
  }, [data?.job_runs])

  if (isLoading) {
    return (
      <>
        <MTopBar back backLabel="Back" title="Background jobs" onBack={() => navigate(-1)} />
        <MBody>
          <MSectionH>Periodic jobs</MSectionH>
          <MSkeletonList count={6} />
        </MBody>
      </>
    )
  }

  if (isError || !data) {
    const message = error instanceof Error ? error.message : 'The jobs endpoint did not answer.'
    return (
      <>
        <MTopBar back backLabel="Back" title="Background jobs" onBack={() => navigate(-1)} />
        <MBody>
          <MErrorState
            title="Couldn’t load jobs"
            body="The worker job-health endpoint didn’t answer. This view is read-only — nothing was changed."
            code="GET /api/admin/jobs"
            detail={message}
            primaryLabel="Retry"
            onPrimary={() => void refetch()}
          />
        </MBody>
      </>
    )
  }

  const { job_runs, queues, generated_at } = data
  const generatedLabel = relativeTime(generated_at)

  return (
    <>
      <MTopBar
        back
        backLabel="Back"
        title="Background jobs"
        sub={`Worker fleet · refreshed ${generatedLabel}`}
        onBack={() => navigate(-1)}
      />
      <MBody>
        <MSectionH>Periodic jobs</MSectionH>
        {job_runs.length === 0 ? (
          <MEmptyState
            title="No jobs yet"
            body="No periodic job runs have been recorded. Once the worker fleet runs its scheduled jobs they show up here."
          />
        ) : (
          <MListInset>
            {sortedRuns.map((run) => (
              <JobRow key={`${run.job_name}:${run.scope}`} run={run} />
            ))}
          </MListInset>
        )}

        <MSectionH>Queue health</MSectionH>
        <QueueCard label="Mutation outbox" queue={queues.mutation_outbox} />
        <QueueCard label="Sync events" queue={queues.sync_events} />
      </MBody>
    </>
  )
}

function JobRow({ run }: { run: AdminJobRun }) {
  const tone = statusTone(run.last_status)
  const isError = run.last_status === 'error'

  const supporting = (
    <span>
      {run.scope ? <span style={{ color: 'var(--m-ink-3)' }}>{run.scope} · </span> : null}
      last {relativeTime(run.last_finished_at)} · {formatDurationMs(run.last_duration_ms)} · {run.run_count} run
      {run.run_count === 1 ? '' : 's'} · {run.success_count} ok · {run.failure_count} fail
      {run.skipped_count > 0 ? ` · ${run.skipped_count} skip` : ''} · next {relativeFuture(run.next_eligible_at)}
      {isError && run.last_error ? (
        <span style={{ display: 'block', marginTop: 4, color: 'var(--m-red)', fontFamily: MONO, fontSize: 11 }}>
          {run.last_error}
        </span>
      ) : null}
    </span>
  )

  return (
    <MListRow
      headline={run.job_name}
      supporting={supporting}
      trailing={
        <MPill tone={tone} dot>
          {STATUS_LABEL[run.last_status]}
        </MPill>
      }
    />
  )
}

function QueueCard({ label, queue }: { label: string; queue: AdminQueueHealth }) {
  const failed = queue.failed > 0
  const oldest = queue.oldest_pending_age_seconds
  const stale = typeof oldest === 'number' && oldest >= STALE_PENDING_SECONDS

  return (
    <div style={{ padding: '0 16px 8px' }}>
      <MKpiRow cols={2}>
        <MKpi label="Pending" value={String(queue.pending)} meta={`${queue.total} total`} />
        <MKpi label="Processing" value={String(queue.processing)} />
        <MKpi
          label="Failed"
          value={String(queue.failed)}
          meta={failed ? `${label} needs attention` : 'None'}
          metaTone={failed ? 'red' : 'green'}
        />
        <MKpi label="Applied" value={String(queue.applied)} />
      </MKpiRow>
      <div
        style={{
          marginTop: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          fontFamily: MONO,
          fontSize: 12,
          color: 'var(--m-ink-3)',
        }}
      >
        <span style={{ fontWeight: 700, color: 'var(--m-ink-2)' }}>{label}</span>
        <span>
          oldest pending{' '}
          <span style={{ color: stale ? 'var(--m-red)' : 'var(--m-ink-2)', fontWeight: 700 }}>
            {typeof oldest === 'number' ? humanizeDuration(oldest) : '—'}
          </span>
          {stale ? ' · stale' : ''}
        </span>
      </div>
    </div>
  )
}

export default AdminJobsScreen
