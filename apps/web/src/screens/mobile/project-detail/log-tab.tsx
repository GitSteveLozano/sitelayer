/**
 * Log tab — native mobile view of the project's daily logs.
 *
 * Per the v3.3.0 estimator design (prj-detail "Log" sub-nav: "daily logs
 * from foreman — fm-log outputs land here"), this is the read surface for
 * the foreman's end-of-day reports, not a desktop link-out.
 *
 * Sources GET /api/daily-logs?project_id=… via `useDailyLogs`. Each row
 * shows the date, a status pill (draft / submitted), a notes preview, and
 * a photo count. Loading renders skeleton rows; empty is a calm hint since
 * logs only land once a foreman is on site.
 */
import type { ProjectRow } from '@/lib/api'
import { MI, MListInset, MListRow, MPill, MSectionH } from '../../../components/m/index.js'
import { MSkeletonList } from '../../../components/m-states/index.js'
import { useDailyLogs, type DailyLog } from '../../../lib/api/daily-logs.js'
import { shortDate } from '../format.js'

export function LogTab({ project }: { project: ProjectRow; navigate: (path: string) => void }) {
  const query = useDailyLogs({ projectId: project.id })

  if (query.isPending) {
    return (
      <div style={{ paddingTop: 8 }}>
        <MSectionH>Daily logs</MSectionH>
        <MSkeletonList count={3} />
      </div>
    )
  }

  if (query.isError) {
    return (
      <div style={{ paddingTop: 8 }}>
        <div style={{ padding: '0 16px' }}>
          <div
            style={{
              padding: '14px 16px',
              border: '2px solid var(--m-ink)',
              fontSize: 13,
              color: 'var(--m-red)',
            }}
          >
            Could not load daily logs. Pull to refresh or try again shortly.
          </div>
        </div>
      </div>
    )
  }

  const logs = [...(query.data?.dailyLogs ?? [])].sort((a, b) =>
    (b.occurred_on ?? '').localeCompare(a.occurred_on ?? ''),
  )

  if (logs.length === 0) {
    return (
      <div style={{ paddingTop: 8 }}>
        <div style={{ padding: '0 16px 12px' }}>
          <div
            style={{
              padding: '14px 16px',
              border: '2px solid var(--m-ink)',
              background: 'var(--m-card-soft)',
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
                marginBottom: 4,
              }}
            >
              Daily log
            </div>
            <div style={{ fontSize: 13, color: 'var(--m-ink-2)', lineHeight: 1.45 }}>
              No daily logs yet. When the foreman ends their day on site, their report — crew, scope progress, weather,
              and photos — lands here.
            </div>
          </div>
        </div>
      </div>
    )
  }

  const submittedCount = logs.filter((l) => l.status === 'submitted').length

  return (
    <div style={{ paddingTop: 8 }}>
      <MSectionH>
        {`${logs.length} ${logs.length === 1 ? 'log' : 'logs'}`}
        {submittedCount < logs.length ? ` · ${logs.length - submittedCount} draft` : ''}
      </MSectionH>
      <MListInset>
        {logs.map((log) => (
          <MListRow
            key={log.id}
            leading={<MI.FileText size={18} />}
            headline={shortDate(log.occurred_on)}
            supporting={logPreview(log)}
            trailing={
              <MPill tone={log.status === 'submitted' ? 'green' : 'amber'} dot>
                {log.status === 'submitted' ? 'Submitted' : 'Draft'}
              </MPill>
            }
          />
        ))}
      </MListInset>
    </div>
  )
}

function logPreview(log: DailyLog): string {
  const parts: string[] = []
  const notes = (log.notes ?? '').trim()
  if (notes) {
    parts.push(notes.length > 64 ? `${notes.slice(0, 64)}…` : notes)
  }
  const photoCount = Array.isArray(log.photo_keys) ? log.photo_keys.length : 0
  if (photoCount > 0) parts.push(`${photoCount} photo${photoCount === 1 ? '' : 's'}`)
  const weather = weatherSummary(log.weather)
  if (weather) parts.push(weather)
  return parts.join(' · ') || 'No notes recorded'
}

function weatherSummary(weather: unknown): string | null {
  if (weather && typeof weather === 'object') {
    const summary = (weather as { summary?: unknown }).summary
    if (typeof summary === 'string' && summary.trim()) return summary.trim()
  }
  return null
}
