import { useEffect, useState, type CSSProperties } from 'react'
import { Card, MobileButton, Pill } from '@/components/mobile'
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
  type NotificationChannel,
  type UpdateNotificationPreferencesRequest,
} from '@/lib/api'

/** Just the per-event channel keys. Excludes id / company_id / contact fields. */
type ChannelKey =
  | 'channel_assignment_change'
  | 'channel_time_review_ready'
  | 'channel_daily_log_reminder'
  | 'channel_clock_anomaly'

/**
 * Notification preferences screen — settings for the channel router
 * shipped in Phase 1C. Renders per-event-type channel selectors plus
 * the contact fields the SMS / email channels need.
 *
 * Validation matches the API: any 'sms' selection requires sms_phone;
 * any 'email' selection requires email. We surface the blocker inline
 * before the request fires so the user gets immediate feedback.
 *
 * Wired identically on mobile and desktop (single column, generous
 * padding) — settings are the same product on both per project policy.
 */

// The design (msg__91) is a PUSH / SMS / EMAIL column matrix with events
// grouped under PROJECT / MONEY / SAFETY headers. The backend stores ONE
// channel per event (push|sms|email|off), so each matrix cell behaves as an
// exclusive radio within its row: checking a channel selects it for that
// event; unchecking the active channel sets the event to `off`.
const EVENT_GROUPS: ReadonlyArray<{
  group: string
  events: ReadonlyArray<{ key: ChannelKey; label: string; detail: string; locked?: boolean }>
}> = [
  {
    group: 'Project',
    events: [
      {
        key: 'channel_assignment_change',
        label: 'New project assigned',
        detail: 'When your schedule shifts or a new assignment lands.',
      },
      {
        key: 'channel_clock_anomaly',
        label: 'Project at risk',
        detail: 'Geofence breach, overtime spike, missing clock-out.',
      },
      {
        key: 'channel_daily_log_reminder',
        label: 'Daily log submitted',
        detail: 'End-of-day prompt for foremen to submit the day’s log.',
      },
    ],
  },
  {
    group: 'Money',
    events: [
      {
        key: 'channel_time_review_ready',
        label: 'Approval request',
        detail: 'When a pay-period review is queued for your approval.',
      },
    ],
  },
]

