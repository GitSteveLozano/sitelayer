// Geofence hook — wraps navigator.geolocation.watchPosition to feed the
// auto clock-in / clock-out flow.
//
// Phase 1D.2 composes this with `useClockIn`/`useClockOut`:
//   - On geofence entry (any reading inside any project's radius): fire
//     POST /api/clock/in with source='auto_geofence'.
//   - On geofence exit (no reading inside any project's radius for the
//     project's auto_clock_out_grace_seconds window): fire POST
//     /api/clock/out with source='auto_geofence'.
//
// The hook is intentionally thin — it only exposes positions and a
// readiness signal. Decision logic (which project, when to fire) lives
// in the screens / a future state machine, not here. That keeps the
// hook easy to test and reuse for a future "Crew map" pin renderer
// that just wants the current position.
//
// Phase 1D notes:
//   - iOS PWA Safari runs `watchPosition` in foreground only. Real
//     background clock-in needs the planned native iOS follow-on (see
//     ADR 0002). For now the hook stops emitting when the tab is
//     backgrounded; the `wk-today` screen's "still on site?" surface
//     handles the bridge.
//   - Battery: `enableHighAccuracy: true` is needed to reliably trigger
//     small geofences (default accuracy can be off by hundreds of meters
//     in dense urban areas). Crews accept the cost.

import { useEffect, useRef, useState } from 'react'

export interface GeofencePosition {
  lat: number
  lng: number
  accuracyMeters: number
  capturedAtMs: number
}

export type GeofenceErrorKind = 'unsupported' | 'permission_denied' | 'unavailable' | 'timeout'

export interface GeofenceError {
  kind: GeofenceErrorKind
  message: string
}

export interface UseGeofenceOptions {
  /** Geolocation watchPosition options. Sensible defaults applied. */
  enableHighAccuracy?: boolean
  /** Milliseconds the cached position is acceptable for. */
  maximumAge?: number
  /** Hard timeout per reading. */
  timeoutMs?: number
  /** When false the hook unsubscribes (useful when the user is off-clock). */
  enabled?: boolean
}

export interface UseGeofenceResult {
  /** Latest position. null until the first reading lands. */
  position: GeofencePosition | null
  /** Last error from the geolocation API. Cleared by a successful reading. */
  error: GeofenceError | null
  /** True while a watch is active. */
  watching: boolean
  /** True once we know permission state. False during the prime/prompt window. */
  ready: boolean
}

const DEFAULT_OPTIONS: Required<Omit<UseGeofenceOptions, 'enabled'>> = {
  enableHighAccuracy: true,
  maximumAge: 30_000,
  timeoutMs: 15_000,
}

function classify(err: GeolocationPositionError): GeofenceErrorKind {
  if (err.code === err.PERMISSION_DENIED) return 'permission_denied'
  if (err.code === err.POSITION_UNAVAILABLE) return 'unavailable'
  if (err.code === err.TIMEOUT) return 'timeout'
  return 'unavailable'
}

/**
 * Hook over `navigator.geolocation.watchPosition`. Yields the latest
 * position, last error, and `watching` flag. Re-running with new
 * options re-subscribes; `enabled: false` cleans up the watch.
 *
 * Does NOT request permission — the caller should call `permission
 * .request()` from `lib/permissions.ts` first so the prompt is tied to
 * a user gesture (browsers block silent prompts).
 */
export function useGeofence(options: UseGeofenceOptions = {}): UseGeofenceResult {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const enabled = options.enabled ?? true

  const [position, setPosition] = useState<GeofencePosition | null>(null)
  const [error, setError] = useState<GeofenceError | null>(null)
  const [watching, setWatching] = useState(false)
  const [ready, setReady] = useState(false)

  // Keep the latest opts in a ref so re-renders don't churn the watch.
  const optsRef = useRef(opts)
  optsRef.current = opts

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setError({ kind: 'unsupported', message: 'Geolocation is not available on this device.' })
      setReady(true)
      return
    }
    if (!enabled) {
      setWatching(false)
      setReady(true)
      return
    }

    setWatching(true)
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyMeters: pos.coords.accuracy,
          capturedAtMs: pos.timestamp,
        })
        setError(null)
        setReady(true)
      },
      (err) => {
        setError({ kind: classify(err), message: err.message })
        setReady(true)
      },
      {
        enableHighAccuracy: optsRef.current.enableHighAccuracy,
        maximumAge: optsRef.current.maximumAge,
        timeout: optsRef.current.timeoutMs,
      },
    )

    return () => {
      navigator.geolocation.clearWatch(watchId)
      setWatching(false)
    }
  }, [enabled])

  return { position, error, watching, ready }
}

/** Pure helper: distance in meters between two lat/lng points using the
 * haversine formula. Mirrors `haversineDistanceMeters` in
 * @sitelayer/domain so client-side geofence checks match the server's
 * arithmetic exactly. */
export function haversineDistanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6_371_000 // earth radius in meters
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Pure helper: is `point` inside the circular geofence? */
export function isInsideGeofence(args: {
  centerLat: number
  centerLng: number
  radiusMeters: number
  point: { lat: number; lng: number }
}): boolean {
  const distance = haversineDistanceMeters({ lat: args.centerLat, lng: args.centerLng }, args.point)
  return distance <= args.radiusMeters
}
