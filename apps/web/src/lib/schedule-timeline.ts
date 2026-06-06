/**
 * Pure helpers for the owner 4-week drag timeline (OwnerSchedule ·
 * FourWeekTimeline). Kept side-effect-free so the snap/clamp/date math can be
 * unit-tested in isolation — the React component is a thin pointer-handler
 * shell over these functions (headless-first; see docs/DETERMINISTIC_WORKFLOWS.md).
 *
 * The timeline is a 20-working-day grid (4 weeks × Mon–Fri). A drag shifts a
 * whole assignment block by a WHOLE number of working days; on drop each
 * underlying crew_schedules row is PATCHed to its shifted YYYY-MM-DD via
 * useRescheduleCrewSchedule. Weekends are skipped — offset N maps to
 * `floor(N/5)` weeks plus `N%5` weekdays from the anchor Monday.
 */

/** 4 weeks × 5 working days. */
export const TIMELINE_DAYS = 20

/** One scheduled working-day within a block: its grid offset + the schedule row ids on that day. */
export interface TimelineDay {
  /** 0..19 working-day offset from the anchor Monday. */
  offset: number
  /** crew_schedules row ids scheduled on this day (≥1). */
  ids: string[]
}

/** A positioned bar on the 20-working-day timeline. */
export interface TimelineBlock {
  /** 0..19 — working-day offset of the block's first day. */
  start: number
  /** working-day width (≥1). */
  span: number
  label: string
  /** Underlying scheduled days, sorted by offset; carries the row ids to PATCH on drop. */
  days: TimelineDay[]
}

/**
 * ISO YYYY-MM-DD for a working-day `offset` from `anchorMonday`. Offset 0 = the
 * anchor Monday; offsets skip weekends (5 working days per calendar week).
 * Uses local-time date parts to match how the rest of the screen renders dates.
 */
export function offsetToIsoDate(anchorMonday: Date, offset: number): string {
  const week = Math.floor(offset / 5)
  const dow = ((offset % 5) + 5) % 5 // guard negatives
  const calDay = week * 7 + dow
  const d = new Date(anchorMonday)
  d.setDate(d.getDate() + calDay)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Snap a horizontal pixel delta to a whole-working-day shift. The track is
 * `trackWidthPx` wide and spans `TIMELINE_DAYS` columns, so one column is
 * `trackWidthPx / TIMELINE_DAYS` px. Returns 0 for a non-positive track width.
 */
export function pxToDayShift(deltaPx: number, trackWidthPx: number): number {
  if (!(trackWidthPx > 0)) return 0
  const colPx = trackWidthPx / TIMELINE_DAYS
  return Math.round(deltaPx / colPx)
}

/**
 * Clamp a proposed `shift` (in working days) so the whole block stays within
 * the [0, TIMELINE_DAYS) grid. Returns the largest-magnitude shift that keeps
 * `start` ≥ 0 and `start + span` ≤ TIMELINE_DAYS.
 */
export function clampShift(start: number, span: number, shift: number): number {
  const minShift = -start
  const maxShift = TIMELINE_DAYS - span - start
  if (shift < minShift) return minShift
  if (shift > maxShift) return maxShift
  return shift
}

/** One row's reschedule instruction produced by a drop. */
export interface RescheduleOp {
  id: string
  scheduled_for: string
}

/**
 * Compute the per-row reschedule operations for dropping `block` after a
 * `shift`-working-day move. Each underlying schedule day moves to its shifted
 * offset's ISO date. A zero (or clamp-to-zero) shift yields no ops.
 */
export function computeRescheduleOps(block: TimelineBlock, shift: number, anchorMonday: Date): RescheduleOp[] {
  const clamped = clampShift(block.start, block.span, shift)
  if (clamped === 0) return []
  const ops: RescheduleOp[] = []
  for (const day of block.days) {
    const targetIso = offsetToIsoDate(anchorMonday, day.offset + clamped)
    for (const id of day.ids) {
      ops.push({ id, scheduled_for: targetIso })
    }
  }
  return ops
}
