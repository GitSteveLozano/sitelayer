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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { BootstrapResponse } from '@/lib/api'
import { useClockIn, useClockOut, type ClockInRequest, type ClockOutRequest } from './api/clock.js'

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
export function haversineDistanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
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

// ---------------------------------------------------------------------------
// Auto clock-in/out hooks (Phase 2)
// ---------------------------------------------------------------------------

export type GeofenceShape = {
  lat: number
  lng: number
  radius_m: number
}

export type GeofenceSample = {
  inside: boolean
  distance_m: number
  lat: number
  lng: number
  accuracy_m: number | null
  at: number
}

export type GeofenceWatchTransitionError = { kind: 'permission_denied' } | { kind: 'unavailable' } | { kind: 'timeout' }

export type GeofenceWatchOptions = GeofenceShape & {
  onEnter?: ((sample: GeofenceSample) => void) | undefined
  onExit?: ((sample: GeofenceSample) => void) | undefined
  onError?: ((err: GeofenceWatchTransitionError) => void) | undefined
  disabled?: boolean | undefined
  exitGraceMs?: number | undefined
  throttleMs?: number | undefined
}

export type GeofenceWatchState = {
  sample: GeofenceSample | null
  error: GeofenceWatchTransitionError | null
  ready: boolean
}

const DEFAULT_EXIT_GRACE_MS = 60_000
const DEFAULT_THROTTLE_MS = 30_000

/**
 * Subscribes to `navigator.geolocation.watchPosition` and emits enter/exit
 * callbacks based on the configured fence. Cleans up on unmount or when
 * `disabled` flips to true. Exit is debounced for `exitGraceMs` so a
 * single bad GPS sample doesn't immediately yank a worker off the clock.
 */
export function useGeofenceWatch(options: GeofenceWatchOptions): GeofenceWatchState {
  const {
    lat,
    lng,
    radius_m,
    onEnter,
    onExit,
    onError,
    disabled = false,
    exitGraceMs = DEFAULT_EXIT_GRACE_MS,
    throttleMs = DEFAULT_THROTTLE_MS,
  } = options

  const [sample, setSample] = useState<GeofenceSample | null>(null)
  const [error, setError] = useState<GeofenceWatchTransitionError | null>(null)
  const [ready, setReady] = useState(false)

  const onEnterRef = useRef(onEnter)
  const onExitRef = useRef(onExit)
  const onErrorRef = useRef(onError)
  const lastFiredAtRef = useRef(0)
  const lastInsideRef = useRef<boolean | null>(null)
  const exitTimerRef = useRef<number | null>(null)

  useEffect(() => {
    onEnterRef.current = onEnter
    onExitRef.current = onExit
    onErrorRef.current = onError
  }, [onEnter, onExit, onError])

  useEffect(() => {
    if (disabled) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      const err: GeofenceWatchTransitionError = { kind: 'unavailable' }
      setError(err)
      onErrorRef.current?.(err)
      return
    }

    const center = { lat, lng }

    const handle = (pos: GeolocationPosition) => {
      const now = Date.now()
      const dist = haversineDistanceMeters(center, { lat: pos.coords.latitude, lng: pos.coords.longitude })
      const inside = dist <= radius_m
      const next: GeofenceSample = {
        inside,
        distance_m: dist,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy_m: Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null,
        at: now,
      }
      setReady(true)
      setError(null)

      const wasInside = lastInsideRef.current
      const stateChanged = wasInside !== inside
      const throttled = lastFiredAtRef.current && now - lastFiredAtRef.current < throttleMs && !stateChanged

      lastInsideRef.current = inside
      setSample(next)

      if (throttled) return

      if (inside && wasInside !== true) {
        if (exitTimerRef.current !== null) {
          window.clearTimeout(exitTimerRef.current)
          exitTimerRef.current = null
        }
        lastFiredAtRef.current = now
        onEnterRef.current?.(next)
        return
      }

      if (!inside && wasInside === true) {
        if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = window.setTimeout(() => {
          exitTimerRef.current = null
          lastFiredAtRef.current = Date.now()
          onExitRef.current?.(next)
        }, exitGraceMs)
      }
    }

    const fail = (err: GeolocationPositionError) => {
      let kind: GeofenceWatchTransitionError['kind'] = 'unavailable'
      if (err.code === err.PERMISSION_DENIED) kind = 'permission_denied'
      else if (err.code === err.TIMEOUT) kind = 'timeout'
      const next: GeofenceWatchTransitionError = { kind }
      setError(next)
      onErrorRef.current?.(next)
    }

    const id = navigator.geolocation.watchPosition(handle, fail, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 30_000,
    })
    return () => {
      navigator.geolocation.clearWatch(id)
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }
  }, [disabled, lat, lng, radius_m, exitGraceMs, throttleMs])

  return { sample, error, ready }
}

