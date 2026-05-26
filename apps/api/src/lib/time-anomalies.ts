/**
 * Deterministic, multi-signal time anomaly detector.
 *
 * Replaces the Phase 1A "hours > 8" placeholder in
 * `apps/api/src/routes/time-review-runs.ts`. Pure + side-effect-free so it
 * can be unit tested in isolation (`time-anomalies.test.ts`) and called at
 * read time without touching the schema.
 *
 * The detector consumes only data the time-review run route already has
 * access to — `labor_entries` and `clock_events` — and emits, per labor
 * entry, a list of `{ code, message }` reasons. The run-level
 * `anomaly_count` is the number of entries that carry at least one reason
 * (NOT the number of reasons), preserving the existing column semantics
 * (one bump per flagged entry).
 *
 * Signals (all deterministic — no ML):
 *   - overlap          two of a worker's intervals (labor or clock) on the
 *                      same day overlap in time.
 *   - excessive        > ~12h in a day, likely a missed clock-out.
 *   - zero_negative    0h or negative duration, likely a missed clock-in.
 *   - missing_break    a long shift (> ~6h) with no break recorded, where
 *                      break data is derivable from the clock event chain.
 *   - clockout_before_photo  a clock-out is stamped earlier than a later
 *                      same-site clock event (e.g. a photo upload after the
 *                      punch), suggesting an early/incorrect clock-out.
 *   - geofence         an off-geofence punch (inside_geofence === false) on
 *                      the worker's day.
 *   - variance         the entry's hours sit far above the crew/role norm
 *                      for that day (median + k * stddev check).
 */

export type TimeAnomalyCode =
  | 'overlap'
  | 'excessive'
  | 'zero_negative'
  | 'missing_break'
  | 'clockout_before_photo'
  | 'geofence'
  | 'variance'

export type TimeAnomaly = {
  code: TimeAnomalyCode
  message: string
}

/** Minimal shape of a labor_entries row the detector needs. */
export type LaborEntryInput = {
  id: string
  worker_id: string | null
  project_id: string | null
  /** numeric(12,2) arrives as string from pg; we coerce. */
  hours: number | string | null
  occurred_on: string
  /** Optional grouping signal for the variance norm. */
  division_code?: string | null
  service_item_code?: string | null
}

/** Minimal shape of a clock_events row the detector needs. */
export type ClockEventInput = {
  id: string
  worker_id: string | null
  project_id: string | null
  /** 'in' | 'out' (we tolerate other values, they just don't pair). */
  event_type: string
  /** ISO timestamp. */
  occurred_at: string
  inside_geofence: boolean | null
  source?: string | null
  /** ISO timestamp of a photo attached to this punch, if any. */
  photo_uploaded_at?: string | null
  voided_at?: string | null
}

export type DetectAnomaliesResult = {
  /** Per labor-entry-id → reasons. Only entries with ≥1 reason appear. */
  byEntryId: Record<string, TimeAnomaly[]>
  /** Number of distinct entries carrying ≥1 reason. */
  anomalyCount: number
}

// Tunable thresholds. Kept as named constants so the unit test and any
// future per-company policy can reference the same values.
export const EXCESSIVE_HOURS = 12
export const LONG_SHIFT_HOURS = 6
/** A long shift is expected to carry at least this much unpaid break. */
export const MIN_BREAK_MINUTES = 20
/** Variance: flag entries this many stddevs above the day's median. */
export const VARIANCE_STDDEV_K = 2
/** Variance also requires an absolute gap so a tight crew isn't over-flagged. */
export const VARIANCE_MIN_ABS_HOURS = 4
/** Need at least this many same-cohort entries before variance is meaningful. */
export const VARIANCE_MIN_COHORT = 3

