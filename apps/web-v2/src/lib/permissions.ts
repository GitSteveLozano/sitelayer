import { useEffect, useState } from 'react'

/**
 * Permission scaffolding for the field-trustable shell.
 *
 * Phase 0 ships read-only state hooks plus a request helper for each
 * permission Phase 1 will need:
 *   - geolocation  → geofenced auto clock-in
 *   - notifications + push → assignment alerts, foreman pings
 *
 * No actual subscriptions, no actual position polling, no payload
 * handling. That all lands in Phase 1, which can compose on top of
 * these primitives.
 */
export type PermissionState = 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported'

async function queryPermission(name: PermissionName): Promise<PermissionState> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown'
  try {
    const status = await navigator.permissions.query({ name })
    return status.state as PermissionState
  } catch {
    return 'unsupported'
  }
}

export function useGeolocationPermission(): {
  state: PermissionState
  request: () => Promise<PermissionState>
} {
  const [state, setState] = useState<PermissionState>('unknown')

  useEffect(() => {
    let cancelled = false
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setState('unsupported')
      return
    }
    void queryPermission('geolocation' as PermissionName).then((s) => {
      if (!cancelled) setState(s)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const request = async (): Promise<PermissionState> => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setState('unsupported')
      return 'unsupported'
    }
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        () => {
          setState('granted')
          resolve('granted')
        },
        (err) => {
          const next: PermissionState = err.code === err.PERMISSION_DENIED ? 'denied' : 'prompt'
          setState(next)
          resolve(next)
        },
        { timeout: 8000, maximumAge: 60_000 },
      )
    })
  }

  return { state, request }
}

export function useNotificationPermission(): {
  state: PermissionState
  request: () => Promise<PermissionState>
} {
  const [state, setState] = useState<PermissionState>('unknown')

  useEffect(() => {
    if (typeof Notification === 'undefined') {
      setState('unsupported')
      return
    }
    setState(notificationStateFor(Notification.permission))
  }, [])

  const request = async (): Promise<PermissionState> => {
    if (typeof Notification === 'undefined') {
      setState('unsupported')
      return 'unsupported'
    }
    const result = await Notification.requestPermission()
    const next = notificationStateFor(result)
    setState(next)
    return next
  }

  return { state, request }
}

function notificationStateFor(p: NotificationPermission): PermissionState {
  if (p === 'granted') return 'granted'
  if (p === 'denied') return 'denied'
  return 'prompt'
}
