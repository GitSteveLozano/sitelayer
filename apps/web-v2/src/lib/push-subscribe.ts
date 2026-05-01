// Web Push subscription helper.
//
// One function the worker-onboarding screen calls when the user accepts
// the notification prompt: it grabs the VAPID public key from the API,
// asks the browser's PushManager to subscribe, and posts the resulting
// keys to /api/push/subscriptions.
//
// Handles the Uint8Array conversion the Push API requires (the server
// returns the key as base64url; PushManager wants Uint8Array). Also
// handles the "already subscribed" idempotency: if a subscription
// exists, return it instead of churning a new one — the API's upsert
// will keep the existing row's id and bump last_seen_at.

import { fetchVapidPublicKey, subscribePush, type SubscribeResponse } from './api/push'

export class PushUnavailableError extends Error {
  readonly kind: 'unsupported' | 'denied' | 'no_service_worker' | 'no_vapid_key'
  constructor(kind: 'unsupported' | 'denied' | 'no_service_worker' | 'no_vapid_key', message: string) {
    super(message)
    this.kind = kind
    this.name = 'PushUnavailableError'
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  // Allocate via an explicit ArrayBuffer so the resulting view's backing
  // buffer satisfies PushManager.subscribe's `BufferSource` constraint
  // (tightened in TS 5.8 to reject SharedArrayBuffer-backed views).
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i)
  }
  return bytes
}

function arrayBufferToBase64(buffer: ArrayBuffer | null | undefined): string {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

/** Verify that the browser environment can actually subscribe. */
export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

/**
 * Subscribe the current device + user to Web Push notifications.
 *
 * Caller must have already prompted for + received Notification
 * permission (use `useNotificationPermission().request()` from
 * `lib/permissions.ts`). This function does NOT prompt — silent
 * permission requests are blocked by browsers.
 *
 * Idempotent: if the device already has an active subscription for
 * this VAPID key, the API's upsert returns the existing row.
 */
export async function ensurePushSubscription(): Promise<SubscribeResponse> {
  if (!isPushSupported()) {
    throw new PushUnavailableError('unsupported', 'This browser does not support Web Push.')
  }
  if (Notification.permission === 'denied') {
    throw new PushUnavailableError('denied', 'Notifications are blocked for this site.')
  }
  const reg = await navigator.serviceWorker.ready
  if (!reg) {
    throw new PushUnavailableError('no_service_worker', 'Service worker not registered yet.')
  }

  const { vapidPublicKey } = await fetchVapidPublicKey().catch((err) => {
    throw new PushUnavailableError('no_vapid_key', `Could not fetch VAPID key: ${describeError(err)}`)
  })
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey)

  // Reuse any existing subscription for this key — PushManager's
  // contract is one subscription per registration.
  let subscription = await reg.pushManager.getSubscription()
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    })
  }

  const json = subscription.toJSON()
  const p256dh = json.keys?.p256dh ?? arrayBufferToBase64(subscription.getKey('p256dh'))
  const auth = json.keys?.auth ?? arrayBufferToBase64(subscription.getKey('auth'))

  return subscribePush({
    endpoint: subscription.endpoint,
    p256dh,
    auth,
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
  })
}

/**
 * Tear down the current device's push subscription locally + tell the
 * API to remove the row. Used on sign-out / explicit "stop notifications".
 */
export async function teardownPushSubscription(subscriptionRowId: string): Promise<void> {
  if (!isPushSupported()) return
  const reg = await navigator.serviceWorker.ready
  if (!reg) return
  const subscription = await reg.pushManager.getSubscription()
  if (subscription) {
    await subscription.unsubscribe().catch(() => {})
  }
  // Best-effort delete the API row; if the user is already signed out
  // the 401 is fine.
  await import('./api/push').then((m) => m.unsubscribePush(subscriptionRowId)).catch(() => {})
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
