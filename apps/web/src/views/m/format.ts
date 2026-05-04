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

export function formatStatusLabel(status: string): string {
  return status
    .replace(/[_-]+/g, ' ')
    .toUpperCase()
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
  return new Date().toISOString().slice(0, 10)
}

export function shortDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function timeOfDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return iso
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
