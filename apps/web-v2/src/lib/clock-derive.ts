// Derive client-side rollups from /api/clock/timeline.
//
// The API doesn't expose hours-this-day or hours-this-week aggregates
// — it returns the raw event stream and the client (or worker) folds
// it. Keeping these helpers pure + lightweight so the wk-today / wk-hours
// / wk-week screens share one definition.

import type { ClockEvent } from './api'

/** A paired in/out span. `out_at === null` when the in is still open. */
export interface ClockSpan {
  in_at: string
  out_at: string | null
  project_id: string | null
  /** Joined from the timeline endpoint when present. */
  project_name?: string | null
  /** Hours; computed as (now ?? out_at) − in_at. */
  hours: number
}

const MS_PER_HOUR = 60 * 60 * 1000

function asMs(iso: string): number {
  return Date.parse(iso)
}

/**
 * Pair an event stream into clock spans. The API returns events in
 * chronological order (occurred_at asc); we walk forward and emit a
 * span on each `out` (closing the most recent unmatched `in`). A
 * dangling `in` produces an open span (out_at=null).
 *
 * Auto-out events ('auto_out_geo' / 'auto_out_idle') close spans the
 * same way 'out' does — they're functionally equivalent.
 */
export function pairClockSpans(events: ClockEvent[], nowMs: number = Date.now()): ClockSpan[] {
  const spans: ClockSpan[] = []
  let openIn: ClockEvent | null = null
  for (const event of events) {
    if (event.event_type === 'in') {
      // If the previous in was never closed, treat the new in as
      // implicitly closing it at its own occurred_at — this matches the
      // API's pair-up rule (latest open in closes when a new event
      // lands).
      if (openIn) {
        const inMs = asMs(openIn.occurred_at)
        const outMs = asMs(event.occurred_at)
        spans.push({
          in_at: openIn.occurred_at,
          out_at: event.occurred_at,
          project_id: openIn.project_id,
          project_name: openIn.project_name ?? null,
          hours: Math.max(0, (outMs - inMs) / MS_PER_HOUR),
        })
      }
      openIn = event
      continue
    }
    if (openIn) {
      const inMs = asMs(openIn.occurred_at)
      const outMs = asMs(event.occurred_at)
      spans.push({
        in_at: openIn.occurred_at,
        out_at: event.occurred_at,
        project_id: openIn.project_id,
        project_name: openIn.project_name ?? null,
        hours: Math.max(0, (outMs - inMs) / MS_PER_HOUR),
      })
      openIn = null
    }
    // Out without a matching in is dropped — shouldn't happen in
    // well-formed data, but we don't want to surface confusing rows.
  }
  if (openIn) {
    const inMs = asMs(openIn.occurred_at)
    spans.push({
      in_at: openIn.occurred_at,
      out_at: null,
      project_id: openIn.project_id,
      project_name: openIn.project_name ?? null,
      hours: Math.max(0, (nowMs - inMs) / MS_PER_HOUR),
    })
  }
  return spans
}

/** Return the most recent open span (in with no matching out) or null. */
export function findOpenSpan(spans: ClockSpan[]): ClockSpan | null {
  return spans.find((s) => s.out_at === null) ?? null
}

/** Sum hours for spans whose in_at falls within [startMs, endMs). */
export function sumHoursInRange(spans: ClockSpan[], startMs: number, endMs: number, nowMs: number = Date.now()): number {
  return spans.reduce((sum, span) => {
    const inMs = asMs(span.in_at)
    const outMs = span.out_at ? asMs(span.out_at) : nowMs
    if (outMs <= startMs || inMs >= endMs) return sum
    const overlapStart = Math.max(inMs, startMs)
    const overlapEnd = Math.min(outMs, endMs)
    return sum + Math.max(0, (overlapEnd - overlapStart) / MS_PER_HOUR)
  }, 0)
}

/** Format a duration in hours as `H:MM:SS` for the running clock display. */
export function formatHms(hours: number): string {
  const totalSec = Math.max(0, Math.floor(hours * 3600))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
}

/** Format a duration in hours as e.g. "8.0h". */
export function formatDecimalHours(hours: number): string {
  return `${hours.toFixed(1)}h`
}

/** Beginning-of-day in local TZ. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Beginning-of-week (Mon 00:00:00) in local TZ. */
export function startOfWeek(ms: number): number {
  const d = new Date(ms)
  const day = (d.getDay() + 6) % 7 // Mon=0 .. Sun=6
  d.setDate(d.getDate() - day)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