/**
 * Picks today's primary project — the first active project on bootstrap
 * with a fence shape — and returns it plus a typed fence shape. Reads
 * from existing BootstrapResponse fields (site_lat/site_lng/site_radius_m).
 */
export function usePrimaryProjectFence(bootstrap: BootstrapResponse | null): {
  projectId: string | null
  projectName: string | null
  fence: GeofenceShape | null
} {
  return useMemo(() => {
    const projects = bootstrap?.projects ?? []
    const active = projects.find((p) => /progress|active/i.test(p.status)) ?? projects[0] ?? null
    if (!active) return { projectId: null, projectName: null, fence: null }
    const lat = active.site_lat != null ? Number(active.site_lat) : NaN
    const lng = active.site_lng != null ? Number(active.site_lng) : NaN
    const radius = active.site_radius_m ?? 100
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { projectId: active.id, projectName: active.name, fence: null }
    }
    return { projectId: active.id, projectName: active.name, fence: { lat, lng, radius_m: radius } }
  }, [bootstrap?.projects])
}

export type AutoGeofenceClockOptions = {
  enabled: boolean
  alreadyClockedIn: boolean
  fence: GeofenceShape | null
  projectId: string | null
  onAutoIn?: (() => void) | undefined
}

/**
 * High-level hook: composes useGeofenceWatch with the clock-in/out
 * mutation hooks from `lib/api/clock.ts` to drive the auto clock-in /
 * auto clock-out flow. Caller is responsible for surfacing the
 * permission_denied error from the returned state.
 */
export function useAutoGeofenceClock({
  enabled,
  alreadyClockedIn,
  fence,
  projectId,
  onAutoIn,
}: AutoGeofenceClockOptions): GeofenceWatchState {
  const navigate = useNavigate()
  const clockIn = useClockIn()
  const clockOut = useClockOut()
  const inFlightRef = useRef(false)
  const alreadyInRef = useRef(alreadyClockedIn)
  useEffect(() => {
    alreadyInRef.current = alreadyClockedIn
  }, [alreadyClockedIn])

  const onEnter = useCallback(
    async (s: GeofenceSample) => {
      if (alreadyInRef.current) return
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        const body: ClockInRequest = {
          lat: s.lat,
          lng: s.lng,
          accuracy_m: s.accuracy_m,
          source: 'auto_geofence',
          project_id: projectId,
        }
        await clockIn.mutateAsync(body)
        if (onAutoIn) onAutoIn()
        else navigate('/clockin')
      } catch {
        // Surfaced via clockIn.error / clockIn.isError.
      } finally {
        inFlightRef.current = false
      }
    },
    [projectId, clockIn, onAutoIn, navigate],
  )

  const onExit = useCallback(
    async (s: GeofenceSample) => {
      if (!alreadyInRef.current) return
      if (inFlightRef.current) return
      inFlightRef.current = true
      try {
        const body: ClockOutRequest = {
          lat: s.lat,
          lng: s.lng,
          accuracy_m: s.accuracy_m,
          source: 'auto_geofence',
        }
        await clockOut.mutateAsync(body)
      } catch {
        // Surfaced via clockOut.error.
      } finally {
        inFlightRef.current = false
      }
    },
    [clockOut],
  )

  return useGeofenceWatch({
    lat: fence?.lat ?? 0,
    lng: fence?.lng ?? 0,
    radius_m: fence?.radius_m ?? 0,
    onEnter,
    onExit,
    disabled: !enabled || !fence || !projectId,
  })
}
