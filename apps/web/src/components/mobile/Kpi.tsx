import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * `MKpi` from `mobile-primitives.jsx` — numeric summary tile.
 *
 * Spec from `.m-kpi` in mobile-tokens.css:
 *   - bg card, border line, radius 12 (--m-r), padding 14/14/12.
 *   - eyebrow 10/600 ink-3 uppercase tracking 0.06em.
 *   - value 24/600 -0.02em line-1 (mt-1).
 *   - unit 13 ink-3 400 ml-0.5 (rendered inside value).
 *   - meta 11 ink-3 (mt-1) — tone tints to green/red/amber.
 *
 * Numbers always render in `font-mono` with `tabular-nums`. Compose
 * pairs in a 2-up grid (3-up on wider screens) per the design.
 */
export type KpiTone = 'default' | 'green' | 'red' | 'amber'

const META_TONES: Record<KpiTone, string> = {
  default: 'text-ink-3',
  green: 'text-good',
  red: 'text-bad',
  amber: 'text-warn',
}

export interface KpiProps {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  meta?: ReactNode
  metaTone?: KpiTone
  className?: string
}

export function Kpi({ label, value, unit, meta, metaTone = 'default', className }: KpiProps) {
  return (
    <div className={cn('bg-card border border-line rounded-[12px] px-3.5 pt-3.5 pb-3 flex-1 min-w-0', className)}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-ink-3">{label}</div>
      <div className="font-mono tabular-nums text-[24px] font-semibold tracking-[-0.02em] leading-none mt-1">
        {value}
        {unit ? <span className="text-[13px] text-ink-3 font-normal ml-0.5">{unit}</span> : null}
      </div>
      {meta ? <div className={cn('text-[11px] mt-1', META_TONES[metaTone])}>{meta}</div> : null}
    </div>
  )
}
