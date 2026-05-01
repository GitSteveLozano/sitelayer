import { useEffect, useState } from 'react'
import { Card, MobileButton, Pill } from '@/components/mobile'
import { ensurePushSubscription, isPushSupported, PushUnavailableError } from '@/lib/push-subscribe'
import { useNotificationPermission } from '@/lib/permissions'

/**
 * Push subscription onboarding card.
 *
 * One-tap entry into the Web Push permission prompt + server registration:
 *   1. User clicks Enable.
 *   2. We request Notification permission (browsers require a user gesture).
 *   3. On grant, we call ensurePushSubscription() which fetches the VAPID
 *      key, subscribes via PushManager, and POSTs the keys to
 *      /api/push/subscriptions.
 *
 * Failure modes are surfaced specifically:
 *   - Browser doesn't support push → "this device can't receive push"
 *   - Permission denied → "enable in OS settings"
 *   - VAPID key missing → "push not configured for this workspace"
 *   - Service worker not ready → quietly waits / retries
 *
 * After success the card flips to a "subscribed" pill. Removal isn't
 * exposed here yet — comes with the device-list view in Phase 2.
 */
export function PushOnboardingCard() {
  const { state: permState, request: requestNotification } = useNotificationPermission()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [subscribed, setSubscribed] = useState(false)

  // If the user already granted permission and a subscription exists in
  // PushManager, surface the subscribed state on mount so we don't
  // re-prompt unnecessarily.
  useEffect(() => {
    if (permState !== 'granted' || !isPushSupported()) return
    let cancelled = false
    void navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((existing) => {
        if (!cancelled && existing) setSubscribed(true)
      })
      .catch(() => {
        // Best-effort; the user can still tap Enable to refresh.
      })
    return () => {
      cancelled = true
    }
  }, [permState])

  const onEnable = async () => {
    setError(null)
    setWorking(true)
    try {
      const granted = await requestNotification()
      if (granted !== 'granted') {
        setError(
          granted === 'denied'
            ? 'Notifications are blocked. Enable them in your OS settings, then try again.'
            : 'Notification permission was not granted.',
        )
        return
      }
      await ensurePushSubscription()
      setSubscribed(true)
    } catch (err) {
      if (err instanceof PushUnavailableError) {
        if (err.kind === 'unsupported') setError('This device does not support push notifications.')
        else if (err.kind === 'denied') setError('Notifications are blocked at the OS level.')
        else if (err.kind === 'no_vapid_key') setError('Push isn’t configured for this workspace yet.')
        else if (err.kind === 'no_service_worker') setError('Service worker not ready — refresh and try again.')
        else setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Could not subscribe to push.')
      }
    } finally {
      setWorking(false)
    }
  }

  // Render branches per platform / permission state.
  if (!isPushSupported()) {
    return (
      <Card>
        <div className="text-[14px] font-semibold">Push notifications</div>
        <div className="text-[12px] text-ink-3 mt-1">
          This browser doesn't support push. Switch to the installed PWA or use SMS / Email.
        </div>
      </Card>
    )
  }

  if (subscribed) {
    return (
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[14px] font-semibold">Push notifications</div>
            <div className="text-[12px] text-ink-3 mt-0.5">
              This device is registered. Notifications will arrive even when the app is closed.
            </div>
          </div>
          <Pill tone="good" withDot>
            On
          </Pill>
        </div>
      </Card>
    )
  }

  return (
    <Card>
      <div className="text-[14px] font-semibold">Push notifications</div>
      <div className="text-[12px] text-ink-3 mt-1 mb-3">
        Get instant pings for assignments, time-review approvals, and clock anomalies.
      </div>
      {error ? <div className="text-[12px] text-bad mb-2">{error}</div> : null}
      <MobileButton
        variant="primary"
        size="sm"
        onClick={onEnable}
        disabled={working || permState === 'denied'}
      >
        {working ? 'Working…' : permState === 'denied' ? 'Permission blocked' : 'Enable push'}
      </MobileButton>
    </Card>
  )
}
