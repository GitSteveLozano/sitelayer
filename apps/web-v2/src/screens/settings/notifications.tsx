import { useEffect, useState } from 'react'
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

const EVENT_TYPES: ReadonlyArray<{
  key: ChannelKey
  label: string
  detail: string
}> = [
  {
    key: 'channel_assignment_change',
    label: 'Assignment changes',
    detail: 'When your schedule shifts or a new assignment lands.',
  },
  {
    key: 'channel_time_review_ready',
    label: 'Time review ready',
    detail: 'When a pay-period review is queued for your approval.',
  },
  {
    key: 'channel_daily_log_reminder',
    label: 'Daily log reminder',
    detail: 'End-of-day prompt for foremen to submit the day’s log.',
  },
  {
    key: 'channel_clock_anomaly',
    label: 'Clock anomalies',
    detail: 'Geofence breach, overtime spike, missing clock-out.',
  },
]

const CHANNELS: ReadonlyArray<{ value: NotificationChannel; label: string }> = [
  { value: 'push', label: 'Push' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
  { value: 'off', label: 'Off' },
]

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

  const setChannel = (key: ChannelKey, value: NotificationChannel) => {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  return (
    <div className="px-5 pt-6 pb-12 max-w-2xl">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">Settings</div>
      <h1 className="mt-1 font-display text-[28px] font-bold tracking-tight leading-tight">Notifications</h1>
      <p className="text-[14px] text-ink-2 mt-2">
        Pick how each event reaches you. Setting a channel to <strong>Off</strong> silences that event entirely.
      </p>

      {!hydrated ? (
        <div className="mt-6 text-[13px] text-ink-3">Loading…</div>
      ) : (
        <div className="mt-6 space-y-3">
          {EVENT_TYPES.map((event) => {
            const value = (draft[event.key] as NotificationChannel | undefined) ?? 'push'
            return (
              <Card key={event.key as string}>
                <div className="text-[14px] font-semibold">{event.label}</div>
                <div className="text-[12px] text-ink-3 mt-1 mb-3">{event.detail}</div>
                <div className="flex flex-wrap gap-2">
                  {CHANNELS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => setChannel(event.key, c.value)}
                      className={`px-3.5 py-1.5 rounded-full text-[13px] font-medium border transition-colors ${
                        value === c.value
                          ? 'bg-accent text-white border-transparent'
                          : 'bg-card-soft text-ink-2 border-line'
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </Card>
            )
          })}

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