// Matrix columns. `off` is not a column — it is the absence of any checked
// channel in a row, surfaced by the "Off" affordance below the matrix.
const MATRIX_CHANNELS: ReadonlyArray<{ value: Exclude<NotificationChannel, 'off'>; label: string }> = [
  { value: 'push', label: 'Push' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
]

const NOTIF_HEAD_STYLE: CSSProperties = {
  padding: '12px 14px',
  fontFamily: 'var(--m-num)',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
}

export function NotificationPreferencesScreen() {
  const query = useNotificationPreferences()
  const update = useUpdateNotificationPreferences()

  // Local mirror so the user can stage changes before saving.
  const [draft, setDraft] = useState<UpdateNotificationPreferencesRequest>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  // Hydrate the draft from the server response, but only on the first
  // successful load — subsequent successful saves shouldn't stomp the
  // user's in-progress edits.
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    if (hydrated || !query.data) return
    const p = query.data.preferences
    setDraft({
      channel_assignment_change: p.channel_assignment_change,
      channel_time_review_ready: p.channel_time_review_ready,
      channel_daily_log_reminder: p.channel_daily_log_reminder,
      channel_clock_anomaly: p.channel_clock_anomaly,
      sms_phone: p.sms_phone,
      email: p.email,
    })
    setHydrated(true)
  }, [query.data, hydrated])

  const usesSms = Object.values(draft).some((v) => v === 'sms') || false
  const usesEmail = Object.values(draft).some((v) => v === 'email') || false

  const validate = (): string | null => {
    if (usesSms && !(draft.sms_phone ?? '').trim()) {
      return 'Add an SMS phone number — at least one event uses SMS.'
    }
    if (usesEmail && !(draft.email ?? '').trim()) {
      return 'Add an email address — at least one event uses Email.'
    }
    return null
  }

  const onSave = async () => {
    setError(null)
    setSaved(false)
    const v = validate()
    if (v) {
      setError(v)
      return
    }
    try {
      await update.mutateAsync(draft)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2_500)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
  }

  // Toggle a matrix cell. Because the backend stores one channel per event,
  // a cell acts as an exclusive radio within its row: tapping the active
  // channel clears it (→ 'off'); tapping another channel switches to it.
  const toggleCell = (key: ChannelKey, channel: Exclude<NotificationChannel, 'off'>) => {
    setDraft((d) => {
      const current = (d[key] as NotificationChannel | undefined) ?? 'off'
      return { ...d, [key]: current === channel ? 'off' : channel }
    })
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Settings</div>
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Notifications</h1>
      <p className="text-[14px] text-ink-2 mt-2">
        Pick how each event reaches you. Clearing every channel for an event silences it entirely.
      </p>

      {!hydrated ? (
        <div className="mt-6 text-[13px] text-ink-3">Loading…</div>
      ) : (
        <div className="mt-6 space-y-3">
          {/* PUSH / SMS / EMAIL matrix, grouped by PROJECT / MONEY / SAFETY. */}
          <div style={{ border: '2px solid var(--m-line)' }}>
            {/* Column header (dark) */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.6fr repeat(3, 1fr)',
                background: 'var(--m-ink)',
                color: 'var(--m-bg)',
              }}
            >
              <div style={NOTIF_HEAD_STYLE}>Event</div>
              {MATRIX_CHANNELS.map((c) => (
                <div key={c.value} style={{ ...NOTIF_HEAD_STYLE, textAlign: 'center', color: 'var(--m-accent)' }}>
                  {c.label}
                </div>
              ))}
            </div>

            {EVENT_GROUPS.map((grp) => (
              <div key={grp.group}>
                <div
                  style={{
                    padding: '8px 14px',
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    color: 'var(--m-ink-3)',
                    background: 'var(--m-card-soft)',
                  }}
                >
                  {grp.group}
                </div>
                {grp.events.map((event) => {
                  const value = (draft[event.key] as NotificationChannel | undefined) ?? 'off'
                  return (
                    <div
                      key={event.key as string}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1.6fr repeat(3, 1fr)',
                        alignItems: 'center',
                        borderTop: '1px solid var(--m-line-2)',
                      }}
                    >
                      <div
                        style={{
                          padding: '14px',
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--m-ink)',
                          textTransform: 'uppercase',
                        }}
                      >
                        {event.label}
                      </div>
                      {MATRIX_CHANNELS.map((c) => {
                        const on = value === c.value
                        return (
                          <button
                            key={c.value}
                            type="button"
                            aria-pressed={on}
                            aria-label={`${event.label} via ${c.label}`}
                            onClick={() => toggleCell(event.key, c.value)}
                            style={{
                              display: 'flex',
                              justifyContent: 'center',
                              alignItems: 'center',
                              padding: '10px 0',
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                width: 22,
                                height: 22,
                                border: '2px solid var(--m-line)',
                                background: on ? 'var(--m-accent)' : 'transparent',
                                opacity: on ? 1 : 0.5,
                              }}
                            />
                          </button>
                        )
                      })}
                    </div>
                  )
                })}
              </div>
            ))}

            {/* SAFETY group — Stop Work is locked on across every channel. */}
            <div
              style={{
                padding: '8px 14px',
                fontFamily: 'var(--m-num)',
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--m-ink-3)',
                background: 'var(--m-card-soft)',
                borderTop: '1px solid var(--m-line-2)',
              }}
            >
              Safety
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.6fr repeat(3, 1fr)',
                alignItems: 'center',
                borderTop: '1px solid var(--m-line-2)',
              }}
            >
              <div style={{ padding: '14px' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--m-ink)', textTransform: 'uppercase' }}>
                  Stop work
                </div>
                <div
                  style={{
                    fontFamily: 'var(--m-num)',
                    fontSize: 10,
                    color: 'var(--m-red)',
                    textTransform: 'uppercase',
                  }}
                >
                  ● Locked · all on
                </div>
              </div>
              {MATRIX_CHANNELS.map((c) => (
                <div
                  key={c.value}
                  style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '10px 0' }}
                >
                  <span
                    aria-hidden="true"
                    style={{ width: 22, height: 22, border: '2px solid var(--m-line)', background: 'var(--m-accent)' }}
                  />
                </div>
              ))}
            </div>
          </div>

          <Card>
            <div className="text-[14px] font-semibold">Contacts</div>
            <div className="text-[12px] text-ink-3 mt-1 mb-3">Required when you've selected SMS or Email above.</div>
            <label className="block text-[12px] font-medium text-ink-3 mb-1">SMS phone</label>
            <input
              type="tel"
              value={draft.sms_phone ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, sms_phone: e.target.value }))}
              placeholder="+1 555 555 0123"
              className="w-full p-3 text-[14px] rounded border border-line-2 bg-card focus:outline-none focus:border-accent"
            />
            <label className="block text-[12px] font-medium text-ink-3 mb-1 mt-3">Email</label>
            <input
              type="email"
              value={draft.email ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
              placeholder="you@example.com"
              className="w-full p-3 text-[14px] rounded border border-line-2 bg-card focus:outline-none focus:border-accent"
            />
          </Card>

          {error ? <div className="px-1 text-[13px] text-bad">{error}</div> : null}
          {saved ? (
            <div className="px-1 text-[13px] text-good inline-flex items-center gap-2">
              <Pill tone="good" withDot>
                Saved
              </Pill>
            </div>
          ) : null}

          <div className="pt-2">
            <MobileButton variant="primary" onClick={onSave} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save preferences'}
            </MobileButton>
          </div>
        </div>
      )}
    </div>
  )
}