function toHours(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function fmtHours(h: number): string {
  return `${(Math.round(h * 10) / 10).toFixed(1)}h`
}

function fmtClock(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

type Interval = { start: number; end: number }

/**
 * Pair a worker's clock events for a single day into [in, out] intervals.
 * Events are append-only and pair by being the most recent open 'in'
 * followed by the next 'out' (matching the route's pair-up convention).
 * Voided events are ignored. Unmatched 'in' (still open) is dropped — the
 * excessive/zero signals on labor_entries cover the missing-clock-out case.
 */
export function pairClockIntervals(events: ClockEventInput[]): Interval[] {
  const live = events
    .filter((e) => !e.voided_at)
    .filter((e) => e.event_type === 'in' || e.event_type === 'out')
    .map((e) => ({ ...e, t: Date.parse(e.occurred_at) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t)

  const intervals: Interval[] = []
  let openIn: number | null = null
  for (const e of live) {
    if (e.event_type === 'in') {
      // A new 'in' before an 'out' replaces the open one (we keep the later).
      openIn = e.t
    } else if (e.event_type === 'out' && openIn !== null) {
      intervals.push({ start: openIn, end: e.t })
      openIn = null
    }
  }
  return intervals
}

/**
 * Detect whether a worker's punch stream has two sessions that overlap in
 * time — e.g. clocked in on job A at 8:00, clocked in on job B at 10:00
 * before the A 'out'. The strict pair-up in `pairClockIntervals` can't
 * surface this (a new 'in' just replaces the open one), so for overlap we
 * walk the stream and look for an 'in' that arrives while another session
 * is still open (no 'out' has closed it yet).
 */
export function clockOverlapAt(events: ClockEventInput[]): number | null {
  const live = events
    .filter((e) => !e.voided_at)
    .filter((e) => e.event_type === 'in' || e.event_type === 'out')
    .map((e) => ({ ...e, t: Date.parse(e.occurred_at) }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t)

  let openCount = 0
  for (const e of live) {
    if (e.event_type === 'in') {
      openCount += 1
      if (openCount >= 2) return e.t
    } else if (e.event_type === 'out') {
      if (openCount > 0) openCount -= 1
    }
  }
  return null
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length
  return Math.sqrt(variance)
}

/** YYYY-MM-DD key for a labor entry. */
function dayKey(occurredOn: string): string {
  return occurredOn.slice(0, 10)
}

/** YYYY-MM-DD key for a clock event (uses its date portion). */
function clockDayKey(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso.slice(0, 10)
  return new Date(t).toISOString().slice(0, 10)
}

/**
 * Detect anomalies across a set of labor entries and the clock events that
 * back them. Pure: returns a map keyed by labor entry id plus the count of
 * flagged entries.
 */
export function detectTimeAnomalies(
  laborEntries: LaborEntryInput[],
  clockEvents: ClockEventInput[],
): DetectAnomaliesResult {
  const byEntryId: Record<string, TimeAnomaly[]> = {}
  const push = (id: string, anomaly: TimeAnomaly) => {
    const existing = byEntryId[id]
    if (existing) existing.push(anomaly)
    else byEntryId[id] = [anomaly]
  }

  // ---- Variance cohort norms: group hours by (day, division|service) ----
  // We compute the norm over the cohort the entry belongs to so a single
  // long-but-normal trade day doesn't flag the whole crew.
  const cohortHours = new Map<string, number[]>()
  const cohortKeyFor = (e: LaborEntryInput): string =>
    `${dayKey(e.occurred_on)}::${e.division_code ?? e.service_item_code ?? 'all'}`
  for (const e of laborEntries) {
    const h = toHours(e.hours)
    const key = cohortKeyFor(e)
    const arr = cohortHours.get(key)
    if (arr) arr.push(h)
    else cohortHours.set(key, [h])
  }

  // ---- Index clock events by (worker, day) ----
  const clockByWorkerDay = new Map<string, ClockEventInput[]>()
  for (const ev of clockEvents) {
    if (!ev.worker_id) continue
    const key = `${ev.worker_id}::${clockDayKey(ev.occurred_at)}`
    const arr = clockByWorkerDay.get(key)
    if (arr) arr.push(ev)
    else clockByWorkerDay.set(key, [ev])
  }

  // ---- Track labor intervals per (worker, day) to catch labor-vs-labor and
  //      labor-vs-clock overlaps. A labor entry has no explicit start/end, so
  //      for overlap we use the worker's clock intervals on that day; two
  //      labor entries for the same worker/day are themselves an overlap
  //      signal (a worker can't be on two jobs at once).
  const laborByWorkerDay = new Map<string, LaborEntryInput[]>()
  for (const e of laborEntries) {
    if (!e.worker_id) continue
    const key = `${e.worker_id}::${dayKey(e.occurred_on)}`
    const arr = laborByWorkerDay.get(key)
    if (arr) arr.push(e)
    else laborByWorkerDay.set(key, [e])
  }

  for (const e of laborEntries) {
    const hours = toHours(e.hours)
    const workerDayKey = e.worker_id ? `${e.worker_id}::${dayKey(e.occurred_on)}` : null
    const dayClock = workerDayKey ? (clockByWorkerDay.get(workerDayKey) ?? []) : []
    const intervals = pairClockIntervals(dayClock)

    // --- zero / negative ---
    if (hours <= 0) {
      push(e.id, {
        code: 'zero_negative',
        message:
          hours < 0
            ? `Negative duration (${fmtHours(hours)}) — likely a clock-in/out pair entered out of order.`
            : `No hours recorded — likely a missed clock-in.`,
      })
    }

    // --- excessive ---
    if (hours > EXCESSIVE_HOURS) {
      push(e.id, {
        code: 'excessive',
        message: `${fmtHours(hours)} in a day — over the ${EXCESSIVE_HOURS}h cap, likely a missed clock-out.`,
      })
    }

    // --- overlap (labor-vs-labor: same worker, two jobs same day) ---
    if (workerDayKey) {
      const sameDay = laborByWorkerDay.get(workerDayKey) ?? []
      const otherProjects = sameDay.filter(
        (o) => o.id !== e.id && o.project_id && e.project_id && o.project_id !== e.project_id,
      )
      if (otherProjects.length > 0) {
        push(e.id, {
          code: 'overlap',
          message: `Worker has labor on ${otherProjects.length + 1} jobs the same day — hours may overlap.`,
        })
      }
    }

    // --- overlap (clock-vs-clock: two open sessions at once) ---
    const overlapAt = clockOverlapAt(dayClock)
    if (overlapAt !== null) {
      push(e.id, {
        code: 'overlap',
        message: `A second clock-in fired at ${fmtClock(new Date(overlapAt).toISOString())} before the prior one closed — double-counted time.`,
      })
    }

    // --- missing_break (long shift, break inferable from clock chain) ---
    // Total clocked span vs sum of paired intervals tells us the break gap.
    if (hours > LONG_SHIFT_HOURS && intervals.length > 0) {
      const earliest = Math.min(...intervals.map((iv) => iv.start))
      const latest = Math.max(...intervals.map((iv) => iv.end))
      const spanMin = (latest - earliest) / 60_000
      const workedMin = intervals.reduce((s, iv) => s + (iv.end - iv.start) / 60_000, 0)
      const breakMin = spanMin - workedMin
      if (breakMin < MIN_BREAK_MINUTES) {
        push(e.id, {
          code: 'missing_break',
          message: `${fmtHours(hours)} shift with no break recorded — confirm a meal/rest period was taken.`,
        })
      }
    }

    // --- geofence (off-site punch on this worker's day) ---
    const offGeofence = dayClock.find((ev) => ev.inside_geofence === false && !ev.voided_at)
    if (offGeofence) {
      push(e.id, {
        code: 'geofence',
        message: `An off-geofence punch was recorded at ${fmtClock(offGeofence.occurred_at)} — was the worker on site?`,
      })
    }

    // --- clockout_before_photo (a later same-site event after clock-out) ---
    if (intervals.length > 0) {
      const lastOut = Math.max(...intervals.map((iv) => iv.end))
      const laterActivity = dayClock
        .filter((ev) => !ev.voided_at)
        .map((ev) => ({
          ev,
          // A photo upload is a later same-site activity even on the punch row.
          activityT: ev.photo_uploaded_at ? Date.parse(ev.photo_uploaded_at) : Date.parse(ev.occurred_at),
        }))
        .filter((x) => Number.isFinite(x.activityT) && x.activityT > lastOut + 60_000)
        .sort((a, b) => b.activityT - a.activityT)[0]
      if (laterActivity) {
        push(e.id, {
          code: 'clockout_before_photo',
          message: `Clock-out at ${fmtClock(new Date(lastOut).toISOString())} but later same-site activity at ${fmtClock(
            new Date(laterActivity.activityT).toISOString(),
          )} — adjust the clock-out?`,
        })
      }
    }

    // --- variance (far above the crew/role norm for the day) ---
    const cohort = cohortHours.get(cohortKeyFor(e)) ?? []
    if (cohort.length >= VARIANCE_MIN_COHORT && hours > 0) {
      const med = median(cohort)
      const sd = stddev(cohort)
      const threshold = med + VARIANCE_STDDEV_K * sd
      if (sd > 0 && hours > threshold && hours - med >= VARIANCE_MIN_ABS_HOURS) {
        push(e.id, {
          code: 'variance',
          message: `${fmtHours(hours)} is well above the crew norm (${fmtHours(med)}) for this day — double-check.`,
        })
      }
    }
  }

  return { byEntryId, anomalyCount: Object.keys(byEntryId).length }
}
