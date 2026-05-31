/**
 * Mobile formatting helpers. Per the design system:
 *   - Running / live durations use the colon form (4:24 = 4h 24m)
 *   - Settled durations use decimal+h (8.2h)
 *   - Money always shows currency symbol; large numbers use tabular-nums
 *   - Status labels are uppercased for the mini state pills on cards
 */

export function formatDecimalHours(n: number, places = 1): string {
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(places)}h`
}

/**
 * "4:24" running clock form. Use for in-progress entries; settled entries
 * should use formatDecimalHours.
 */
export function formatRunningHours(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}:${m.toString().padStart(2, '0')}`
}

export function formatMoney(n: number | string): string {
  const v = typeof n === 'string' ? Number(n) : n
  if (!Number.isFinite(v)) return '$—'
  if (Math.abs(v) >= 1000) {
    return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }
  return `$${v.toFixed(2)}`
}

/**
 * Compact magnitude form for brutalist KPI tiles: returns the dollar value and
 * a separate unit glyph (`K`/`M`) so callers can render the unit as a small
 * subscript (e.g. the design's `+$84` with a smaller `K`). Sub-1000 amounts
 * have no suffix. The sign is kept on the value so `+`/`-` framing is the
 * caller's choice.
 */
export function formatMoneyCompact(n: number | string): { value: string; unit: string } {
  const v = typeof n === 'string' ? Number(n) : n
  if (!Number.isFinite(v)) return { value: '$—', unit: '' }
  const abs = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (abs >= 1_000_000) {
    return { value: `${sign}$${round1(abs / 1_000_000)}`, unit: 'M' }
  }
  if (abs >= 1_000) {
    return { value: `${sign}$${Math.round(abs / 1_000)}`, unit: 'K' }
  }
  return { value: `${sign}$${Math.round(abs)}`, unit: '' }
}

function round1(n: number): string {
  // Trim a trailing ".0" so $1.0M renders as $1M.
  return Number(n.toFixed(1)).toString()
}

export function formatStatusLabel(status: string): string {
  return status.replace(/[_-]+/g, ' ').toUpperCase()
}

export function statusTone(status: string): 'green' | 'amber' | 'blue' | 'red' | undefined {
  const s = status.toLowerCase()
  if (s.includes('progress') || s.includes('active')) return 'green'
  if (s.includes('await') || s.includes('sent') || s.includes('estim')) return 'blue'
  if (s.includes('close') || s.includes('done') || s.includes('archive')) return undefined
  if (s.includes('declin') || s.includes('void')) return 'red'
  return 'amber'
}

export function todayIso(): string {
  // Local-date YYYY-MM-DD. `Date.toISOString()` returns UTC and crosses
  // midnight before the user's clock does, which flips "today" to
  // tomorrow on the West Coast every evening. Stick to local components.
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Local-date YYYY-MM-DD for the Monday that starts the week containing
 * `iso` (defaults to today). The review week the design header shows
 * ("WEEK · APR 27 → MAY 3") is Monday-anchored. Pure: no IO, deterministic
 * for a given input date string.
 */
export function startOfWeek(iso: string = todayIso()): string {
  const d = parseLocalish(iso)
  // getDay(): 0=Sun..6=Sat. Shift so Monday is the first day of the week.
  const dow = d.getDay()
  const deltaToMonday = dow === 0 ? -6 : 1 - dow
  d.setDate(d.getDate() + deltaToMonday)
  return localIso(d)
}

/** Local-date YYYY-MM-DD for the Sunday that ends the week (startOfWeek + 6d). */
export function endOfWeek(iso: string = todayIso()): string {
  const start = parseLocalish(startOfWeek(iso))
  start.setDate(start.getDate() + 6)
  return localIso(start)
}

function localIso(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Date-only ISO strings (`YYYY-MM-DD`) parse as UTC midnight, which is
// the previous evening in any negative-offset zone. Wrap parsing so a
// bare date string lands on the local calendar day the user wrote.
function parseLocalish(iso: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
    return new Date(y, m - 1, d)
  }
  return new Date(iso)
}

export function shortDate(iso: string): string {
  const d = parseLocalish(iso)
  if (Number.isNaN(d.valueOf())) return iso
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
