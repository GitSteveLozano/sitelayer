import { MBanner } from './banner.js'

/**
 * Submitted-confirmation surface for the foreman daily log (design
 * `msg__41` / CONFORMANCE M06). Pure render of the already-persisted
 * `submitted_at` — no data fetching, no business state. The `daily_log`
 * reducer is terminal at `submitted` (no UNSUBMIT), so there is no
 * resubmit affordance here: corrections route through admin. The parent
 * decides whether to show this by reading `snapshot.state === 'submitted'`
 * (or `log.status === 'submitted'`); this component just renders it.
 */

export type DailyLogWeekEntry = {
  /** YYYY-MM-DD */
  occurred_on: string
  status: 'draft' | 'submitted'
}

export type DailyLogSubmittedBannerProps = {
  /** ISO timestamp persisted on submit; rendered HH:MM. */
  submittedAt: string | null
  /**
   * PM/reviewer display name for the "<name> will review" copy. Falls
   * back to "Your PM" when unknown (v1 static copy is acceptable).
   */
  reviewerName?: string | null
  /**
   * Optional week window for the "WEEK OF …" strip — the foreman's logs
   * for the current week as draft/submitted dots. Omit to hide the strip.
   */
  weekLogs?: DailyLogWeekEntry[]
}

/** Format an ISO timestamp to a local HH:MM, or em-dash when missing. */
function formatHhMm(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function weekRangeLabel(entries: DailyLogWeekEntry[]): string {
  const days = entries
    .map((e) => e.occurred_on)
    .filter(Boolean)
    .sort()
  if (days.length === 0) return ''
  const first = days[0]!
  const last = days[days.length - 1]!
  return first === last ? first : `${first} – ${last}`
}

export function DailyLogSubmittedBanner({ submittedAt, reviewerName, weekLogs }: DailyLogSubmittedBannerProps) {
  const reviewer = reviewerName?.trim() || 'Your PM'
  // Local YYYY-MM-DD of the just-submitted log, so the strip can mark "today".
  const submittedDay = (() => {
    if (!submittedAt) return null
    const d = new Date(submittedAt)
    if (Number.isNaN(d.getTime())) return null
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  })()
  const submittedCount = (weekLogs ?? []).filter((e) => e.status === 'submitted').length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <MBanner
        tone="ok"
        title={`Submitted ${formatHhMm(submittedAt)}`}
        body={<>{reviewer} will review. Usually within 2 hours.</>}
      />
      {weekLogs && weekLogs.length > 0 ? (
        <div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              marginBottom: 8,
            }}
          >
            Week of {weekRangeLabel(weekLogs)} · Logs
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[...weekLogs]
              .sort((a, b) => a.occurred_on.localeCompare(b.occurred_on))
              .map((entry) => {
                const day = new Date(`${entry.occurred_on}T00:00:00`)
                const label = Number.isNaN(day.getTime()) ? '' : WEEKDAYS[day.getDay()]
                const done = entry.status === 'submitted'
                const isToday = entry.occurred_on === submittedDay
                return (
                  <div
                    key={entry.occurred_on}
                    title={`${entry.occurred_on} · ${entry.status}`}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: 5,
                      minWidth: 30,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--m-num)',
                        fontSize: 10,
                        fontWeight: 700,
                        color: 'var(--m-ink-3)',
                      }}
                    >
                      {label}
                    </span>
                    {/* Hard square cells — ✓ for submitted, accent dot for the
                        just-submitted day, em-dash for not-yet (design msg__41). */}
                    <span
                      aria-hidden
                      style={{
                        width: 30,
                        height: 30,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: '2px solid var(--m-ink)',
                        fontFamily: 'var(--m-font-display)',
                        fontWeight: 800,
                        fontSize: 13,
                        background: done
                          ? 'var(--m-green, #1f9d55)'
                          : isToday
                            ? 'var(--m-accent, #FFD400)'
                            : 'transparent',
                        color: done ? '#fffaf2' : 'var(--m-ink)',
                      }}
                    >
                      {done ? '✓' : isToday ? '●' : '—'}
                    </span>
                  </div>
                )
              })}
          </div>
          <div
            style={{
              fontFamily: 'var(--m-num)',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              color: 'var(--m-ink-3)',
              marginTop: 10,
            }}
          >
            {submittedCount} of {weekLogs.length} submitted this week
          </div>
        </div>
      ) : null}
    </div>
  )
}
