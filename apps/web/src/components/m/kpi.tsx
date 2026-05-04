import type { ReactNode } from 'react'
import type { MTone } from './list.js'

export type MKpiProps = {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  meta?: ReactNode
  metaTone?: 'green' | 'red' | 'amber'
}

/**
 * KPI tile. Eyebrow (10px uppercase) + value (24px tabular) + optional unit
 * and a meta line that takes a tone. Compose multiple in <MKpiRow>.
 */
export function MKpi({ label, value, unit, meta, metaTone }: MKpiProps) {
  return (
    <div className="m-kpi">
      <div className="m-kpi-eyebrow">{label}</div>
      <div className="m-kpi-val num">
        {value}
        {unit ? <span className="m-kpi-unit"> {unit}</span> : null}
      </div>
      {meta ? (
        <div className="m-kpi-meta" data-tone={metaTone}>
          {meta}
        </div>
      ) : null}
    </div>
  )
}

export function MKpiRow({
  cols = 2,
  children,
}: {
  cols?: 2 | 3
  children: ReactNode
}) {
  return <div className={`m-kpi-row${cols === 3 ? ' m-kpi-row-3' : ''}`}>{children}</div>
}

// Re-export tone for convenience.
export type { MTone }
