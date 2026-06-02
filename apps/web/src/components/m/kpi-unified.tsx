import type { ReactNode } from 'react'

/**
 * Unified KPI primitive (Phase A of the responsive consolidation, additive).
 *
 * This is the SINGLE source for the KPI tile that previously existed twice:
 *   - mobile  `MKpi`/`MKpiRow` (m-kpi-* classes, value 38px, 1fr 1fr grid row)
 *   - desktop `DKpi`/`DKpiStrip` (d-kpi-* classes, value 40px, auto-flow column
 *     strip, plus a `tone="accent"` full-yellow variant)
 *
 * The only real deltas between the two were the value size (38px ↔ 40px), the
 * row container (`m-kpi-row` 2-col grid ↔ `d-kpi-strip` auto-flow column with
 * connected ink borders), and the desktop `data-tone="accent"` fill. Those are
 * expressed here behind a single `dense` prop: `dense` (desktop) emits the
 * `d-kpi-*` class family, the default (mobile) emits the `m-kpi-*` family. The
 * class families are the existing source-of-truth CSS in styles/m.css and
 * styles/d.css, so the rendered output is byte-for-byte identical to the two
 * legacy components — making `MKpi`/`MKpiRow` (kpi.tsx) and `DKpi`/`DKpiStrip`
 * (components/d/index.tsx) thin back-compat aliases over this one component.
 *
 * The responsive direction (one tile that reflows 38px→40px at `lg:`) is the
 * eventual target once screens stop being platform-forked; until then a screen
 * picks its surface via `dense` and the legacy aliases keep every existing
 * import + visual unchanged.
 *
 * `metaTone` is intentionally a free string passed straight through to the
 * `data-tone` attribute so each surface keeps its own tone vocabulary
 * (mobile: green | red | amber — desktop: good | bad) with zero remapping and
 * therefore zero visual drift.
 */
export type KpiProps = {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode | undefined
  meta?: ReactNode | undefined
  /**
   * Meta-line tone. Passed straight through to `data-tone` on the meta line so
   * each surface keeps its own vocabulary: mobile uses 'green' | 'red' |
   * 'amber'; desktop (dense) uses 'good' | 'bad'.
   */
  metaTone?: string | undefined
  /**
   * Desktop (command-center) styling: emits the `d-kpi` class family — larger
   * value, connected strip, accent variant. Default (false) emits the
   * mobile-first `m-kpi` family.
   */
  dense?: boolean | undefined
  /** Desktop-only full-yellow fill (maps to `data-tone="accent"`). Ignored when not dense. */
  tone?: 'accent' | undefined
}

export function Kpi({ label, value, unit, meta, metaTone, dense = false, tone }: KpiProps) {
  if (dense) {
    return (
      <div className="d-kpi" data-tone={tone}>
        <div className="d-kpi-l">{label}</div>
        <div className="d-kpi-v num">
          {value}
          {unit ? <span className="d-kpi-unit">{unit}</span> : null}
        </div>
        {meta ? (
          <div className="d-kpi-meta" data-tone={metaTone}>
            {meta}
          </div>
        ) : null}
      </div>
    )
  }
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

/**
 * KPI container. `dense` (desktop) emits the connected `d-kpi-strip` (auto-flow
 * column with internal ink borders); the default (mobile) emits the
 * `m-kpi-row` 2-/3-column grid.
 */
export function KpiRow({
  dense = false,
  cols = 2,
  children,
}: {
  dense?: boolean | undefined
  cols?: 2 | 3
  children: ReactNode
}) {
  if (dense) {
    return <div className="d-kpi-strip">{children}</div>
  }
  return <div className={`m-kpi-row${cols === 3 ? ' m-kpi-row-3' : ''}`}>{children}</div>
}
