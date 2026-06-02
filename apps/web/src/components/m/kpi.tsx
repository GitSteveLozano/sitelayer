import type { ReactNode } from 'react'
import type { MTone } from './list.js'
import { Kpi, KpiRow } from './kpi-unified.js'

export type MKpiProps = {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode | undefined
  meta?: ReactNode | undefined
  metaTone?: 'green' | 'red' | 'amber' | undefined
}

/**
 * KPI tile. Eyebrow (10px uppercase) + value (38px tabular) + optional unit
 * and a meta line that takes a tone. Compose multiple in <MKpiRow>.
 *
 * BACK-COMPAT ALIAS: thin wrapper over the unified <Kpi> (kpi-unified.tsx).
 * Existing imports + the `m-kpi-*` rendered output are preserved exactly; the
 * mobile metaTone vocabulary ('green' | 'red' | 'amber') is the type the
 * unified `data-tone` passthrough receives here.
 */
export function MKpi({ label, value, unit, meta, metaTone }: MKpiProps) {
  return <Kpi label={label} value={value} unit={unit} meta={meta} metaTone={metaTone} />
}

export function MKpiRow({ cols = 2, children }: { cols?: 2 | 3; children: ReactNode }) {
  return <KpiRow cols={cols}>{children}</KpiRow>
}

// Re-export tone for convenience.
export type { MTone }
